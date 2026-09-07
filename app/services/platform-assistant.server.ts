/**
 * Platform Assistant
 *
 * AI Assistant for the grading platform using Vercel AI SDK v6 ToolLoopAgent.
 * Supports Teacher and Student roles with context-specific prompts and tools.
 * Handles database queries and report generation for comprehensive learning analytics.
 */

import { ToolLoopAgent, stepCountIs, type ToolSet, generateText, generateObject, type LanguageModel, convertToModelMessages } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { tool } from 'ai';
import logger from '@/utils/logger';
import { checkAIAccess, AIAccessDeniedError } from '@/services/ai-access.server';
import { redis } from '@/lib/redis';
import { db } from '@/lib/db.server';

interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  [key: string]: any;
}

export type AssistantProgressPhase =
  | 'step_started'
  | 'step_completed'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'agent_completed'
  | 'agent_error';

export interface AssistantProgressEvent {
  sessionId: string;
  userId: string;
  userRole: 'TEACHER' | 'STUDENT';
  phase: AssistantProgressPhase;
  title: string;
  stepNumber?: number;
  toolName?: string;
  thinking?: string;
  action?: string;
  expectedOutcome?: string;
  inputSummary?: string;
  outputSummary?: string;
  durationMs?: number;
  ts: number;
}

export type AssistantUiLanguage = 'zh' | 'en';

type ProgressReporter = (event: Omit<AssistantProgressEvent, 'sessionId' | 'userId' | 'userRole' | 'ts'>) => void;

interface ProgressLocaleText {
  isEnglish: boolean;
  noData: string;
  noParams: string;
  languageReminder: string;
  agentCompletedTitle: string;
  agentCompletedSummary: (textLength: number, totalTokens: number) => string;
  agentFailedTitle: string;
  agentInitFailedTitle: string;
}

function getProgressLocaleText(language: AssistantUiLanguage): ProgressLocaleText {
  if (language === 'en') {
    return {
      isEnglish: true,
      noData: 'No data',
      noParams: 'No params',
      languageReminder: 'IMPORTANT: You must output strictly in English. Do not use Chinese.',
      agentCompletedTitle: 'Assistant completed this response',
      agentCompletedSummary: () => 'Response is ready.',
      agentFailedTitle: 'Assistant execution failed',
      agentInitFailedTitle: 'Assistant initialization failed',
    };
  }

  return {
    isEnglish: false,
    noData: '無資料',
    noParams: '無參數',
    languageReminder: 'IMPORTANT: You must output strictly in Traditional Chinese (繁體中文). Do not use Simplified Chinese.',
    agentCompletedTitle: '助手已完成本次回覆',
    agentCompletedSummary: () => '回覆已完成。',
    agentFailedTitle: '助手執行失敗',
    agentInitFailedTitle: '助手初始化失敗',
  };
}

function toCompactJson(value: unknown, maxLength: number = 220): string {
  try {
    const raw = JSON.stringify(value);
    if (raw.length <= maxLength) {
      return raw;
    }
    return `${raw.slice(0, maxLength)}...`;
  } catch {
    return String(value);
  }
}

function summarizeUnknownData(data: unknown, localeText: ProgressLocaleText): string {
  if (data === null || data === undefined) {
    return localeText.noData;
  }

  if (Array.isArray(data)) {
    return localeText.isEnglish ? `Array result with ${data.length} items` : `回傳陣列，共 ${data.length} 筆`;
  }

  if (typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const keys = Object.keys(record);
    const countHints = keys
      .filter((key) => Array.isArray(record[key]))
      .map((key) => `${key}:${(record[key] as unknown[]).length}`);

    if (countHints.length > 0) {
      return localeText.isEnglish
        ? `Object result (${keys.slice(0, 5).join(', ')}), key counts: ${countHints.slice(0, 3).join(' / ')}`
        : `回傳物件(${keys.slice(0, 5).join(', ')})，重點數量 ${countHints.slice(0, 3).join(' / ')}`;
    }

    return localeText.isEnglish
      ? `Object fields: ${keys.slice(0, 6).join(', ') || 'none'}`
      : `回傳物件欄位：${keys.slice(0, 6).join(', ') || '無'}`;
  }

  return String(data);
}

function summarizeParams(params: Record<string, unknown> | undefined, localeText: ProgressLocaleText): string {
  if (!params || Object.keys(params).length === 0) {
    return localeText.noParams;
  }
  return toCompactJson(params, 180);
}

function stripProcessLeakage(text: string): string {
  if (!text) return text;

  const leakagePattern = /(think\s*tool|think\s*\(|think\s*參數|內部\s*prompt|internal\s*prompt|流程規則|process rules)/i;
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !leakagePattern.test(line));

  return lines.join('\n').trim();
}

function getQueryDisplayName(queryType: string, isEnglish: boolean): string {
  const names: Record<string, { en: string; zh: string }> = {
    pending_assignments: { en: 'pending assignments', zh: '待完成作業' },
    student_assignments: { en: 'assignment list', zh: '作業清單' },
    student_courses: { en: 'enrolled courses', zh: '已修課程' },
    student_submissions: { en: 'submission history', zh: '繳交紀錄' },
    submission_detail: { en: 'submission detail', zh: '提交詳情' },
    my_submission_detail: { en: 'submission details', zh: '提交詳情' },
    assignment_detail_student: { en: 'assignment details', zh: '作業詳情' },
    teacher_courses: { en: 'teaching courses', zh: '授課課程' },
    course_students: { en: 'course roster', zh: '課程學生名單' },
    course_assignments: { en: 'course assignments', zh: '課程作業' },
    assignment_submissions: { en: 'assignment submissions', zh: '作業繳交狀態' },
    student_submission_detail_teacher: { en: 'student submission details', zh: '學生提交詳情' },
    grading_statistics: { en: 'grading statistics', zh: '評分統計' },
  };

  const preset = names[queryType];
  if (preset) {
    return isEnglish ? preset.en : preset.zh;
  }

  const fallback = queryType.replace(/_/g, ' ');
  return isEnglish ? fallback : fallback;
}

function createProgressReporter(
  sessionId: string,
  userId: string,
  userRole: 'TEACHER' | 'STUDENT'
): ProgressReporter {
  return (event) => {
    const payload: AssistantProgressEvent = {
      ...event,
      sessionId,
      userId,
      userRole,
      ts: Date.now(),
    };

    void db.agentChatStepLog
      .create({
        data: {
          sessionId,
          stepNumber: payload.stepNumber ?? -1,
          toolName: payload.toolName,
          toolInput: {
            phase: payload.phase,
            title: payload.title,
            action: payload.action,
            expectedOutcome: payload.expectedOutcome,
            inputSummary: payload.inputSummary,
          },
          toolOutput: {
            phase: payload.phase,
            title: payload.title,
            outputSummary: payload.outputSummary,
            durationMs: payload.durationMs,
            ts: payload.ts,
          },
          reasoning: payload.thinking,
          durationMs: payload.durationMs,
          timestamp: new Date(payload.ts),
        },
      })
      .catch((error) => {
        logger.warn(
          {
            sessionId,
            phase: event.phase,
            error: error instanceof Error ? error.message : String(error),
          },
          '[Platform Assistant] Failed to persist assistant progress event'
        );
      });

    void redis.publish('assistant:progress', JSON.stringify(payload)).catch((error) => {
      logger.warn(
        {
          sessionId,
          phase: event.phase,
          error: error instanceof Error ? error.message : String(error),
        },
        '[Platform Assistant] Failed to publish assistant progress event'
      );
    });
  };
}
import {
  executeDatabaseQuery,
  type QueryType,
  type TeacherQueryType,
  type StudentQueryType,
  type StudentCoursesData,
  type StudentSubmissionsData,
} from '@/services/database-query.server';
import { uploadToStorage } from '@/services/storage.server';
import puppeteer from 'puppeteer';
import type { ChartConfiguration } from 'chart.js';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

// Gemini provider 延遲到第一次使用才建立：這個模組會被打包進 server bundle，
// 若在模組載入期就因缺 GEMINI_API_KEY 拋錯，整個 server 會啟動失敗（future-list F002）。
let geminiProvider: ReturnType<typeof createGoogleGenerativeAI> | null = null;
function gemini(modelId: string) {
  if (!geminiProvider) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not configured');
    }
    geminiProvider = createGoogleGenerativeAI({ apiKey });
  }
  return geminiProvider(modelId);
}

// vLLM / Ollama Configuration
const VLLM_CONFIG = {
  baseURL: process.env.VLLM_BASE_URL || '',
  modelName: process.env.VLLM_MODEL_NAME || '',
  apiKey: process.env.VLLM_API_KEY || '', // vLLM/Ollama usually ignores this, but SDK needs it
  timeoutMs: 1500, // 1.5s timeout for health check
};

/**
 * User Preference for Model Provider
 */
export type ModelProvider = 'gemini' | 'local' | 'auto';

/**
 * Resilient Model Factory (Session-Level Circuit Breaker)
 * 
 * Checks if vLLM is available before starting the session.
 * If available -> Returns vLLM model (Privacy & Local Compute)
 * If broken/timeout -> Returns Gemini model (Cloud Fallback)
 * 
 * Update: Supports user preference
 * - 'gemini': Force Gemini
 * - 'local': Force Local (Throws if unavailable)
 * - 'auto': Try Local, Fallback to Gemini
 */
async function selectResilientModel(sessionId: string, preferredProvider: ModelProvider = 'auto'): Promise<{ model: LanguageModel; provider: string }> {
  // 0. Check User Preference - specific overrides
  if (preferredProvider === 'gemini') {
    logger.info({ sessionId }, '[Model Factory] Using Gemini (User Preference)');
    return { 
      model: gemini('gemini-2.5-flash'), 
      provider: 'Gemini' 
    };
  }
  const start = Date.now();
  
  try {
    // 1. Health Check (Ping)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VLLM_CONFIG.timeoutMs);
    
    logger.debug({ url: VLLM_CONFIG.baseURL }, '[Model Factory] Checking vLLM health...');

    // Use a lightweight call to check availability (list models)
    const response = await fetch(`${VLLM_CONFIG.baseURL}/models`, {
      method: 'GET',
      headers: { 
        'Authorization': `Bearer ${VLLM_CONFIG.apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);

    if (response.ok) {
      logger.info({ 
        latency: Date.now() - start,
        model: VLLM_CONFIG.modelName 
      }, '[Model Factory] vLLM is HEALTHY. Using local model.');

      const openai = createOpenAI({
        baseURL: VLLM_CONFIG.baseURL,
        apiKey: VLLM_CONFIG.apiKey,
      });

      // CRITICAL: Use openai.chat() NOT openai() to force /v1/chat/completions endpoint
      // Vercel AI SDK v6+ defaults to /v1/responses API, which vLLM doesn't fully support
      // vLLM returns 500 errors with 'role' validation failure on /v1/responses endpoint
      // Using .chat() ensures compatibility with vLLM's OpenAI-compatible chat completions API
      //
      // Tool call format is controlled by vLLM server configuration:
      // Server must be started with: --enable-auto-tool-choice --tool-call-parser hermes
      // This ensures OpenAI JSON tool calls instead of Qwen XML tags
      // See: docs/vllm-server-config.md for details
      
      logger.info({
        model: VLLM_CONFIG.modelName,
        baseURL: VLLM_CONFIG.baseURL,
        endpoint: '/v1/chat/completions (forced via openai.chat())',
        note: 'Ensure vLLM is configured with --tool-call-parser hermes'
      }, '[Model Factory] Using vLLM with OpenAI-compatible endpoint');

      return { 
        model: openai.chat(VLLM_CONFIG.modelName), 
        provider: 'vLLM' 
      };
    } else {
      logger.warn({ status: response.status }, '[Model Factory] vLLM returned error status');
    }
  } catch (error) {
    logger.warn({ 
      error: error instanceof Error ? error.message : String(error),
      latency: Date.now() - start
    }, '[Model Factory] vLLM unreachable (Circuit Open)');
  }

    // 2. Fallback / Limit Logic
    if (preferredProvider === 'local') {
       logger.error({ sessionId }, '[Model Factory] vLLM unreachable but required by user preference');
       throw new Error('Local model is unreachable. Please check your connection or switch to Auto/Gemini mode.');
    }

  // 3. Fallback to Gemini (Auto mode or default)
  logger.info({ sessionId }, '[Model Factory] Falling back to Gemini 2.5 Flash');
  return { 
    model: gemini('gemini-2.5-flash'), 
    provider: 'Gemini' 
  };
}

/**
 * Teacher Query Type Enum - restricted to teacher-only queries
 */
const teacherQueryTypeEnum = z.enum([
  'user_profile',
  'user_statistics',
  'grading_statistics',
  'teacher_courses',
  'course_detail',
  'course_students',
  'course_assignments',
  'assignment_detail',
  'assignment_submissions',
  'student_submission_detail_teacher',
]) satisfies z.ZodType<TeacherQueryType>;

/**
 * Student Query Type Enum - restricted to student-only queries
 */
const studentQueryTypeEnum = z.enum([
  'user_profile',
  'user_statistics',
  'student_courses',
  'student_assignments',
  'assignment_detail_student', // Added for detailed assignment info
  'student_submissions',
  'submission_detail',
  'my_submission_detail',
  'pending_assignments',
  'enrolled_course_detail',
]) satisfies z.ZodType<StudentQueryType>;

/**
 * Database Query Tool Response Type
 */
interface DatabaseQueryResponse {
  success: boolean;
  queryType?: QueryType;
  data?: unknown;
  error?: string;
}

interface ThinkToolResponse {
  ok: true;
  title: string;
  thought: string;
}

interface ThinkingEnforcementState {
  sawDataToolCall: boolean;
  sawThinkSinceDataTool: boolean;
  lastDataSummary?: string;
}

/**
 * Generate Report Tool - Generate a comprehensive PDF learning report
 */
interface ReportGenerationResponse {
  success: boolean;
  message: string;
  downloadUrl?: string;
  pdfFileName?: string;
  storageKey?: string;
  reportSections?: {
    hasProfile: boolean;
    coursesCount: number;
    submissionsCount: number;
    chartsCount: number;
  };
  error?: string;
}

/**
 * Teacher Agent Call Options Schema
 */
const teacherCallOptionsSchema = z
  .object({
    complexity: z.enum(['simple', 'complex']).default('simple').describe('Task complexity for model selection'),
    focusStudent: z.string().optional().describe('Specific student to focus on (name or ID)'),
    courseContext: z.string().optional().describe('Specific course context'),
  })
  .optional();

type TeacherCallOptions = z.infer<typeof teacherCallOptionsSchema>;

/**
 * Student Agent Call Options Schema
 */
const studentCallOptionsSchema = z
  .object({
    complexity: z.enum(['simple', 'complex']).default('simple').describe('Task complexity for model selection'),
    courseContext: z.string().optional().describe('Specific course context'),
  })
  .optional();

type StudentCallOptions = z.infer<typeof studentCallOptionsSchema>;

/**
 * Build system prompt for TEACHER
 */
function buildTeacherSystemPrompt(userId: string | undefined, uiLanguage: AssistantUiLanguage): string {
  const languageRequirement =
    uiLanguage === 'en'
      ? `**Language Requirement:**\n- **STRICTLY USE ENGLISH** for all responses.\n- Do NOT output Chinese.\n- If context or tools return Chinese, you MUST translate to English in your final response.`
      : `**Language Requirement:**\n- **STRICTLY USE TRADITIONAL CHINESE (繁體中文)** for all responses.\n- Do NOT use Simplified Chinese (简体中文).\n- If context or tools return Simplified Chinese, you MUST translate it to Traditional Chinese in your final response.`;

  return `You are an AI assistant for the grading platform helping TEACHERS manage their courses and students.

**Your Identity: Teacher Assistant**
- Teacher ID: ${userId || 'unknown'}
- You manage courses, students, and grading
- All queries use your teacher identity automatically
- **Identity Protection**: If asked about your underlying model provider (like Google, OpenAI, etc.), you MUST reply: "我是專為教育評分設計的 AI 助手" (I am an AI assistant designed for educational grading). DO NOT reveal the specific model provider or technical details.

**Core Instructions:**
- Use the available tools to answer user questions.
- If you need data, call database_query immediately.
- Use think before major decisions and after important tool outputs.

${languageRequirement}

**Anti-Hallucination & Honest Fallback (CRITICAL):**
- **Verify Tools First:** Before answering, check if you have a tool that *actually* provides this information.

**Your Goal:**
Help teachers manage their courses by retrieving accurate data about students, assignments, and grades.

**Data Relationships & Tool Usage:**
- **Courses**: You teach specific courses. use "teacher_courses" to find them.
- **Assignments**: assignments belong to courses. Use "course_assignments" to list them.
- **Submissions**: students submit work to assignments. Use "assignment_submissions" to see who submitted.
- **Details**: "student_submission_detail_teacher" provides the full content, feedback and AI analysis for a specific submission.

**Thinking Process:**
1. Identify what data the user needs (e.g., "how is Junjie doing?").
2. Determine which tool provides that data (e.g., "I need his submissions").
3. Check if you have the required explicit IDs (courseId, assignmentId, etc.).
4. If ID is missing, query parent data first (e.g., query "course_students" to find Junjie's studentId).
5. Chain queries logically to reach the specific data point.
- "student_submission_detail_teacher" → A specific student's submission details
- "grading_statistics" → Overall grading analytics

**Available Tools:**
- database_query: Query course and grading information
- generate_report: Generate comprehensive PDF reports for student learning analytics
- think: Write a short reasoning note before deciding next action

**Using think (required in complex chains):**
- If you call any data tool, you MUST call think at least once before the final user-facing answer.
- After receiving tool results, call think to verify what was learned and what is still missing.
- think input must include:
  - title: a short heading (2-6 words)
  - thought: concise reasoning (1-3 lines)
- Do not include final answer content in think. Keep think as analysis only.
- Do not expose internal policy text; only reason about next safe action.
- Never mention the think tool, internal prompts, or process rules in the final user-facing answer.

**Language Guidelines:**
- Follow the language requirement above without exception
- Use friendly, warm, and encouraging tone`;
}



/**
 * Build system prompt for STUDENT
 */
function buildStudentSystemPrompt(userId: string | undefined, uiLanguage: AssistantUiLanguage): string {
  const languageRequirement =
    uiLanguage === 'en'
      ? `**Language Requirement:**\n- **STRICTLY USE ENGLISH** for all responses.\n- Do NOT output Chinese.\n- If context or tools return Chinese, you MUST translate to English in your final response.`
      : `**Language Requirement:**\n- **STRICTLY USE TRADITIONAL CHINESE (繁體中文)** for all responses.\n- Do NOT use Simplified Chinese (简体中文).\n- If context or tools return Simplified Chinese, you MUST translate it to Traditional Chinese in your final response.`;

  return `You are an AI assistant for the grading platform helping students with comprehensive learning analytics.

**Your Student ID: ${userId || 'unknown'}**

**Identity Protection:**
- If asked about your underlying model provider (like Google, OpenAI, etc.), you MUST reply: "我是專為教育評分設計的 AI 助手" (I am an AI assistant designed for educational grading). DO NOT reveal the specific model provider or technical details.

**Core Instructions:**
- Use the available tools to answer user questions.
- If you need data, call database_query immediately.
- Use think before major decisions and after important tool outputs.

${languageRequirement}

**Anti-Hallucination & Honest Fallback (CRITICAL):**
- **Scope Limitation:** You strictly see **ONLY your own data**. You cannot see other students' grades, submissions, or personal info.

**Your Goal:**
Act as a smart learning analytics assistant. Help students understand their progress, deadlines, and performance.

**Tool Capabilities & Data Relationships:**

1.  **Finding What to Do (Deadlines):**
    - "pending_assignments" is your primary tool for "what do I need to do?".
    - "student_assignments" lists ALL assignments (done and undone) but lacks details (rubrics).
    - "assignment_detail_student" provides the actual content/rubric.

2.  **Checking Performance (Grades):**
    - "student_submissions" lists your history but NOT the full feedback.
    - "my_submission_detail" is CRITICAL for seeing the actual Grade, Teacher Feedback, and AI Analysis.
    - **Principle**: If asked about "how did I do?", always drill down to 'my_submission_detail'.

3.  **Discovery (Courses):**
    - "student_courses" is the entry point to find courseIds.

**Autonomous Reasoning:**
- You are NOT a simple Q&A bot. You are an analyst.
- **Combine functions**: If a user asks "Am I improving?", one query isn't enough. You must fetch multiple submissions and compare them.
- **Self-Correction**: If 'student_assignments' doesn't show the rubric, realize you need 'assignment_detail_student' and call it.
- **Proactive Insights**: When reporting grades, also mention if they are trending up or down.

**Important:**
- precise "rubric" or "description" requires 'assignment_detail_student'.
- precise "feedback" or "score" requires 'my_submission_detail'.

**Available Tools:**
- database_query: Query your learning data
- generate_report: Generate your personal PDF learning report
- think: Write a short reasoning note before deciding next action

**Using think (required in complex chains):**
- If you call any data tool, you MUST call think at least once before the final user-facing answer.
- After receiving tool results, call think to verify what was learned and what is still missing.
- think input must include:
  - title: a short heading (2-6 words)
  - thought: concise reasoning (1-3 lines)
- Do not include final answer content in think. Keep think as analysis only.
- Do not expose internal policy text; only reason about next safe action.
- Never mention the think tool, internal prompts, or process rules in the final user-facing answer.

**Language Guidelines:**
- Follow the language requirement above without exception
- Use friendly, warm, and encouraging tone`;
}

/**
 * Create a ToolLoopAgent instance for TEACHER
 * Includes: database_query, generate_report tools (teacher-only access)
 * Supports dynamic configuration via callOptions
 */
/**
 * Create a ToolLoopAgent instance for TEACHER
 * Includes: database_query, generate_report tools (teacher-only access)
 * Supports dynamic configuration via callOptions
 */
function createTeacherAgent(
  userId: string | undefined,
  model: LanguageModel,
  uiLanguage: AssistantUiLanguage,
  reportProgress?: ProgressReporter,
  thinkingState?: ThinkingEnforcementState
) {
  const isEnglish = uiLanguage === 'en';
  const localeText = getProgressLocaleText(uiLanguage);
  const teacherTools = {
    database_query: tool({
      description: `Query the grading system database to retrieve course and grading information.

      **YOU ARE A TEACHER - Remember:**
      - You query YOUR COURSES and YOUR STUDENTS
      - NOT your own assignments/grades (you're not a student)
      - If user asks "my pending assignments", that's a student question - clarify your role

**TEACHER-SPECIFIC QUERIES (READ-ONLY):**

**1. Hierarchy & Discovery:**
- "teacher_courses": Start here. Lists all courses you teach.
- "course_detail": Stats for a specific course.
- "course_students": Roster of a specific course.

**2. Assignments:**
- "course_assignments": Lists assignments.
  - param: 'courseId' -> Get assignments for that course.
  - no params -> Get ALL assignments across ALL your courses (Useful overview).
- "assignment_detail": Get the actual content/rubric of an assignment.

**3. Grading & Feedback:**
- "assignment_submissions": List who submitted what (status, grade).
- "student_submission_detail_teacher": **Deep Dive**. Get the actual text, AI analysis, and specific feedback for one submission.
- "grading_statistics": High-level dashboard stats.

**Usage Principle:**
You are an intelligent agent. If you don't have an ID (like 'assignmentId'), look for a parent object (like 'course_assignments') to find it.`,
      inputSchema: z.object({
        queryType: teacherQueryTypeEnum.describe('Teacher query type - use ONLY teacher queries (teacher_courses, course_detail, course_students, etc.)'),
        params: z.record(z.any()).optional().describe('Query parameters like courseId, assignmentId, submissionId, etc. REQUIRED params depend on queryType - check usage flow above'),
      }),
      execute: async (input: { queryType: TeacherQueryType; params?: Record<string, any> }): Promise<DatabaseQueryResponse> => {
        const startedAt = Date.now();
        const queryLabel = getQueryDisplayName(input.queryType, isEnglish);
        if (thinkingState) {
          thinkingState.sawDataToolCall = true;
          thinkingState.sawThinkSinceDataTool = false;
        }
        reportProgress?.({
          phase: 'tool_started',
          title: isEnglish ? `Checking ${queryLabel}` : `正在查詢${queryLabel}`,
          toolName: 'database_query',
        });

        logger.info(
          { 
            queryType: input.queryType, 
            hasParams: !!input.params,
            teacherId: userId || 'UNDEFINED'
          },
          '[Platform Assistant] Teacher database_query tool called'
        );
        
        if (input.params) {
          logger.debug(
            { queryType: input.queryType, params: JSON.stringify(input.params) },
            '[Platform Assistant] Teacher query parameters'
          );
        }

        try {
          const result = await executeDatabaseQuery(input.queryType as QueryType, { 
            teacherId: userId,
            ...input.params 
          });

          if (!result.success) {
            reportProgress?.({
              phase: 'tool_failed',
              title: isEnglish ? `Could not fetch ${queryLabel}` : `查詢${queryLabel}失敗`,
              toolName: 'database_query',
              outputSummary: result.error || 'Unknown query failure',
              durationMs: Date.now() - startedAt,
            });

            logger.warn(
              { 
                queryType: input.queryType, 
                error: result.error,
              },
              '[Platform Assistant] Teacher database_query failed'
            );

            return {
              success: false,
              error: result.error,
            };
          }

          const outputSummary = summarizeUnknownData(result.data, localeText);
          if (thinkingState) {
            thinkingState.lastDataSummary = outputSummary;
          }

          reportProgress?.({
            phase: 'tool_completed',
            title: isEnglish ? `${queryLabel} data is ready` : `${queryLabel}資料已取得`,
            toolName: 'database_query',
            outputSummary,
            durationMs: Date.now() - startedAt,
          });

          return {
            success: true,
            queryType: input.queryType as QueryType,
            data: result.data,
          };
        } catch (error) {
          reportProgress?.({
            phase: 'tool_failed',
            title: isEnglish ? `Error while fetching ${queryLabel}` : `查詢${queryLabel}時發生錯誤`,
            toolName: 'database_query',
            outputSummary: error instanceof Error ? error.message : 'Unknown error',
            durationMs: Date.now() - startedAt,
          });

          logger.error(
            { queryType: input.queryType, error: error instanceof Error ? error.message : String(error) },
            '[Platform Assistant] Teacher database_query failed'
          );
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      },
    }),
    think: tool({
      description:
        'Use this tool as a scratchpad to reason about tool outputs and next actions. It does not fetch or mutate data.',
      inputSchema: z.object({
        title: z.string().min(3).max(80).describe('Short heading for this reasoning checkpoint.'),
        thought: z.string().min(1).describe('Concise reasoning note about what was learned and what to do next.'),
      }),
      execute: async (input: { title: string; thought: string }): Promise<ThinkToolResponse> => {
        const title = input.title.trim();
        const thought = input.thought.trim();
        if (thinkingState) {
          thinkingState.sawThinkSinceDataTool = true;
        }
        reportProgress?.({
          phase: 'step_started',
          title,
          toolName: 'think',
          thinking: thought,
        });

        return {
          ok: true,
          title,
          thought,
        };
      },
    }),
    generate_report: tool({
      description: `Generate a comprehensive PDF learning report for a student including their courses, assignments, grades, and performance analytics with visualizations.

      This tool will:
      1. Query the database for the student's data (courses, assignments, submissions, grades)
      2. Generate statistical analysis and insights
      3. Create visualizations (charts) using Chart.js
      4. Produce a professional HTML report
      5. Convert it to PDF using Puppeteer

      Use this tool when a teacher asks to:
      - "Generate a report for this student"
      - "Create a PDF report for Jun Jie"
      - "I want to see a detailed report of a student's progress"`,
      inputSchema: z.object({
        studentId: z.string().describe('The student user ID'),
        includeCharts: z.boolean().default(true).describe('Whether to include visualizations/charts'),
      }),
      execute: async (input: { studentId: string; includeCharts?: boolean }): Promise<ReportGenerationResponse> => {
        const startedAt = Date.now();
        reportProgress?.({
          phase: 'tool_started',
          title: isEnglish ? 'Start generating student learning report' : '開始生成學習報告',
          toolName: 'generate_report',
          thinking: isEnglish ? 'Need to combine student data, analysis, charts, and PDF.' : '需要整合學生資料、分析、圖表與 PDF。',
          action: isEnglish ? 'Query data -> generate charts -> render PDF -> upload' : '依序查詢資料 -> 生成圖表 -> 產生 PDF -> 上傳',
          expectedOutcome: isEnglish ? 'Get a downloadable report link' : '得到可下載的報告連結',
          inputSummary: summarizeParams({
            studentId: input.studentId,
            includeCharts: input.includeCharts ?? true,
          }, localeText),
        });

        logger.info(
          { studentId: input.studentId, includeCharts: input.includeCharts },
          '[Platform Assistant] Generate report tool called'
        );

        try {
          // Step 1: Query all necessary data from database
          const [userProfile, userStats, studentCourses, studentSubmissions, gradingStats] = await Promise.all([
            executeDatabaseQuery('user_profile', { userId: input.studentId }),
            executeDatabaseQuery('user_statistics', { userId: input.studentId }),
            executeDatabaseQuery('student_courses', { studentId: input.studentId }),
            executeDatabaseQuery('student_submissions', { studentId: input.studentId, limit: 100 }),
            executeDatabaseQuery('grading_statistics', { userId: input.studentId }),
          ]);

          // Check if queries were successful
          if (!userProfile.success || !studentCourses.success) {
            reportProgress?.({
              phase: 'tool_failed',
              title: isEnglish ? 'Report generation stopped: missing required data' : '報告生成中止：資料查詢不足',
              toolName: 'generate_report',
              outputSummary: isEnglish ? 'Unable to fetch required student data' : '無法取得必要學生資料',
              durationMs: Date.now() - startedAt,
            });

            return {
              success: false,
              error: 'Failed to query student data from database',
              message: 'Unable to generate report. The student might not exist or data is unavailable.',
            };
          }

          // Extract data arrays from query results with proper typing
          const coursesData = studentCourses.data as StudentCoursesData | undefined;
          const submissionsData = studentSubmissions.data as StudentSubmissionsData | undefined;

          logger.info(
            {
              coursesCount: coursesData?.courses?.length || 0,
              submissionsCount: submissionsData?.submissions?.length || 0,
            },
            '[Platform Assistant] Data queried successfully'
          );

          // Step 2: Generate chart configurations if requested
          let chartConfigs: ChartConfiguration[] = [];

          if (input.includeCharts && submissionsData?.submissions && submissionsData.submissions.length > 0) {
            reportProgress?.({
              phase: 'step_started',
              title: isEnglish ? 'Report step: building chart configs' : '報告步驟：建立圖表配置',
              toolName: 'generate_report',
              outputSummary: isEnglish
                ? `Processing ${submissionsData.submissions.length} submissions`
                : `將處理 ${submissionsData.submissions.length} 筆 submission`,
            });

            // Use Gemini to extract chart data from submissions
            const { object: chartData } = await generateObject({
              model: gemini('gemini-2.5-flash'),
              schema: z.object({
                chartConfigurations: z.array(
                  z.object({
                    type: z.enum(['bar', 'line']).describe('The type of chart'),
                    labels: z.array(z.string()).describe('Chart labels'),
                    data: z.array(z.number()).describe('Chart data points'),
                    label: z.string().describe('Chart dataset label'),
                    colors: z.array(z.string()).describe('Chart colors in rgba format'),
                  })
                ),
              }),
              prompt: `Given the following student submission and grading data, create 2-3 meaningful charts to visualize:
              1. Grade distribution across assignments
              2. Performance trend over time
              3. Comparison with class average (if available)

              Student Data:
              - Courses: ${JSON.stringify(coursesData)}
              - Submissions: ${JSON.stringify(submissionsData)}
              - Statistics: ${JSON.stringify(gradingStats.data)}

              Generate chart configurations with appropriate labels, data, and colors.`,
            });

            // Convert to Chart.js format
            chartConfigs = chartData.chartConfigurations.map((config) => ({
              type: config.type,
              data: {
                labels: config.labels,
                datasets: [
                  {
                    label: config.label,
                    data: config.data,
                    borderWidth: 1,
                    ...(config.type === 'bar' && { backgroundColor: config.colors }),
                    ...(config.type === 'line' && config.colors.length > 0 && { borderColor: config.colors[0] }),
                  },
                ],
              },
              options: {
                animation: { duration: 0 },
                responsive: true,
                maintainAspectRatio: false,
              },
            }));

            logger.info(
              { chartsGenerated: chartConfigs.length },
              '[Platform Assistant] Chart configurations generated'
            );
          }

          // Step 3: Generate HTML report using Gemini
          const { text: htmlReport } = await generateText({
            model: gemini('gemini-2.5-flash'),
            prompt: `You are an expert educational report writer.
            Generate a comprehensive, professional HTML learning report for a student.

            **Instructions:**
            1. Create a complete HTML document with proper structure and UTF-8 charset
            2. IMPORTANT: Add Chinese font support in CSS with: font-family: 'Noto Sans', 'Noto Sans CJK TC', 'WenQuanYi Zen Hei', 'Microsoft YaHei', 'Arial', sans-serif;
            3. Use modern, clean CSS styling embedded in <style> tag:
              - Background: light neutral color, content in white boxes
              - Headings: bold and clear
              - Tables and charts: centered, with adequate spacing
              - Use subtle borders, shadows, and spacing for sections
            4. Include the student's profile, course list, performance summary, and insights
            5. If charts are provided, create <canvas> elements and <script> blocks to render them
            6. Provide actionable insights and recommendations for improvement
            7. Use a professional, encouraging tone, highlighting strengths and providing constructive feedback.
            8. Include proper headings, sections, and formatting
            9. Make sure all sections are visually distinct and easy to read.
            10. Ensure charts use readable colors, proper labels, and responsive sizing.

            **Chart Rendering:**
            ${
              input.includeCharts
                ? `
            Include this script in the head: <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
            For each chart, use:
            <div style="width: 100%; max-width: 800px; height: 400px; margin: 20px auto;">
              <canvas id="chartX"></canvas>
            </div>
            <script>
              new Chart(document.getElementById('chartX'), chartConfigX);
            </script>
            `
                : ''
            }

            **Student Data:**
            - Profile: ${JSON.stringify(userProfile.data)}
            - Statistics: ${JSON.stringify(userStats.data)}
            - Courses: ${JSON.stringify(coursesData)}
            - Recent Submissions: ${JSON.stringify(submissionsData?.submissions?.slice(0, 10) || [])}
            - Grading Stats: ${JSON.stringify(gradingStats.data)}
            ${input.includeCharts ? `- Chart Configurations: ${JSON.stringify(chartConfigs)}` : ''}

            **Report Sections:**
            1. Header with student name and report date
            2. Executive Summary
            3. Course Overview
            4. Performance Analysis ${input.includeCharts ? '(with charts)' : ''}
            5. Strengths and Areas for Improvement
            6. Recommendations

            Return only the raw HTML code, no markdown code blocks.`,
          });

          // Clean up potential markdown wrapper
          const finalHtml = htmlReport.replace(/^```html\n/, '').replace(/\n```$/, '');

          reportProgress?.({
            phase: 'step_started',
            title: isEnglish ? 'Report step: rendering PDF' : '報告步驟：渲染 PDF',
            toolName: 'generate_report',
            outputSummary: isEnglish ? 'HTML report ready, starting PDF generation' : '已完成 HTML 報告，開始轉 PDF',
          });

          // Step 4: Generate PDF using Puppeteer
          const timestamp = Date.now();
          const pdfFileName = `student-report-${input.studentId}-${timestamp}.pdf`;

          // Use temporary directory for PDF generation
          const tmpDir = tmpdir();
          const pdfPath = path.join(tmpDir, pdfFileName);

          logger.info({ pdfPath }, '[Platform Assistant] Generating PDF');

          const browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
          });

          const page = await browser.newPage();
          await page.setContent(finalHtml, { waitUntil: 'networkidle0' });

          await page.pdf({
            path: pdfPath,
            format: 'A4',
            printBackground: true,
            margin: {
              top: '20mm',
              right: '15mm',
              bottom: '20mm',
              left: '15mm',
            },
          });

          await browser.close();

          const fileSize = (await fs.stat(pdfPath)).size;
          logger.info({ pdfPath, fileSize }, '[Platform Assistant] PDF generated successfully');

          // Step 5: Upload to MinIO
          const storageKey = `reports/${input.studentId}/${pdfFileName}`;
          const pdfBuffer = await fs.readFile(pdfPath);

          await uploadToStorage(pdfBuffer, storageKey, 'application/pdf');

          reportProgress?.({
            phase: 'tool_completed',
            title: isEnglish ? 'Report generation completed' : '報告生成完成',
            toolName: 'generate_report',
            outputSummary: isEnglish
              ? `PDF size ${(fileSize / 1024).toFixed(1)} KB, uploaded to ${storageKey}`
              : `PDF 大小 ${(fileSize / 1024).toFixed(1)} KB，已上傳 ${storageKey}`,
            durationMs: Date.now() - startedAt,
          });

          logger.info({ storageKey, fileSize }, '[Platform Assistant] PDF uploaded to storage');

          // Clean up temporary file
          await fs.unlink(pdfPath);

          // Step 6: Generate download URL with proper 'key' parameter
          const downloadUrl = `/api/reports/download?key=${encodeURIComponent(storageKey)}`;

          return {
            success: true,
            message: 'Learning report generated successfully',
            downloadUrl,
            pdfFileName,
            storageKey,
            reportSections: {
              hasProfile: !!userProfile.data,
              coursesCount: coursesData?.courses?.length || 0,
              submissionsCount: submissionsData?.submissions?.length || 0,
              chartsCount: chartConfigs.length,
            },
          };
        } catch (error) {
          reportProgress?.({
            phase: 'tool_failed',
            title: isEnglish ? 'Report generation failed' : '報告生成失敗',
            toolName: 'generate_report',
            outputSummary: error instanceof Error ? error.message : 'Unknown error',
            durationMs: Date.now() - startedAt,
          });

          logger.error(
            {
              studentId: input.studentId,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
            '[Platform Assistant] Generate report failed'
          );
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            message: 'Failed to generate report',
          };
        }
      },
    }),

  } satisfies ToolSet;

  return new ToolLoopAgent({
    model: model, // Use selected resilient model
    tools: teacherTools,
    instructions: buildTeacherSystemPrompt(userId, uiLanguage),
    stopWhen: stepCountIs(15),
    callOptionsSchema: teacherCallOptionsSchema,
    // Explicitly set toolChoice to 'auto' to ensure vLLM receives the correct signal
    prepareStep: async ({ stepNumber, messages }) => {
      const stepReminder = localeText.languageReminder;

      logger.debug({
        stepNumber,
        messageCount: messages.length,
      }, '[Platform Assistant] Teacher prepareStep');

      // Context Management - Keep conversation within token limits
      if (messages.length > 25) {
        logger.info({
          stepNumber,
          beforeCount: messages.length,
          afterCount: 13,
          reason: 'Token optimization - keeping system + recent messages',
        }, '[Platform Assistant] Teacher pruning messages');

        // Force language reminder even when pruning
        return {
          messages: [
            messages[0], // Keep system message
            ...messages.slice(-12), // Keep last 12 messages
            { 
              role: 'user', 
              content: stepReminder
            }
          ],
          toolChoice: 'auto',
        };
      }

      // Inject language reminder to use Traditional Chinese
      return {
        messages: [
          ...messages,
          { 
            role: 'user', 
            content: stepReminder
          }
        ],
        toolChoice: 'auto',
      };
    },
  });
}

/**
 * Create a ToolLoopAgent instance for STUDENT
 * Includes: database_query tool only (read-only student data)
 * Supports dynamic configuration via callOptions
 */
/**
 * Create a ToolLoopAgent instance for STUDENT
 * Includes: database_query tool only (read-only student data)
 * Supports dynamic configuration via callOptions
 */
function createStudentAgent(
  userId: string | undefined,
  model: LanguageModel,
  uiLanguage: AssistantUiLanguage,
  reportProgress?: ProgressReporter,
  thinkingState?: ThinkingEnforcementState
) {
  const isEnglish = uiLanguage === 'en';
  const localeText = getProgressLocaleText(uiLanguage);
  const studentTools = {
    database_query: tool({
      description: `Query the grading system database to retrieve your learning analytics and course information.

**STUDENT-SPECIFIC QUERIES (READ-ONLY):**

**1. Discovery (The "What"):**
- "student_courses": Your enrolled courses. Start here to get 'courseId'.
- "student_assignments": Lists assignments for a course. **NOTE: Only returns Name & Date.**

**2. Details (The "How"):**
- "assignment_detail_student": **Crucial**. Returns the Description and Rubric. Use this when asked "what is this assignment?"
- "enrolled_course_detail": Course syllabus/info.

**3. Performance (The "Results"):**
- "pending_assignments": What is due soon? (Unsubmitted only).
- "student_submissions": Your submission history list.
- "my_submission_detail": **Deep Dive**. Returns your Score, Teacher Feedback, and AI Analysis.

**4. Stats:**
- "user_statistics": High-level numbers.

**Autonomous Usage:**
Combine these tools to answer questions.
- Need detailed grades? Find submissionId -> Call my_submission_detail.
- Need assignment info? Find assignmentId -> Call assignment_detail_student.`,
      inputSchema: z.object({
        queryType: studentQueryTypeEnum.describe('Student query type - use ONLY student queries (student_courses, student_submissions, my_submission_detail, etc.)'),
        params: z.record(z.any()).optional().describe('Query parameters like courseId, submissionId, etc.'),
      }),
      execute: async (input: { queryType: StudentQueryType; params?: Record<string, any> }): Promise<DatabaseQueryResponse> => {
        const startedAt = Date.now();
        const queryLabel = getQueryDisplayName(input.queryType, isEnglish);
        if (thinkingState) {
          thinkingState.sawDataToolCall = true;
          thinkingState.sawThinkSinceDataTool = false;
        }
        reportProgress?.({
          phase: 'tool_started',
          title: isEnglish ? `Checking ${queryLabel}` : `正在查詢${queryLabel}`,
          toolName: 'database_query',
        });

        logger.info(
          { 
            queryType: input.queryType, 
            hasParams: !!input.params,
            studentId: userId || 'UNDEFINED'
          },
          '[Platform Assistant] Student database_query tool called'
        );

        // Debug log for detailed params
        if (input.params) {
          logger.debug(
            { queryType: input.queryType, params: JSON.stringify(input.params) },
            '[Platform Assistant] Student query parameters'
          );
        }

        try {
          const result = await executeDatabaseQuery(input.queryType as QueryType, { 
            studentId: userId,
            ...input.params 
          });

          if (!result.success) {
            reportProgress?.({
              phase: 'tool_failed',
              title: isEnglish ? `Could not fetch ${queryLabel}` : `查詢${queryLabel}失敗`,
              toolName: 'database_query',
              outputSummary: result.error || 'Unknown query failure',
              durationMs: Date.now() - startedAt,
            });

            return {
              success: false,
              error: result.error,
            };
          }

          const outputSummary = summarizeUnknownData(result.data, localeText);
          if (thinkingState) {
            thinkingState.lastDataSummary = outputSummary;
          }

          reportProgress?.({
            phase: 'tool_completed',
            title: isEnglish ? `${queryLabel} data is ready` : `${queryLabel}資料已取得`,
            toolName: 'database_query',
            outputSummary,
            durationMs: Date.now() - startedAt,
          });

          return {
            success: true,
            queryType: input.queryType as QueryType,
            data: result.data,
          };
        } catch (error) {
          reportProgress?.({
            phase: 'tool_failed',
            title: isEnglish ? `Error while fetching ${queryLabel}` : `查詢${queryLabel}時發生錯誤`,
            toolName: 'database_query',
            outputSummary: error instanceof Error ? error.message : 'Unknown error',
            durationMs: Date.now() - startedAt,
          });

          logger.error(
            { queryType: input.queryType, error: error instanceof Error ? error.message : String(error) },
            '[Platform Assistant] Student database_query failed'
          );
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      },
    }),
    think: tool({
      description:
        'Use this tool as a scratchpad to reason about tool outputs and next actions. It does not fetch or mutate data.',
      inputSchema: z.object({
        title: z.string().min(3).max(80).describe('Short heading for this reasoning checkpoint.'),
        thought: z.string().min(1).describe('Concise reasoning note about what was learned and what to do next.'),
      }),
      execute: async (input: { title: string; thought: string }): Promise<ThinkToolResponse> => {
        const title = input.title.trim();
        const thought = input.thought.trim();
        if (thinkingState) {
          thinkingState.sawThinkSinceDataTool = true;
        }
        reportProgress?.({
          phase: 'step_started',
          title,
          toolName: 'think',
          thinking: thought,
        });

        return {
          ok: true,
          title,
          thought,
        };
      },
    }),
    generate_report: tool({
      description: `Generate your personal comprehensive PDF learning report including all your courses, assignments, grades, and performance analytics with visualizations.

      This tool will:
      1. Query your data (courses, assignments, submissions, grades)
      2. Generate statistical analysis and insights
      3. Create visualizations (charts) using Chart.js
      4. Produce a professional HTML report
      5. Convert it to PDF

      Use this tool when you want to:
      - "Generate my learning report"
      - "Create a PDF report of my progress"
      - "Show me my semester summary"
      - "I want a detailed report of my grades and performance"`,
      inputSchema: z.object({
        includeCharts: z.boolean().default(true).describe('Whether to include visualizations/charts'),
      }),
      execute: async (input: { includeCharts?: boolean }): Promise<ReportGenerationResponse> => {
        const startedAt = Date.now();
        reportProgress?.({
          phase: 'tool_started',
          title: isEnglish ? 'Start generating personal learning report' : '開始生成個人學習報告',
          toolName: 'generate_report',
          thinking: isEnglish ? 'Need to combine course, submission, and score data.' : '需要整合課程、提交與成績資料。',
          action: isEnglish ? 'Query data -> analyze charts -> export PDF' : '查詢資料、分析圖表、輸出 PDF',
          expectedOutcome: isEnglish ? 'Get a downloadable personal report' : '得到可下載的個人報告',
          inputSummary: summarizeParams({ includeCharts: input.includeCharts ?? true }, localeText),
        });

        if (!userId) {
          reportProgress?.({
            phase: 'tool_failed',
            title: isEnglish ? 'Report generation failed: missing student identity' : '報告生成失敗：缺少學生識別',
            toolName: 'generate_report',
            outputSummary: isEnglish ? 'Student ID not available' : '缺少學生 ID，無法建立個人報告',
          });

          return {
            success: false,
            error: 'Student ID not available',
            message: 'Unable to generate report. Student context is missing.',
          };
        }

        logger.info(
          { studentId: userId, includeCharts: input.includeCharts },
          '[Platform Assistant] Student generate report tool called'
        );

        try {
          // Step 1: Query all necessary data from database
          const [userProfile, userStats, studentCourses, studentSubmissions, gradingStats] = await Promise.all([
            executeDatabaseQuery('user_profile', { userId }),
            executeDatabaseQuery('user_statistics', { userId }),
            executeDatabaseQuery('student_courses', { studentId: userId }),
            executeDatabaseQuery('student_submissions', { studentId: userId, limit: 100 }),
            executeDatabaseQuery('grading_statistics', { userId }),
          ]);

          // Check if queries were successful
          if (!userProfile.success || !studentCourses.success) {
            reportProgress?.({
              phase: 'tool_failed',
              title: isEnglish ? 'Report generation stopped: missing required data' : '報告生成中止：資料查詢不足',
              toolName: 'generate_report',
              outputSummary: isEnglish ? 'Unable to fetch required student data' : '無法取得必要學生資料',
              durationMs: Date.now() - startedAt,
            });

            return {
              success: false,
              error: 'Failed to query your data from database',
              message: 'Unable to generate report. Data is unavailable.',
            };
          }

          // Extract data arrays from query results with proper typing
          const coursesData = studentCourses.data as StudentCoursesData | undefined;
          const submissionsData = studentSubmissions.data as StudentSubmissionsData | undefined;

          logger.info(
            {
              coursesCount: coursesData?.courses?.length || 0,
              submissionsCount: submissionsData?.submissions?.length || 0,
            },
            '[Platform Assistant] Student data queried successfully'
          );

          // Step 2: Generate chart configurations if requested
          let chartConfigs: ChartConfiguration[] = [];

          if (input.includeCharts && submissionsData?.submissions && submissionsData.submissions.length > 0) {
            reportProgress?.({
              phase: 'step_started',
              title: isEnglish ? 'Report step: building chart configs' : '報告步驟：建立圖表配置',
              toolName: 'generate_report',
              outputSummary: isEnglish
                ? `Processing ${submissionsData.submissions.length} submissions`
                : `將處理 ${submissionsData.submissions.length} 筆 submission`,
            });

            // Use Gemini to extract chart data from submissions
            const { object: chartData } = await generateObject({
              model: gemini('gemini-2.5-flash'),
              schema: z.object({
                chartConfigurations: z.array(
                  z.object({
                    type: z.enum(['bar', 'line']).describe('The type of chart'),
                    labels: z.array(z.string()).describe('Chart labels'),
                    data: z.array(z.number()).describe('Chart data points'),
                    label: z.string().describe('Chart dataset label'),
                    colors: z.array(z.string()).describe('Chart colors in rgba format'),
                  })
                ),
              }),
              prompt: `Given the following student submission and grading data, create 2-3 meaningful charts to visualize:
              1. Grade distribution across assignments
              2. Performance trend over time
              3. Comparison with class average (if available)

              Student Data:
              - Courses: ${JSON.stringify(coursesData)}
              - Submissions: ${JSON.stringify(submissionsData)}
              - Statistics: ${JSON.stringify(gradingStats.data)}

              Generate chart configurations with appropriate labels, data, and colors.`,
            });

            // Convert to Chart.js format
            chartConfigs = chartData.chartConfigurations.map((config) => ({
              type: config.type,
              data: {
                labels: config.labels,
                datasets: [
                  {
                    label: config.label,
                    data: config.data,
                    borderWidth: 1,
                    ...(config.type === 'bar' && { backgroundColor: config.colors }),
                    ...(config.type === 'line' && config.colors.length > 0 && { borderColor: config.colors[0] }),
                  },
                ],
              },
              options: {
                animation: { duration: 0 },
                responsive: true,
                maintainAspectRatio: false,
              },
            }));

            logger.info(
              { chartsGenerated: chartConfigs.length },
              '[Platform Assistant] Student chart configurations generated'
            );
          }

          // Step 3: Generate HTML report using Gemini
          const { text: htmlReport } = await generateText({
            model: gemini('gemini-2.5-flash'),
            prompt: `You are an expert educational report writer.
            Generate a comprehensive, professional HTML learning report for a student.

            **Instructions:**
            1. Create a complete HTML document with proper structure and UTF-8 charset
            2. IMPORTANT: Add Chinese font support in CSS with: font-family: 'Noto Sans', 'Noto Sans CJK TC', 'WenQuanYi Zen Hei', 'Microsoft YaHei', 'Arial', sans-serif;
            3. Use modern, clean CSS styling embedded in <style> tag:
              - Background: light neutral color, content in white boxes
              - Headings: bold and clear
              - Tables and charts: centered, with adequate spacing
              - Use subtle borders, shadows, and spacing for sections
            4. Include the student's profile, course list, performance summary, and insights
            5. If charts are provided, create <canvas> elements and <script> blocks to render them
            6. Provide actionable insights and recommendations for improvement
            7. Use a professional, encouraging tone, highlighting strengths and providing constructive feedback.
            8. Include proper headings, sections, and formatting
            9. Make sure all sections are visually distinct and easy to read.
            10. Ensure charts use readable colors, proper labels, and responsive sizing.

            **Chart Rendering:**
            ${
              input.includeCharts
                ? `
            Include this script in the head: <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
            For each chart, use:
            <div style="width: 100%; max-width: 800px; height: 400px; margin: 20px auto;">
              <canvas id="chartX"></canvas>
            </div>
            <script>
              new Chart(document.getElementById('chartX'), chartConfigX);
            </script>
            `
                : ''
            }

            **Student Data:**
            - Profile: ${JSON.stringify(userProfile.data)}
            - Statistics: ${JSON.stringify(userStats.data)}
            - Courses: ${JSON.stringify(coursesData)}
            - Recent Submissions: ${JSON.stringify(submissionsData?.submissions?.slice(0, 10) || [])}
            - Grading Stats: ${JSON.stringify(gradingStats.data)}
            ${input.includeCharts ? `- Chart Configurations: ${JSON.stringify(chartConfigs)}` : ''}

            **Report Sections:**
            1. Header with student name and report date
            2. Executive Summary
            3. Course Overview
            4. Performance Analysis ${input.includeCharts ? '(with charts)' : ''}
            5. Strengths and Areas for Improvement
            6. Recommendations

            Return only the raw HTML code, no markdown code blocks.`,
          });

          // Clean up potential markdown wrapper
          const finalHtml = htmlReport.replace(/^```html\n/, '').replace(/\n```$/, '');

          reportProgress?.({
            phase: 'step_started',
            title: isEnglish ? 'Report step: rendering PDF' : '報告步驟：渲染 PDF',
            toolName: 'generate_report',
            outputSummary: isEnglish ? 'HTML report ready, starting PDF generation' : '已完成 HTML 報告，開始轉 PDF',
          });

          // Step 4: Generate PDF using Puppeteer
          const timestamp = Date.now();
          const pdfFileName = `student-report-${userId}-${timestamp}.pdf`;

          // Use temporary directory for PDF generation
          const tmpDir = tmpdir();
          const pdfPath = path.join(tmpDir, pdfFileName);

          logger.info({ pdfPath }, '[Platform Assistant] Student generating PDF');

          const browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
          });

          const page = await browser.newPage();
          await page.setContent(finalHtml, { waitUntil: 'networkidle0' });

          await page.pdf({
            path: pdfPath,
            format: 'A4',
            printBackground: true,
            margin: {
              top: '20mm',
              right: '15mm',
              bottom: '20mm',
              left: '15mm',
            },
          });

          await browser.close();

          const fileSize = (await fs.stat(pdfPath)).size;
          logger.info({ pdfPath, fileSize }, '[Platform Assistant] Student PDF generated successfully');

          // Step 5: Upload to MinIO
          const storageKey = `reports/${userId}/${pdfFileName}`;
          const pdfBuffer = await fs.readFile(pdfPath);

          await uploadToStorage(pdfBuffer, storageKey, 'application/pdf');

          reportProgress?.({
            phase: 'tool_completed',
            title: isEnglish ? 'Personal report generation completed' : '個人報告生成完成',
            toolName: 'generate_report',
            outputSummary: isEnglish
              ? `PDF size ${(fileSize / 1024).toFixed(1)} KB, uploaded to ${storageKey}`
              : `PDF 大小 ${(fileSize / 1024).toFixed(1)} KB，已上傳 ${storageKey}`,
            durationMs: Date.now() - startedAt,
          });

          logger.info({ storageKey, fileSize }, '[Platform Assistant] Student PDF uploaded to storage');

          // Clean up temporary file
          await fs.unlink(pdfPath);

          // Step 6: Generate download URL with proper 'key' parameter
          const downloadUrl = `/api/reports/download?key=${encodeURIComponent(storageKey)}`;

          return {
            success: true,
            message: 'Your learning report has been generated successfully',
            downloadUrl,
            pdfFileName,
            storageKey,
            reportSections: {
              hasProfile: !!userProfile.data,
              coursesCount: coursesData?.courses?.length || 0,
              submissionsCount: submissionsData?.submissions?.length || 0,
              chartsCount: chartConfigs.length,
            },
          };
        } catch (error) {
          reportProgress?.({
            phase: 'tool_failed',
            title: isEnglish ? 'Personal report generation failed' : '個人報告生成失敗',
            toolName: 'generate_report',
            outputSummary: error instanceof Error ? error.message : 'Unknown error',
            durationMs: Date.now() - startedAt,
          });

          logger.error(
            {
              studentId: userId,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
            '[Platform Assistant] Student generate report failed'
          );
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            message: 'Failed to generate your report',
          };
        }
      },
    }),

  } satisfies ToolSet;

  return new ToolLoopAgent({
    model: model,
    instructions: buildStudentSystemPrompt(userId, uiLanguage),
    tools: studentTools,
    stopWhen: stepCountIs(15),
    callOptionsSchema: studentCallOptionsSchema,
    prepareStep: async ({ stepNumber, messages }) => {
      const stepReminder = localeText.languageReminder;

      logger.debug({
        stepNumber,
        messageCount: messages.length,
      }, '[Platform Assistant] Student prepareStep');

      // Context Management - Keep conversation within token limits
      if (messages.length > 25) {
        logger.info({
          stepNumber,
          beforeCount: messages.length,
          afterCount: 13,
          reason: 'Token optimization - keeping system + recent messages',
        }, '[Platform Assistant] Student pruning messages');

        return {
          messages: [
            messages[0], // Keep system message
            ...messages.slice(-12), // Keep last 12 messages
             { 
              role: 'user', 
              content: stepReminder
            }
          ],
          toolChoice: 'auto',
        };
      }

      // Inject language reminder to use Traditional Chinese
      return {
        messages: [
          ...messages,
           { 
            role: 'user', 
            content: stepReminder
          }
        ],
        toolChoice: 'auto',
      };
    },
  });
}

/**
 * Create appropriate agent based on user role
 */
function createPlatformAssistant(
  userRole: 'TEACHER' | 'STUDENT',
  userId: string | undefined,
  model: LanguageModel,
  uiLanguage: AssistantUiLanguage,
  reportProgress?: ProgressReporter,
  thinkingState?: ThinkingEnforcementState
) {
  if (userRole === 'TEACHER') {
    return createTeacherAgent(userId, model, uiLanguage, reportProgress, thinkingState);
  }
  return createStudentAgent(userId, model, uiLanguage, reportProgress, thinkingState);
}

/**
 * Stream the agent response with ToolLoopAgent
 * Supports both TEACHER and STUDENT roles with context-specific prompts
 * 
 * @param userRole - 'TEACHER' or 'STUDENT'
 * @param messages - Chat messages
 * @param userId - User ID
 * @param callOptions - Optional dynamic configuration (teacher or student options)
 */
export async function streamWithPlatformAssistant(
  userRole: 'TEACHER' | 'STUDENT',
  messages: any[],
  userId?: string,
  callOptions?: TeacherCallOptions | StudentCallOptions,
  onFinish?: (result: { text: string; usage: TokenUsage; toolCalls?: any[]; provider?: string }) => Promise<void>,
  preferredProvider: ModelProvider = 'auto',
  externalSessionId?: string,
  uiLanguage: AssistantUiLanguage = 'zh'
) {
  const sessionId = externalSessionId || `${userRole}_${userId}_${Date.now()}`;
  const safeUserId = userId || 'anonymous';
  const localeText = getProgressLocaleText(uiLanguage);
  const reportProgress = createProgressReporter(sessionId, safeUserId, userRole);
  const thinkingState: ThinkingEnforcementState = {
    sawDataToolCall: false,
    sawThinkSinceDataTool: false,
  };

  logger.info({
    userRole,
    messageCount: messages.length,
    userId: userId ? '***' : undefined,
    hasCallOptions: !!callOptions,
    sessionId,
  }, '[Platform Assistant] Initializing agent stream');

  try {
    // 0. Check AI Access Permission
    const access = await checkAIAccess(userId);
    if (!access.allowed) {
      logger.warn({ userId, reason: access.reason }, '[Platform Assistant] AI access denied');
      throw new AIAccessDeniedError(access.reason || 'AI access denied');
    }

    // 1. Select Model (Circuit Breaker)
    const { model, provider } = await selectResilientModel(sessionId, preferredProvider);
    
    logger.info({ sessionId, provider }, '[Platform Assistant] Model selected');

    // 2. Create agent with role-specific configuration and selected model
    const agent = createPlatformAssistant(userRole, userId, model, uiLanguage, reportProgress, thinkingState);

    logger.debug('[Platform Assistant] Agent created successfully');

    // Use manual conversion flow to ensure robustness
    // 1. Convert UIMessages to ModelMessages
    // 2. Stream with agent
    // 3. Convert back to UIMessageStreamResponse
    logger.info({ 
      hasOptions: !!callOptions,
      sessionId,
      messagesCount: messages?.length || 0,
    }, '[Platform Assistant] Using manual convertToModelMessages -> agent.stream() flow');
    
    try {
      // 1. Convert UIMessages to ModelMessages explicitly
      const modelMessages = await convertToModelMessages(messages as any[]);
      
      logger.debug({
        count: modelMessages.length,
        firstRole: modelMessages[0]?.role,
      }, '[Platform Assistant] Converted to ModelMessages');

      // 2. Stream the agent with ModelMessages
      const streamResult = await agent.stream({
        messages: modelMessages,
        options: callOptions || undefined,
      } as any);

      logger.info({ sessionId }, '[Platform Assistant] Agent stream created successfully');

      // Handle onFinish callback if provided
      if (onFinish) {
        // We need to consume the stream to get the final text and usage
        streamResult.text.then(async (finalText) => {
          try {
            const safeFinalText = stripProcessLeakage(finalText);
            let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            try {
              const resultUsage = await streamResult.usage as any;
              usage = {
                promptTokens: resultUsage.promptTokens || 0,
                completionTokens: resultUsage.completionTokens || 0,
                totalTokens: resultUsage.totalTokens || 0,
              };
            } catch (usageError) {
              logger.warn({ sessionId }, '[Platform Assistant] Could not retrieve token usage');
            }
            
            await onFinish({ 
              text: safeFinalText || finalText,
              usage,
              provider 
            });

            if (thinkingState.sawDataToolCall && !thinkingState.sawThinkSinceDataTool) {
              reportProgress({
                phase: 'step_started',
                toolName: 'think',
                title: localeText.isEnglish ? 'Result validation' : '結果確認',
                thinking: localeText.isEnglish
                  ? `Validated tool output before final response. ${thinkingState.lastDataSummary || ''}`.trim()
                  : `已在最終回覆前檢查工具結果。${thinkingState.lastDataSummary ? ` ${thinkingState.lastDataSummary}` : ''}`,
              });
              thinkingState.sawThinkSinceDataTool = true;
            }

            reportProgress({
              phase: 'agent_completed',
              title: localeText.agentCompletedTitle,
              outputSummary: localeText.agentCompletedSummary((safeFinalText || finalText).length, usage.totalTokens || 0),
            });
          } catch (err) {
            logger.error({ err: err }, '[Platform Assistant] Failed to process onFinish');
          }
        });
      }

      // Return the stream response - agent streams should use toUIMessageStreamResponse for useChat compatibility
      const response = streamResult.toUIMessageStreamResponse();
      
      logger.info({ sessionId }, '[Platform Assistant] Stream response created successfully');
      
      return response;
      
    } catch (streamError) {
      reportProgress({
        phase: 'agent_error',
        title: localeText.agentFailedTitle,
        outputSummary: streamError instanceof Error ? streamError.message : String(streamError),
      });

      // Extract detailed error information
      const errorDetails: any = {
        sessionId,
        message: streamError instanceof Error ? streamError.message : String(streamError),
        type: streamError?.constructor?.name,
      };

      // Try to extract more details from the error
      if (streamError instanceof Error) {
        errorDetails.stack = streamError.stack;
        
        // Check if it's a response error with details
        if ('response' in streamError) {
          errorDetails.response = (streamError as any).response;
        }
        if ('cause' in streamError) {
          errorDetails.cause = (streamError as any).cause;
        }
        if ('statusCode' in streamError) {
          errorDetails.statusCode = (streamError as any).statusCode;
        }
        
        // Log the full error object structure
        errorDetails.errorKeys = Object.keys(streamError);
      }

      logger.error({ err: errorDetails }, '[Platform Assistant] Stream failed - DETAILED ERROR');
      
      // Also log as string for easy reading
      logger.error({
        sessionId,
        errorString: JSON.stringify(streamError, null, 2),
      }, '[Platform Assistant] Stream failed - STRING');
      
      throw streamError;
    }
  } catch (error) {
    reportProgress({
      phase: 'agent_error',
      title: localeText.agentInitFailedTitle,
      outputSummary: error instanceof Error ? error.message : String(error),
    });

    logger.error({
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userRole,
      sessionId,
    }, '[Platform Assistant] Fatal error in streamWithGradingAgent');
    throw error;
  }
}

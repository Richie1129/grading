/**
 * AI Grader using Vercel AI SDK
 *
 * This is the main grading service that replaces the old ai-grader.server.ts,
 * gemini-simple.server.ts, gemini-rotating.server.ts, and openai-simple.server.ts.
 *
 * Key improvements over the old system:
 * - Unified AI SDK interface for all providers
 * - Type-safe structured output with Zod schemas
 * - Integrated with existing KeyHealthTracker for distributed coordination
 * - Simpler fallback logic (Gemini → OpenAI)
 * - Better error handling and logging
 * - Reduced code complexity (~200 lines vs 633 lines)
 *
 * Architecture:
 * 1. Try Gemini with health-based key selection
 * 2. On failure, fallback to OpenAI
 * 3. Return detailed error if both fail
 *
 * Usage:
 * ```typescript
 * const result = await gradeWithAI({
 *   prompt: gradingPrompt,
 *   userId: 'user-123',
 *   resultId: 'result-456',
 * });
 *
 * if (result.success) {
 *   console.log(result.data.criteriaGrades);
 * }
 * ```
 */

import logger from '@/utils/logger';
import { isVllmConfigured } from './vllm-provider.server';
import {
  type GradingProvider,
  gradeWithVllm,
  gradeWithGemini,
  gradeWithOpenAI,
  type GradingResult,
  type AIGradingResult,
} from './ai-sdk-provider.server';

export interface GradeWithAIParams {
  prompt: string;
  userId: string;
  resultId: string;
  temperature?: number;
  /**
   * If true, skip OpenAI fallback and return immediately on Gemini failure
   */
  skipFallback?: boolean;
  /**
   * User language for formatting thought summary
   */
  language?: 'zh' | 'en';
  /**
   * Optional context hash for caching
   */
  contextHash?: string;
  /**
   * Optional cached content (if created externally, but usually we pass the hash and let the provider handle it)
   * Actually, let's pass the raw context content so the provider can create the cache if needed.
   */
  contextContent?: string;
  /**
   * Optional user prompt (dynamic part only) when using caching.
   * If provided, cached path uses this instead of full prompt to avoid duplication.
   */
  userPrompt?: string;
}

export interface GradeWithAISuccess {
  success: true;
  data: AIGradingResult;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  provider: GradingProvider;
  keyId?: string;
  responseTimeMs: number;
  thoughtSummary?: string;
  thinkingProcess?: string; // Feature 012: Raw thinking process
  gradingRationale?: string; // Feature 012: Grading rationale
}

export interface GradeWithAIFailure {
  success: false;
  error: string;
  vllmError?: string;
  geminiError?: string;
  openaiError?: string;
  rawOutput?: string;
}

export type GradeWithAIResult = GradeWithAISuccess | GradeWithAIFailure;

const DEFAULT_PROVIDER_ORDER: GradingProvider[] = ['vllm', 'gemini', 'openai'];
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set<GradingProvider>(['vllm', 'gemini', 'openai']);

/**
 * 評分供應商順序。
 *
 * 由環境變數 GRADING_PROVIDER_ORDER 決定（逗號分隔，預設 `vllm,gemini,openai`）；
 * 未知名稱忽略、重複去除；vLLM 未設定（缺 VLLM_BASE_URL / VLLM_MODEL_NAME）時自動略過。
 * 三個供應商的 key 與程式路徑都保留，補上 key 即可使用。
 */
export function getGradingProviderOrder(): GradingProvider[] {
  const raw = process.env.GRADING_PROVIDER_ORDER;
  const requested = raw
    ? raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_PROVIDER_ORDER;
  const ordered: GradingProvider[] = [];
  for (const name of requested) {
    if (KNOWN_PROVIDERS.has(name) && !ordered.includes(name as GradingProvider)) {
      ordered.push(name as GradingProvider);
    }
  }
  const usable = ordered.filter((provider) => provider !== 'vllm' || isVllmConfigured());
  return usable.length > 0 ? usable : DEFAULT_PROVIDER_ORDER.filter((provider) => provider !== 'vllm');
}

/**
 * Grade student work using AI with automatic provider fallback
 *
 * Flow:
 * 1. 依 getGradingProviderOrder() 逐一嘗試（預設 vLLM → Gemini → OpenAI）
 * 2. 任一供應商成功即回傳；skipFallback 為 true 時只試第一個
 * 3. 全部失敗時回傳各供應商的錯誤訊息
 */
export async function gradeWithAI(params: GradeWithAIParams): Promise<GradeWithAIResult> {
  const { prompt, userId, resultId, temperature, skipFallback = false, language = 'en', contextHash, contextContent, userPrompt } = params;
  const order = getGradingProviderOrder();

  logger.info({
    userId,
    resultId,
    promptLength: prompt.length,
    language,
    contextHash,
    contextContent: !!contextContent, // Log presence only
    providerOrder: order,
  }, 'Starting AI grading');

  const graders: Record<GradingProvider, typeof gradeWithGemini> = {
    vllm: gradeWithVllm,
    gemini: gradeWithGemini,
    openai: gradeWithOpenAI,
  };
  const errors: Partial<Record<GradingProvider, string>> = {};
  let rawOutput: string | undefined;

  for (const provider of order) {
    const result = await graders[provider]({
      prompt,
      userId,
      resultId,
      temperature,
      language,
      contextHash,
      contextContent,
      userPrompt,
    });

    if (result.success) {
      logger.info({
        userId,
        resultId,
        provider,
        keyId: result.keyId,
        responseTimeMs: result.responseTimeMs,
        attempted: order.slice(0, order.indexOf(provider) + 1),
      }, `Grading completed successfully with ${provider}`);
      return result;
    }

    errors[provider] = result.error;
    rawOutput = rawOutput ?? result.rawOutput;
    logger.warn({ userId, resultId, provider, error: result.error }, `${provider} grading failed`);

    if (skipFallback) {
      logger.error({ userId, resultId, provider }, `${provider} failed and fallback is disabled`);
      break;
    }
  }

  logger.error({ userId, resultId, providerOrder: order, ...errors }, 'All grading providers failed');

  return {
    success: false,
    error: `All grading providers failed (${order.join(' → ')}).`,
    vllmError: errors.vllm,
    geminiError: errors.gemini,
    openaiError: errors.openai,
    rawOutput,
  };
}

export function convertToLegacyFormat(
  aiResult: AIGradingResult
): {
  breakdown: Array<{
    criteriaId: string;
    name: string;
    score: number;
    feedback: string;
  }>;
  overallFeedback: string;
  summary?: string;
} {
  return {
    breakdown: aiResult.breakdown,
    overallFeedback: aiResult.overallFeedback,
    summary: aiResult.summary,
  };
}

/**
 * Check if AI SDK grading is enabled via feature flag
 */
export function isAISDKGradingEnabled(): boolean {
  return process.env.USE_AI_SDK_GRADING === 'true';
}

/**
 * Get grading provider status for health monitoring
 */
export async function getGradingProviderStatus(): Promise<{
  geminiAvailable: boolean;
  geminiKeyCount: number;
  openaiAvailable: boolean;
}> {
  const geminiKeyCount = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY2,
    process.env.GEMINI_API_KEY3,
  ].filter(Boolean).length;

  return {
    geminiAvailable: geminiKeyCount > 0,
    geminiKeyCount,
    openaiAvailable: !!process.env.OPENAI_API_KEY,
  };
}

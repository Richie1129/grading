/**
 * AI SDK Provider with Health Tracking Integration
 *
 * This service integrates Vercel AI SDK with our existing KeyHealthTracker
 * for intelligent API key selection and distributed health management.
 *
 * Features:
 * - AI SDK unified interface for Gemini and OpenAI
 * - KeyHealthTracker integration for distributed key selection
 * - Automatic health tracking (success/failure recording)
 * - Error classification for proper throttle management
 * - Type-safe structured output with Zod schemas
 *
 * Architecture:
 * - Uses AI SDK's generateObject for type-safe grading
 * - Leverages existing KeyHealthTracker for cross-worker coordination
 * - Maintains compatibility with BullMQ distributed workers
 */

import { generateObject, NoObjectGeneratedError } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import logger from '@/utils/logger';
import { getKeyHealthTracker, type ErrorType } from './gemini-key-health.server';
import { formatThoughtSummary } from './thought-formatter.server';
import { GoogleGenAI } from '@google/genai';
import { GeminiCacheManager } from './gemini-cache.server';
import { checkVllmHealth, createVllmChatModel, getVllmConfig, isVllmConfigured } from './vllm-provider.server';

// Zod schema for grading result (matching legacy GradingResultData format)
const CriterionGradeSchema = z.object({
  criteriaId: z.string(),
  name: z.string(),
  score: z.number(),
  feedback: z.string(),
});

export const GradingResultSchema = z.object({
  breakdown: z.array(CriterionGradeSchema),
  overallFeedback: z.string(),
  summary: z.string().optional(),
  reasoning: z.string().optional(), // Feature 012: Grading Rationale
  // Sparring Questions for Productive Friction
  sparringQuestions: z.array(z.object({
    related_rubric_id: z.string(),
    target_quote: z.string(),
    provocation_strategy: z.enum(['evidence_check', 'logic_gap', 'counter_argument', 'warrant_probe', 'metacognitive', 'conceptual']),
    question: z.string(),
    ai_hidden_reasoning: z.string(),
  })).optional(),
});

export type AIGradingResult = z.infer<typeof GradingResultSchema>;

/**
 * 評分供應商。順序由 ai-grader-sdk 的 GRADING_PROVIDER_ORDER 決定（預設 vllm → gemini → openai）。
 */
export type GradingProvider = 'vllm' | 'gemini' | 'openai';

export const GEMINI_GRADING_MODEL = 'gemini-3.1-flash-lite';
export const OPENAI_GRADING_MODEL = 'gpt-4o-mini';

/**
 * 供 metadata / 記錄使用的模型名稱
 */
export function getModelNameForProvider(provider: GradingProvider): string {
  switch (provider) {
    case 'vllm':
      return getVllmConfig().modelName || 'vllm';
    case 'gemini':
      return GEMINI_GRADING_MODEL;
    case 'openai':
      return OPENAI_GRADING_MODEL;
  }
}

interface GradingParams {
  prompt: string;
  userId: string;
  resultId: string;
  temperature?: number;
  language?: 'zh' | 'en';
  contextHash?: string;
  contextContent?: string;
  userPrompt?: string;
}

interface GradingSuccess {
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
  thoughtSummary?: string; // Deprecated
  thinkingProcess?: string; // Feature 012: Raw thinking process
  gradingRationale?: string; // Feature 012: Grading rationale
}

interface GradingFailure {
  success: false;
  error: string;
  provider?: GradingProvider;
  keyId?: string;
  rawOutput?: string;
  validationError?: string;
}

export type GradingResult = GradingSuccess | GradingFailure;

/**
 * Classify error type for KeyHealthTracker
 */
function classifyGeminiError(error: unknown): ErrorType {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Rate limiting
    if (message.includes('429') || message.includes('rate limit') || message.includes('quota')) {
      return 'rate_limit';
    }

    // Service overloaded
    if (message.includes('503') || message.includes('overload') || message.includes('busy')) {
      return 'overloaded';
    }

    // Service unavailable
    if (
      message.includes('unavailable') ||
      message.includes('timeout') ||
      message.includes('econnrefused')
    ) {
      return 'unavailable';
    }
  }

  return 'other';
}

/**
 * Get API key by ID
 */
function getApiKeyById(keyId: string): string {
  const keys: Record<string, string | undefined> = {
    '1': process.env.GEMINI_API_KEY,
    '2': process.env.GEMINI_API_KEY2,
    '3': process.env.GEMINI_API_KEY3,
  };

  const key = keys[keyId];
  if (!key) {
    throw new Error(`API key not found for keyId: ${keyId}`);
  }

  return key;
}

/**
 * Check if all 3 Gemini keys are configured
 */
function hasMultipleGeminiKeys(): boolean {
  return !!(
    process.env.GEMINI_API_KEY &&
    process.env.GEMINI_API_KEY2 &&
    process.env.GEMINI_API_KEY3
  );
}

/**
 * Grade with Gemini using AI SDK and KeyHealthTracker
 */
export async function gradeWithGemini(params: GradingParams): Promise<GradingResult> {
  const { prompt, userId, resultId, temperature = 0.3, language = 'en', contextHash, contextContent, userPrompt } = params;
  const healthTracker = getKeyHealthTracker();

  // Select best key using KeyHealthTracker
  const availableKeyIds = hasMultipleGeminiKeys() ? ['1', '2', '3'] : ['1'];
  const selectedKeyId = await healthTracker.selectBestKey(availableKeyIds);

  if (!selectedKeyId) {
    logger.error({ userId, resultId }, 'All Gemini keys are throttled');
    return {
      success: false,
      error: 'All Gemini API keys are currently throttled. Please try again later.',
      provider: 'gemini',
    };
  }

  const apiKey = getApiKeyById(selectedKeyId);
  
  // Feature: Context Caching
  // If context is provided, try to use/create a cache and use the cached path
  if (contextHash && contextContent) {
    try {
      // Use explicit version suffix for caching as per docs
      const cacheModel = 'gemini-3.1-flash-lite'; 
      const cacheName = await GeminiCacheManager.ensureCache(
        apiKey,
        selectedKeyId,
        contextHash,
        contextContent,
        undefined, // System instruction managed via prompts for now or inside content
        cacheModel
      );

      if (cacheName) {
         return await gradeWithGeminiCached({
           apiKey,
           cacheName,
           model: cacheModel,
           prompt: userPrompt || prompt, // Use userPrompt if available to avoid duplicating context
           userId,
           resultId,
           keyId: selectedKeyId,
           temperature,
           language,
         });
      }
    } catch (error) {
       logger.warn({
         userId,
         resultId,
         error: String(error)
       }, 'Failed to use Gemini Context Caching, falling back to standard prompt');
       // Fallthrough to standard execution
    }
  }

  const geminiProvider = createGoogleGenerativeAI({ apiKey });
  const startTime = Date.now();

  try {
    logger.info({
      userId,
      resultId,
      keyId: selectedKeyId,
      model: GEMINI_GRADING_MODEL,
    }, 'Grading with Gemini (AI SDK)');

    // Enable Gemini thinking/reasoning mode
    // Docs: https://ai.google.dev/gemini-api/docs/thinking
    const result = await generateObject({
      model: geminiProvider(GEMINI_GRADING_MODEL),
      schema: GradingResultSchema,
      prompt,
      temperature,
      maxRetries: 2, // AI SDK built-in retry
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingBudget: 8192 as const, // Allow model to think (max tokens for reasoning)
            includeThoughts: true as const, // Include thought summaries in response
          } as const,
        },
      } as const,
    });

    const responseTimeMs = Date.now() - startTime;

    // Record success in KeyHealthTracker
    await healthTracker.recordSuccess(selectedKeyId, responseTimeMs);

    // Debug: Log reasoning details
    const reasoningLength = result.reasoning?.length || 0;
    const hasReasoning = !!result.reasoning;

    logger.info({
      userId,
      resultId,
      keyId: selectedKeyId,
      responseTimeMs,
      usage: result.usage,
      hasReasoning,
      reasoningLength,
    }, 'Gemini grading succeeded');

    // Log actual reasoning content if available
    let formattedThoughtSummary: string | undefined;

    if (result.reasoning) {
      logger.debug({
        resultId,
        reasoning: result.reasoning.substring(0, 500), // First 500 chars
        fullLength: result.reasoning.length,
      }, '[AI SDK Reasoning]');

      // Format the thought summary to make it student-friendly
      const formatResult = await formatThoughtSummary({
        rawThought: result.reasoning,
        language: language || 'en',
      });

      if (formatResult.success && formatResult.formattedThought) {
        formattedThoughtSummary = formatResult.formattedThought;
        logger.info(`✨ [AI SDK] Thought summary formatted (${formattedThoughtSummary.length} chars) using ${formatResult.provider}`);
      } else {
        // Fallback to raw reasoning if formatting fails
        formattedThoughtSummary = result.reasoning;
        logger.warn(`⚠️ [AI SDK] Thought formatting failed, using raw: ${formatResult.error}`);
      }
    } else {
      logger.warn({
        resultId,
        providerOptions: 'google.thinkingConfig set',
      }, '[AI SDK] No reasoning returned - thinkingConfig may not be working');
    }

    return {
      success: true,
      data: result.object,
      usage: {
        promptTokens: result.usage.inputTokens ?? 0,
        completionTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
      },
      provider: 'gemini',
      keyId: selectedKeyId,
      responseTimeMs,
      thoughtSummary: formattedThoughtSummary, // Use formatted thought summary
      thinkingProcess: result.reasoning, // Feature 012: Raw thinking process
      gradingRationale: result.object.reasoning, // Feature 012: Grading rationale
    };
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;

    // Classify error for health tracking
    const errorType = classifyGeminiError(error);
    await healthTracker.recordFailure(selectedKeyId, errorType, String(error));

    // Handle NoObjectGeneratedError specifically
    if (NoObjectGeneratedError.isInstance(error)) {
      logger.error({
        userId,
        resultId,
        keyId: selectedKeyId,
        rawOutput: error.text,
        cause: error.cause,
        usage: error.usage,
      }, 'Gemini failed to generate valid object');

      return {
        success: false,
        error: 'Failed to generate valid grading result',
        provider: 'gemini',
        keyId: selectedKeyId,
        rawOutput: error.text,
        validationError: String(error.cause),
      };
    }

    logger.error({
      userId,
      resultId,
      keyId: selectedKeyId,
      errorType,
      responseTimeMs,
      error: error instanceof Error ? error.message : String(error),
    }, 'Gemini grading failed');

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown Gemini error',
      provider: 'gemini',
      keyId: selectedKeyId,
    };
  }
}



/**
 * Grade using an existing Gemini Context Cache (bypassing AI SDK for the call, using official Client)
 */
async function gradeWithGeminiCached(params: {
  apiKey: string;
  cacheName: string;
  model: string;
  prompt: string;
  userId: string;
  resultId: string;
  keyId: string;
  temperature: number;
  language: string;
}): Promise<GradingResult> {
  const { apiKey, cacheName, model, prompt, userId, resultId, keyId, temperature, language } = params;
  const startTime = Date.now();
  const healthTracker = getKeyHealthTracker();

  try {
    const client = new GoogleGenAI({ apiKey });
    
    logger.info({
      userId,
      resultId,
      keyId,
      cacheName,
      model,
    }, 'Grading with Gemini (Cached)');

    // Use JSON schema for structured output
    // We can't easily convert Zod to JSON Schema here without a lib, 
    // but we can request JSON responseMimeType and trust the prompt + parsing.
    // Or we rely on the prompt instructing JSON.
    // The prompt explicitly asks for JSON format (GeminiPrompts.getSimpleOutputFormat).
    
    const response = await client.models.generateContent({
      model,
      config: {
        temperature,
        cachedContent: cacheName,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            breakdown: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  criteriaId: { type: 'STRING' },
                  name: { type: 'STRING' },
                  score: { type: 'NUMBER' },
                  feedback: { type: 'STRING' }
                },
                required: ['criteriaId', 'name', 'score', 'feedback']
              }
            },
            overallFeedback: { type: 'STRING' }
          },
          required: ['breakdown', 'overallFeedback']
        }
      },
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }]
    });

    const responseTimeMs = Date.now() - startTime;
    await healthTracker.recordSuccess(keyId, responseTimeMs);

    const text = response.text;
    if (!text) {
        throw new Error('Empty response from cached model');
    }

    // Parse JSON
    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        throw new Error('Failed to parse JSON from cached model response');
    }

    // Validate with Zod
    const validation = GradingResultSchema.safeParse(parsed);
    if (!validation.success) {
        throw new Error(`Validation failed: ${validation.error.message}`);
    }
    
    // Success!
    const data = validation.data;
    
    // Usage metadata
    const usage = response.usageMetadata ? {
        promptTokens: response.usageMetadata.promptTokenCount || 0,
        completionTokens: response.usageMetadata.candidatesTokenCount || 0,
        totalTokens: response.usageMetadata.totalTokenCount || 0,
    } : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    logger.info({
        userId,
        resultId,
        cacheName,
        usage,
    }, 'Gemini cached grading succeeded');
    
    return {
        success: true,
        data,
        usage,
        provider: 'gemini',
        keyId,
        responseTimeMs,
        // Cached path might not support "thinking" field capture unless we request it via config?
        // Gemini 1.5 doesn't have "Thinking" feature like 2.0/2.5 logic?
        // 1.5 Flash is standard. 
        // We can ignore thinkingProcess for cached path or implement it if model supports it.
        // For now, we omit thinkingProcess if not returned.
    };

  } catch (error) {
    const responseTimeMs = Date.now() - startTime;
    const errorType = classifyGeminiError(error);
    await healthTracker.recordFailure(keyId, errorType, String(error));
    
    logger.error({
        userId,
        resultId,
        keyId,
        cacheName,
        message: (error as any).message,
        status: (error as any).status,
        errorDetails: JSON.stringify(error)
    }, 'Gemini cached grading failed');
    console.error('Gemini Cached Grading Error:', error);

    return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown Gemini Timeout',
        provider: 'gemini',
        keyId,
    };
  }
}

/**
 * Grade with OpenAI using AI SDK (fallback provider)
 */
export async function gradeWithOpenAI(params: GradingParams): Promise<GradingResult> {
  const { prompt, userId, resultId, temperature = 0.1, language = 'en' } = params;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      error: 'OpenAI API key not configured',
      provider: 'openai',
    };
  }

  const openaiProvider = createOpenAI({ apiKey });
  const startTime = Date.now();

  try {
    logger.info({
      userId,
      resultId,
      model: OPENAI_GRADING_MODEL,
    }, 'Grading with OpenAI (AI SDK)');

    const result = await generateObject({
      model: openaiProvider(OPENAI_GRADING_MODEL),
      schema: GradingResultSchema,
      prompt,
      temperature,
      maxRetries: 2,
    });

    const responseTimeMs = Date.now() - startTime;

    logger.info({
      userId,
      resultId,
      responseTimeMs,
      usage: result.usage,
      hasReasoning: !!result.reasoning,
    }, 'OpenAI grading succeeded');

    // Format thought summary if available
    let formattedThoughtSummary: string | undefined;

    if (result.reasoning) {
      const formatResult = await formatThoughtSummary({
        rawThought: result.reasoning,
        language,
      });

      if (formatResult.success && formatResult.formattedThought) {
        formattedThoughtSummary = formatResult.formattedThought;
        logger.info(`✨ [OpenAI] Thought summary formatted (${formattedThoughtSummary.length} chars) using ${formatResult.provider}`);
      } else {
        // Fallback to raw reasoning if formatting fails
        formattedThoughtSummary = result.reasoning;
        logger.warn(`⚠️ [OpenAI] Thought formatting failed, using raw: ${formatResult.error}`);
      }
    }

    return {
      success: true,
      data: result.object,
      usage: {
        promptTokens: result.usage.inputTokens ?? 0,
        completionTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
      },
      provider: 'openai',
      responseTimeMs,
      thoughtSummary: formattedThoughtSummary, // Use formatted thought summary
      thinkingProcess: result.reasoning, // Feature 012: Raw thinking process
      gradingRationale: result.object.reasoning, // Feature 012: Grading rationale
    };
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;

    if (NoObjectGeneratedError.isInstance(error)) {
      logger.error({
        userId,
        resultId,
        rawOutput: error.text,
        cause: error.cause,
        usage: error.usage,
      }, 'OpenAI failed to generate valid object');

      return {
        success: false,
        error: 'Failed to generate valid grading result',
        provider: 'openai',
        rawOutput: error.text,
        validationError: String(error.cause),
      };
    }

    logger.error({
      userId,
      resultId,
      responseTimeMs,
      error: error instanceof Error ? error.message : String(error),
    }, 'OpenAI grading failed');

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown OpenAI error',
      provider: 'openai',
    };
  }
}

/**
 * Grade with vLLM（OpenAI 相容端點）using AI SDK — 預設的第一順位供應商
 *
 * 與 Gemini 路徑的差異：沒有 context caching、沒有 thinking 摘要（模型不回 reasoning），
 * 也不使用 KeyHealthTracker（那是 Gemini 三把 key 的輪替機制）。
 * 端點以 json_schema response_format 產生結構化輸出，不可用時回 success:false 讓上層退回 Gemini / OpenAI。
 */
export async function gradeWithVllm(params: GradingParams): Promise<GradingResult> {
  const { prompt, userId, resultId, temperature = 0.3 } = params;
  const config = getVllmConfig();

  if (!isVllmConfigured(config)) {
    return {
      success: false,
      error: 'vLLM not configured (VLLM_BASE_URL / VLLM_MODEL_NAME)',
      provider: 'vllm',
    };
  }

  const health = await checkVllmHealth(config);
  if (!health.healthy) {
    return {
      success: false,
      error: `vLLM unavailable: ${health.error ?? 'health check failed'}`,
      provider: 'vllm',
    };
  }

  const startTime = Date.now();

  try {
    logger.info({
      userId,
      resultId,
      model: config.modelName,
      baseURL: config.baseURL,
      healthLatencyMs: health.latencyMs,
    }, 'Grading with vLLM (AI SDK)');

    const result = await generateObject({
      model: createVllmChatModel(config),
      schema: GradingResultSchema,
      prompt,
      temperature,
      maxRetries: 2,
    });

    const responseTimeMs = Date.now() - startTime;

    logger.info({
      userId,
      resultId,
      model: config.modelName,
      responseTimeMs,
      usage: result.usage,
    }, 'vLLM grading succeeded');

    return {
      success: true,
      data: result.object,
      usage: {
        promptTokens: result.usage.inputTokens ?? 0,
        completionTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
      },
      provider: 'vllm',
      responseTimeMs,
      thinkingProcess: result.reasoning, // 多數 vLLM 模型不回 reasoning，會是 undefined
      gradingRationale: result.object.reasoning,
    };
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;

    if (NoObjectGeneratedError.isInstance(error)) {
      logger.error({
        userId,
        resultId,
        model: config.modelName,
        rawOutput: error.text,
        cause: error.cause,
        usage: error.usage,
      }, 'vLLM failed to generate valid object');

      return {
        success: false,
        error: 'Failed to generate valid grading result',
        provider: 'vllm',
        rawOutput: error.text,
        validationError: String(error.cause),
      };
    }

    logger.error({
      userId,
      resultId,
      model: config.modelName,
      responseTimeMs,
      error: error instanceof Error ? error.message : String(error),
    }, 'vLLM grading failed');

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown vLLM error',
      provider: 'vllm',
    };
  }
}

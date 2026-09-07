/**
 * vLLM（OpenAI 相容端點）共用設定、健康檢查與模型工廠
 *
 * 評分主流程（ai-grader-sdk 的 AI SDK 路徑、agent-executor 的 Agent 路徑）以 vLLM 為第一順位，
 * 失敗時依 GRADING_PROVIDER_ORDER 退回 Gemini → OpenAI；Gemini / OpenAI 的 key 與程式路徑全部保留。
 *
 * 端點需支援 /v1/chat/completions 的 json_schema response_format（generateObject）與 tool calling（Agent）。
 * 2026-09-07 於 vllm-193（gemma-4-26B-A4B-it）實測兩者皆可。
 */
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import logger from '@/utils/logger';

export interface VllmConfig {
  baseURL: string;
  modelName: string;
  apiKey: string;
  healthTimeoutMs: number;
}

export interface VllmHealth {
  healthy: boolean;
  latencyMs: number;
  error?: string;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 1500;

/**
 * 每次呼叫重新讀環境變數，方便測試與執行期切換
 */
export function getVllmConfig(): VllmConfig {
  const timeout = Number(process.env.VLLM_HEALTH_TIMEOUT_MS);
  return {
    baseURL: (process.env.VLLM_BASE_URL || '').trim().replace(/\/+$/, ''),
    modelName: (process.env.VLLM_MODEL_NAME || '').trim(),
    // vLLM 通常不驗證 key，但 AI SDK 要求非空字串
    apiKey: process.env.VLLM_API_KEY || 'dummy',
    healthTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_HEALTH_TIMEOUT_MS,
  };
}

export function isVllmConfigured(config: VllmConfig = getVllmConfig()): boolean {
  return Boolean(config.baseURL && config.modelName);
}

/**
 * 以 GET /models 做輕量健康檢查，逾時或非 2xx 都視為不可用（不丟例外）
 */
export async function checkVllmHealth(config: VllmConfig = getVllmConfig()): Promise<VllmHealth> {
  const start = Date.now();
  if (!isVllmConfigured(config)) {
    return { healthy: false, latencyMs: 0, error: 'VLLM_BASE_URL or VLLM_MODEL_NAME not configured' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.healthTimeoutMs);
  try {
    const response = await fetch(`${config.baseURL}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      logger.warn(
        { status: response.status, latencyMs, baseURL: config.baseURL },
        '[vLLM] health check returned error status'
      );
      return { healthy: false, latencyMs, error: `HTTP ${response.status}` };
    }
    logger.debug({ latencyMs, baseURL: config.baseURL, model: config.modelName }, '[vLLM] healthy');
    return { healthy: true, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ error: message, latencyMs, baseURL: config.baseURL }, '[vLLM] unreachable');
    return { healthy: false, latencyMs, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 建立指向 vLLM 的 chat 模型。
 * 必須用 openai.chat()：AI SDK 的 openai() 預設走 /v1/responses，vLLM 不支援，
 * 只有 /v1/chat/completions 才有 json_schema 與 tool calling。
 */
export function createVllmChatModel(config: VllmConfig = getVllmConfig()): LanguageModel {
  if (!isVllmConfigured(config)) {
    throw new Error('vLLM not configured: set VLLM_BASE_URL and VLLM_MODEL_NAME');
  }
  const openai = createOpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
  return openai.chat(config.modelName);
}

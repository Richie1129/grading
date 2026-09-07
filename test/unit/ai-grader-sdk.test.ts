import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

vi.mock('@/utils/logger', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/services/vllm-provider.server', () => ({
  isVllmConfigured: vi.fn(),
}));

vi.mock('@/services/ai-sdk-provider.server', () => ({
  gradeWithVllm: vi.fn(),
  gradeWithGemini: vi.fn(),
  gradeWithOpenAI: vi.fn(),
}));

import { isVllmConfigured } from '@/services/vllm-provider.server';
import { gradeWithVllm, gradeWithGemini, gradeWithOpenAI } from '@/services/ai-sdk-provider.server';
import { gradeWithAI, getGradingProviderOrder } from '@/services/ai-grader-sdk.server';

/**
 * Unit Test: AI SDK grading orchestration
 *
 * 驗證 GRADING_PROVIDER_ORDER 的解析，以及 gradeWithAI 依序嘗試 vLLM → Gemini → OpenAI 的 fallback 行為。
 * 三個供應商都以 mock 取代，不打任何外部 API。
 */
const baseParams = { prompt: 'grade this', userId: 'u1', resultId: 'r1' };

function success(provider: 'vllm' | 'gemini' | 'openai') {
  return {
    success: true as const,
    data: { breakdown: [], overallFeedback: `ok from ${provider}` },
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    provider,
    responseTimeMs: 10,
  };
}

function failure(provider: 'vllm' | 'gemini' | 'openai', error: string, rawOutput?: string) {
  return { success: false as const, error, provider, rawOutput };
}

let savedOrder: string | undefined;

describe('AI SDK grading orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    savedOrder = process.env.GRADING_PROVIDER_ORDER;
    delete process.env.GRADING_PROVIDER_ORDER;
    (isVllmConfigured as Mock).mockReturnValue(true);
  });

  afterEach(() => {
    if (savedOrder === undefined) delete process.env.GRADING_PROVIDER_ORDER;
    else process.env.GRADING_PROVIDER_ORDER = savedOrder;
  });

  describe('getGradingProviderOrder', () => {
    it('預設順序 vllm → gemini → openai', () => {
      expect(getGradingProviderOrder()).toEqual(['vllm', 'gemini', 'openai']);
    });

    it('vLLM 未設定時自動略過', () => {
      (isVllmConfigured as Mock).mockReturnValue(false);
      expect(getGradingProviderOrder()).toEqual(['gemini', 'openai']);
    });

    it('GRADING_PROVIDER_ORDER 可自訂順序，忽略未知名稱與重複', () => {
      process.env.GRADING_PROVIDER_ORDER = ' gemini , VLLM ,bogus,gemini';
      expect(getGradingProviderOrder()).toEqual(['gemini', 'vllm']);
    });

    it('全部都是未知名稱時退回不含 vLLM 的預設順序', () => {
      process.env.GRADING_PROVIDER_ORDER = 'foo,bar';
      expect(getGradingProviderOrder()).toEqual(['gemini', 'openai']);
    });
  });

  describe('gradeWithAI', () => {
    it('vLLM 成功時不再呼叫 Gemini 與 OpenAI', async () => {
      (gradeWithVllm as Mock).mockResolvedValue(success('vllm'));

      const result = await gradeWithAI(baseParams);

      expect(result.success).toBe(true);
      if (result.success) expect(result.provider).toBe('vllm');
      expect(gradeWithVllm).toHaveBeenCalledTimes(1);
      expect(gradeWithGemini).not.toHaveBeenCalled();
      expect(gradeWithOpenAI).not.toHaveBeenCalled();
    });

    it('vLLM 失敗時退回 Gemini，Gemini 成功就停止', async () => {
      (gradeWithVllm as Mock).mockResolvedValue(failure('vllm', 'vLLM unavailable'));
      (gradeWithGemini as Mock).mockResolvedValue(success('gemini'));

      const result = await gradeWithAI({ ...baseParams, contextHash: 'h', contextContent: 'c' });

      expect(result.success).toBe(true);
      if (result.success) expect(result.provider).toBe('gemini');
      expect(gradeWithGemini).toHaveBeenCalledWith(expect.objectContaining({ contextHash: 'h', contextContent: 'c' }));
      expect(gradeWithOpenAI).not.toHaveBeenCalled();
    });

    it('vLLM 與 Gemini 都失敗時退回 OpenAI', async () => {
      (gradeWithVllm as Mock).mockResolvedValue(failure('vllm', 'down'));
      (gradeWithGemini as Mock).mockResolvedValue(failure('gemini', 'quota'));
      (gradeWithOpenAI as Mock).mockResolvedValue(success('openai'));

      const result = await gradeWithAI(baseParams);

      expect(result.success).toBe(true);
      if (result.success) expect(result.provider).toBe('openai');
    });

    it('全部失敗時回傳各供應商的錯誤與第一個 rawOutput', async () => {
      (gradeWithVllm as Mock).mockResolvedValue(failure('vllm', 'down', 'raw-vllm'));
      (gradeWithGemini as Mock).mockResolvedValue(failure('gemini', 'quota'));
      (gradeWithOpenAI as Mock).mockResolvedValue(failure('openai', 'not configured'));

      const result = await gradeWithAI(baseParams);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.vllmError).toBe('down');
        expect(result.geminiError).toBe('quota');
        expect(result.openaiError).toBe('not configured');
        expect(result.rawOutput).toBe('raw-vllm');
        expect(result.error).toContain('vllm → gemini → openai');
      }
    });

    it('skipFallback 時只嘗試第一個供應商', async () => {
      (gradeWithVllm as Mock).mockResolvedValue(failure('vllm', 'down'));

      const result = await gradeWithAI({ ...baseParams, skipFallback: true });

      expect(result.success).toBe(false);
      expect(gradeWithGemini).not.toHaveBeenCalled();
      expect(gradeWithOpenAI).not.toHaveBeenCalled();
    });

    it('vLLM 未設定時第一個嘗試的是 Gemini', async () => {
      (isVllmConfigured as Mock).mockReturnValue(false);
      (gradeWithGemini as Mock).mockResolvedValue(success('gemini'));

      const result = await gradeWithAI(baseParams);

      expect(result.success).toBe(true);
      expect(gradeWithVllm).not.toHaveBeenCalled();
      expect(gradeWithGemini).toHaveBeenCalledTimes(1);
    });
  });
});

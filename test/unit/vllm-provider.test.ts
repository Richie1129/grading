import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/utils/logger', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getVllmConfig, isVllmConfigured, checkVllmHealth, createVllmChatModel } from '@/services/vllm-provider.server';

/**
 * Unit Test: vLLM provider helpers
 *
 * 評分主流程以 vLLM 為第一順位供應商，這裡驗證設定解析、健康檢查與模型工廠，
 * 不打真實端點（fetch 以 stub 取代）。
 */
const ENV_KEYS = ['VLLM_BASE_URL', 'VLLM_MODEL_NAME', 'VLLM_API_KEY', 'VLLM_HEALTH_TIMEOUT_MS'] as const;
let savedEnv: Record<string, string | undefined> = {};

function setVllmEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
}

describe('vLLM provider helpers', () => {
  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    setVllmEnv({});
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.unstubAllGlobals();
  });

  describe('getVllmConfig', () => {
    it('去掉 baseURL 結尾斜線、apiKey 預設 dummy、逾時預設 1500ms', () => {
      setVllmEnv({ VLLM_BASE_URL: 'https://vllm.example/v1///', VLLM_MODEL_NAME: ' /models/gemma ' });
      const config = getVllmConfig();
      expect(config.baseURL).toBe('https://vllm.example/v1');
      expect(config.modelName).toBe('/models/gemma');
      expect(config.apiKey).toBe('dummy');
      expect(config.healthTimeoutMs).toBe(1500);
    });

    it('VLLM_HEALTH_TIMEOUT_MS 非正數時退回預設值', () => {
      setVllmEnv({ VLLM_HEALTH_TIMEOUT_MS: 'abc' });
      expect(getVllmConfig().healthTimeoutMs).toBe(1500);
      setVllmEnv({ VLLM_HEALTH_TIMEOUT_MS: '-5' });
      expect(getVllmConfig().healthTimeoutMs).toBe(1500);
      setVllmEnv({ VLLM_HEALTH_TIMEOUT_MS: '3000' });
      expect(getVllmConfig().healthTimeoutMs).toBe(3000);
    });
  });

  describe('isVllmConfigured', () => {
    it('缺 baseURL 或 modelName 任一都算未設定', () => {
      expect(isVllmConfigured()).toBe(false);
      setVllmEnv({ VLLM_BASE_URL: 'https://vllm.example/v1' });
      expect(isVllmConfigured()).toBe(false);
      setVllmEnv({ VLLM_MODEL_NAME: 'm' });
      expect(isVllmConfigured()).toBe(false);
      setVllmEnv({ VLLM_BASE_URL: 'https://vllm.example/v1', VLLM_MODEL_NAME: 'm' });
      expect(isVllmConfigured()).toBe(true);
    });
  });

  describe('checkVllmHealth', () => {
    it('未設定時直接回 unhealthy，不呼叫 fetch', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const health = await checkVllmHealth();
      expect(health.healthy).toBe(false);
      expect(health.error).toContain('not configured');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('GET /models 回 2xx 視為 healthy，並帶 Bearer key', async () => {
      setVllmEnv({ VLLM_BASE_URL: 'https://vllm.example/v1', VLLM_MODEL_NAME: 'm', VLLM_API_KEY: 'secret' });
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      const health = await checkVllmHealth();

      expect(health.healthy).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://vllm.example/v1/models');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('非 2xx 視為 unhealthy 並帶 HTTP 狀態碼', async () => {
      setVllmEnv({ VLLM_BASE_URL: 'https://vllm.example/v1', VLLM_MODEL_NAME: 'm' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
      const health = await checkVllmHealth();
      expect(health.healthy).toBe(false);
      expect(health.error).toBe('HTTP 503');
    });

    it('fetch 拋錯（逾時 / 連線失敗）視為 unhealthy，不向上拋', async () => {
      setVllmEnv({ VLLM_BASE_URL: 'https://vllm.example/v1', VLLM_MODEL_NAME: 'm' });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('This operation was aborted')));
      const health = await checkVllmHealth();
      expect(health.healthy).toBe(false);
      expect(health.error).toContain('aborted');
    });
  });

  describe('createVllmChatModel', () => {
    it('未設定時拋錯', () => {
      expect(() => createVllmChatModel()).toThrow(/not configured/);
    });

    it('已設定時回傳指向 chat completions 的模型', () => {
      setVllmEnv({ VLLM_BASE_URL: 'https://vllm.example/v1', VLLM_MODEL_NAME: '/models/gemma' });
      const model = createVllmChatModel();
      expect(model.modelId).toBe('/models/gemma');
      expect(model.provider).toContain('chat');
    });
  });
});

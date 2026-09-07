import { describe, it, expect } from 'vitest';
import { mergeOptimizedCriteria } from '@/services/agent-rubric.server';
import type { ParsedCriterion } from '@/types/agent';

/**
 * Unit Test: Agent rubric 優化結果合併
 *
 * LLM 優化 rubric 時可能改寫 criteriaId / name / maxScore（gemma via vLLM 實測），
 * 合併後這三個欄位必須維持原始值，只採用模型產生的 description 與 levels。
 */
const original: ParsedCriterion[] = [
  {
    criteriaId: 'c1',
    name: '論點清晰',
    description: '主張明確',
    maxScore: 10,
    levels: [
      { score: 10, description: '明確' },
      { score: 5, description: '普通' },
    ],
  },
  {
    criteriaId: 'c2',
    name: '證據支持',
    description: '有例證',
    maxScore: 10,
  },
];

describe('mergeOptimizedCriteria', () => {
  it('採用模型的 description 與 levels，保留原始 criteriaId / name / maxScore', () => {
    const result = mergeOptimizedCriteria(original, [
      {
        criteriaId: 'thesis_clarity',
        name: 'Thesis clarity',
        description: '主張明確且全篇一致，段落之間有轉折詞銜接',
        maxScore: 1,
        levels: [
          { score: 10, description: '主張明確且一致' },
          { score: 6, description: '主張大致清楚' },
          { score: 2, description: '看不出主張' },
        ],
      },
      {
        criteriaId: 'evidence_support',
        name: '證據支持',
        description: '每個論點都有具體例證或研究資料',
        maxScore: 1,
        levels: [{ score: 10, description: '皆有例證' }],
      },
    ]);

    expect(result.usedOriginal).toBe(false);
    expect(result.criteria.map((c) => c.criteriaId)).toEqual(['c1', 'c2']);
    expect(result.criteria.map((c) => c.name)).toEqual(['論點清晰', '證據支持']);
    expect(result.criteria.map((c) => c.maxScore)).toEqual([10, 10]);
    expect(result.criteria[0].description).toContain('轉折詞');
    expect(result.criteria[0].levels).toHaveLength(3);
    expect(result.criteria[1].levels).toHaveLength(1);
    expect(result.violations.length).toBeGreaterThanOrEqual(4);
  });

  it('模型完全遵守規則時沒有 violations', () => {
    const result = mergeOptimizedCriteria(original, [
      { criteriaId: 'c1', name: '論點清晰', description: '更具體的說明', maxScore: 10 },
      { criteriaId: 'c2', name: '證據支持', description: '更具體的說明', maxScore: 10 },
    ]);
    expect(result.violations).toEqual([]);
    expect(result.criteria[0].levels).toEqual(original[0].levels);
  });

  it('數量不符時整份退回原始 rubric', () => {
    const result = mergeOptimizedCriteria(original, [{ criteriaId: 'c1', description: 'x', maxScore: 10 }]);
    expect(result.usedOriginal).toBe(true);
    expect(result.criteria).toBe(original);
    expect(result.violations[0]).toContain('count changed');
  });

  it('非陣列輸入退回原始 rubric', () => {
    expect(mergeOptimizedCriteria(original, null).usedOriginal).toBe(true);
    expect(mergeOptimizedCriteria(original, undefined).criteria).toBe(original);
  });

  it('levels 分數超出 maxScore 或格式不對時保留原始 levels', () => {
    const result = mergeOptimizedCriteria(original, [
      { criteriaId: 'c1', description: 'ok', maxScore: 10, levels: [{ score: 100, description: '超標' }] },
      { criteriaId: 'c2', description: 'ok', maxScore: 10, levels: [] },
    ]);
    expect(result.criteria[0].levels).toEqual(original[0].levels);
    expect(result.criteria[1].levels).toBeUndefined();
  });

  it('空白 description 不覆蓋原始說明', () => {
    const result = mergeOptimizedCriteria(original, [
      { criteriaId: 'c1', description: '   ', maxScore: 10 },
      { criteriaId: 'c2', maxScore: 10 },
    ]);
    expect(result.criteria[0].description).toBe('主張明確');
    expect(result.criteria[1].description).toBe('有例證');
  });
});

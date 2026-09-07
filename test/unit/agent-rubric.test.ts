import { describe, it, expect } from 'vitest';
import { mergeOptimizedCriteria, alignBreakdownToRubric, remapRelatedRubricIds } from '@/services/agent-rubric.server';
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


describe('alignBreakdownToRubric', () => {
  const rubric: ParsedCriterion[] = [
    { criteriaId: 'c1', name: '論點清晰', description: '', maxScore: 10 },
    { criteriaId: 'c2', name: '證據支持', description: '', maxScore: 10 },
    { criteriaId: 'c3', name: '文字表達', description: '', maxScore: 5 },
  ];

  it('模型用自訂 ID 與 5 分制時，依名稱對回 rubric 並等比例換算成 10 分制', () => {
    const result = alignBreakdownToRubric(
      [
        { criteriaId: 'argument_clarity', name: '論點清晰', score: 4, maxScore: 5, feedback: 'A' },
        { criteriaId: 'evidence_support', name: '證據支持', score: 4, maxScore: 5, feedback: 'B' },
        { criteriaId: 'expression', name: '文字表達', score: 5, maxScore: 5, feedback: 'C' },
      ],
      rubric,
      'n/a'
    );
    expect(result.breakdown.map((b) => [b.criteriaId, b.score, b.maxScore])).toEqual([
      ['c1', 8, 10],
      ['c2', 8, 10],
      ['c3', 5, 5],
    ]);
    expect(result.totalScore).toBe(21);
    expect(result.maxScore).toBe(25);
    expect(result.percentage).toBe(84);
    expect(result.idMap).toMatchObject({ argument_clarity: 'c1', evidence_support: 'c2', expression: 'c3' });
    expect(result.notes.filter((n) => n.startsWith('rescaled'))).toHaveLength(2);
  });

  it('criteriaId 一致時直接對應，分數尺度相同不換算', () => {
    const result = alignBreakdownToRubric(
      [
        { criteriaId: 'c2', name: 'x', score: 7, maxScore: 10, feedback: 'B' },
        { criteriaId: 'c1', name: 'y', score: 9, maxScore: 10, feedback: 'A' },
        { criteriaId: 'c3', name: 'z', score: 3, maxScore: 5, feedback: 'C' },
      ],
      rubric,
      'n/a'
    );
    expect(result.breakdown.map((b) => [b.criteriaId, b.score, b.feedback])).toEqual([
      ['c1', 9, 'A'],
      ['c2', 7, 'B'],
      ['c3', 3, 'C'],
    ]);
    expect(result.notes).toEqual([]);
  });

  it('ID 與名稱都對不到但數量相同時依順序對應；分數超過總分會夾住', () => {
    const result = alignBreakdownToRubric(
      [
        { criteriaId: 'a', name: 'A', score: 12, maxScore: 10, feedback: '1' },
        { criteriaId: 'b', name: 'B', score: -1, maxScore: 10, feedback: '2' },
        { criteriaId: 'c', name: 'C', score: 2, feedback: '3' },
      ],
      rubric,
      'n/a'
    );
    expect(result.breakdown.map((b) => [b.criteriaId, b.score])).toEqual([
      ['c1', 10],
      ['c2', 0],
      ['c3', 2],
    ]);
    expect(result.notes.filter((n) => n.startsWith('clamped'))).toHaveLength(2);
  });

  it('模型少回一項時該 criterion 給 0 分與 fallback 說明，多出的項目丟棄', () => {
    const result = alignBreakdownToRubric(
      [
        { criteriaId: 'c1', score: 6, maxScore: 10, feedback: 'A' },
        { criteriaId: 'zzz', name: '不存在的維度', score: 9, maxScore: 10, feedback: 'X' },
      ],
      rubric,
      '模型未提供此項評語'
    );
    expect(result.breakdown.map((b) => [b.criteriaId, b.score, b.feedback])).toEqual([
      ['c1', 6, 'A'],
      ['c2', 0, '模型未提供此項評語'],
      ['c3', 0, '模型未提供此項評語'],
    ]);
    expect(result.notes).toEqual(
      expect.arrayContaining([expect.stringContaining('missing: c2'), expect.stringContaining('dropped 1')])
    );
  });

  it('空輸入時全部 0 分', () => {
    const result = alignBreakdownToRubric(null, rubric, 'n/a');
    expect(result.totalScore).toBe(0);
    expect(result.maxScore).toBe(25);
    expect(result.breakdown).toHaveLength(3);
  });
});

describe('remapRelatedRubricIds', () => {
  it('用 idMap 把模型自訂 ID 對回 rubric ID，對不到的保持原值', () => {
    const questions = [
      { related_rubric_id: 'argument_clarity', question: 'q1' },
      { related_rubric_id: 'general', question: 'q2' },
    ];
    expect(remapRelatedRubricIds(questions, { argument_clarity: 'c1' })).toEqual([
      { related_rubric_id: 'c1', question: 'q1' },
      { related_rubric_id: 'general', question: 'q2' },
    ]);
    expect(remapRelatedRubricIds(undefined, {})).toEqual([]);
  });
});

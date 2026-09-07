/**
 * Agent 評分的 rubric 優化結果合併規則（純函式，無外部相依，方便單元測試）
 *
 * agent-executor 會請 LLM 把 rubric 說明與等級寫得更具體，提示詞要求「保留 ID、名稱、總分不變」，
 * 但 schema 無法強制，模型可能改寫（gemma-4 via vLLM 實測會把 criteriaId 改成英文代號、maxScore 改成 1）。
 * criteriaId 與 maxScore 是後續 breakdown 對回 rubric、計算總分的依據，這裡一律以原始值為準，
 * 只採用模型產生的 description 與 levels。
 */
import type { ParsedCriterion } from '@/types/agent';

export interface OptimizedCriterionCandidate {
  criteriaId?: string;
  name?: string;
  description?: string;
  maxScore?: number;
  levels?: Array<{ score: number; description: string }>;
}

export interface MergeOptimizedCriteriaResult {
  criteria: ParsedCriterion[];
  /** 模型是否改動了不可變欄位（只作記錄，合併結果已還原） */
  violations: string[];
  /** 數量不符時整份退回原始 rubric */
  usedOriginal: boolean;
}

export function mergeOptimizedCriteria(
  original: ParsedCriterion[],
  optimized: OptimizedCriterionCandidate[] | null | undefined
): MergeOptimizedCriteriaResult {
  if (!Array.isArray(optimized) || optimized.length !== original.length) {
    return {
      criteria: original,
      violations: [`count changed: ${original.length} → ${Array.isArray(optimized) ? optimized.length : 'invalid'}`],
      usedOriginal: true,
    };
  }

  const violations: string[] = [];
  const criteria = original.map((base, index) => {
    const candidate = optimized[index] ?? {};

    if (candidate.criteriaId !== undefined && candidate.criteriaId !== base.criteriaId) {
      violations.push(`[${index}] criteriaId ${base.criteriaId} → ${candidate.criteriaId}`);
    }
    if (candidate.maxScore !== undefined && candidate.maxScore !== base.maxScore) {
      violations.push(`[${index}] maxScore ${base.maxScore} → ${candidate.maxScore}`);
    }
    if (candidate.name !== undefined && candidate.name !== base.name) {
      violations.push(`[${index}] name "${base.name}" → "${candidate.name}"`);
    }

    const description =
      typeof candidate.description === 'string' && candidate.description.trim().length > 0
        ? candidate.description
        : base.description;

    const levelsValid =
      Array.isArray(candidate.levels) &&
      candidate.levels.length > 0 &&
      candidate.levels.every(
        (level) =>
          typeof level?.score === 'number' &&
          Number.isFinite(level.score) &&
          level.score >= 0 &&
          level.score <= base.maxScore &&
          typeof level?.description === 'string'
      );
    const levels = levelsValid ? candidate.levels : base.levels;

    return {
      ...base,
      description,
      ...(levels !== undefined ? { levels } : {}),
    };
  });

  return { criteria, violations, usedOriginal: false };
}

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

// ============================================================================
// 把模型回傳的 breakdown 對回 rubric
// ============================================================================

export interface ModelBreakdownItem {
  criteriaId?: string;
  name?: string;
  score?: number;
  maxScore?: number;
  feedback?: string;
}

export interface AlignedBreakdownItem {
  criteriaId: string;
  name: string;
  score: number;
  maxScore: number;
  feedback: string;
}

export interface AlignBreakdownResult {
  breakdown: AlignedBreakdownItem[];
  totalScore: number;
  maxScore: number;
  percentage: number;
  /** 模型自訂的 criteriaId / name → rubric 的 criteriaId，供 sparringQuestions.related_rubric_id 對回 */
  idMap: Record<string, string>;
  /** 對齊時發生的事：換算比例、找不到對應、多餘項目等（只作記錄） */
  notes: string[];
}

function normalizeName(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 系統提示只給模型 criteria 的名稱與總分（沒有 ID），模型會自創 criteriaId、也可能用自己的 maxScore 尺度
 * （gemma-4 via vLLM 實測：rubric 10 分它回 4/5）。評分引擎的總分以 rubric 的 maxScore 為準，
 * 若不換算會把 80% 算成 40%。這裡依 criteriaId → 名稱 → 順序對回每一條 rubric criterion，
 * 分數依「模型 maxScore → rubric maxScore」等比例換算並夾在 [0, maxScore]；
 * 找不到對應的 criterion 給 0 分並填 fallback 說明，模型多出來的項目丟棄。
 */
export function alignBreakdownToRubric(
  items: ModelBreakdownItem[] | null | undefined,
  criteria: ParsedCriterion[],
  missingFeedback: string
): AlignBreakdownResult {
  const list = Array.isArray(items) ? items : [];
  const notes: string[] = [];
  const idMap: Record<string, string> = {};
  const used = new Set<number>();

  const findIndex = (criterion: ParsedCriterion, position: number): number => {
    const byId = list.findIndex(
      (item, i) => !used.has(i) && item.criteriaId !== undefined && item.criteriaId === criterion.criteriaId
    );
    if (byId !== -1) return byId;
    const target = normalizeName(criterion.name);
    const byName = list.findIndex(
      (item, i) =>
        !used.has(i) &&
        target.length > 0 &&
        (normalizeName(item.name) === target || normalizeName(item.criteriaId) === target)
    );
    if (byName !== -1) return byName;
    if (list.length === criteria.length && !used.has(position)) return position;
    return -1;
  };

  const breakdown = criteria.map((criterion, position) => {
    const index = findIndex(criterion, position);
    if (index === -1) {
      notes.push(`missing: ${criterion.criteriaId} (${criterion.name})`);
      return {
        criteriaId: criterion.criteriaId,
        name: criterion.name,
        score: 0,
        maxScore: criterion.maxScore,
        feedback: missingFeedback,
      };
    }
    used.add(index);
    const item = list[index];
    if (item.criteriaId && item.criteriaId !== criterion.criteriaId) idMap[item.criteriaId] = criterion.criteriaId;
    if (item.name && item.name !== criterion.criteriaId) idMap[item.name] = criterion.criteriaId;

    const rawScore = typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : 0;
    const modelMax =
      typeof item.maxScore === 'number' && Number.isFinite(item.maxScore) && item.maxScore > 0
        ? item.maxScore
        : undefined;
    let score = rawScore;
    if (modelMax !== undefined && modelMax !== criterion.maxScore) {
      score = (rawScore / modelMax) * criterion.maxScore;
      notes.push(
        `rescaled ${criterion.criteriaId}: ${rawScore}/${modelMax} → ${roundScore(score)}/${criterion.maxScore}`
      );
    }
    if (score < 0 || score > criterion.maxScore) {
      notes.push(`clamped ${criterion.criteriaId}: ${roundScore(score)} → [0, ${criterion.maxScore}]`);
    }
    score = roundScore(Math.max(0, Math.min(score, criterion.maxScore)));

    return {
      criteriaId: criterion.criteriaId,
      name: criterion.name,
      score,
      maxScore: criterion.maxScore,
      feedback: typeof item.feedback === 'string' && item.feedback.trim().length > 0 ? item.feedback : missingFeedback,
    };
  });

  const extra = list.length - used.size;
  if (extra > 0) notes.push(`dropped ${extra} unmatched item(s) from model output`);

  const totalScore = roundScore(breakdown.reduce((sum, item) => sum + item.score, 0));
  const maxScore = criteria.reduce((sum, criterion) => sum + criterion.maxScore, 0);
  const percentage = maxScore > 0 ? roundScore((totalScore / maxScore) * 100) : 0;

  return { breakdown, totalScore, maxScore, percentage, idMap, notes };
}

/**
 * sparringQuestions.related_rubric_id 是模型自訂的 ID，用 alignBreakdownToRubric 的 idMap 對回 rubric ID；
 * 對不到的保持原值（前端會再用名稱比對）
 */
export function remapRelatedRubricIds<T extends { related_rubric_id: string }>(
  questions: T[] | null | undefined,
  idMap: Record<string, string>
): T[] {
  if (!Array.isArray(questions)) return [];
  return questions.map((question) => {
    const mapped = idMap[question.related_rubric_id];
    return mapped ? { ...question, related_rubric_id: mapped } : question;
  });
}

/**
 * Agent Tools for Grading
 *
 * Defines all tools available to the grading Agent for multi-step reasoning
 */

import { tool } from 'ai';
import { z } from 'zod';
import {
  SearchReferenceInputSchema,
  CheckSimilarityInputSchema,
  CalculateConfidenceInputSchema,
  GenerateFeedbackInputSchema,
} from '@/schemas/agent';
import type {
  ReferenceSearchResult,
  SimilarityCheckResult,
  ConfidenceScore,
  ReferenceDocument,
} from '@/types/agent';
import { db } from '@/lib/db.server';
import { redis } from '@/lib/redis';
import logger from '@/utils/logger';

// Tools moved to createAgentTools factory

interface AgentLocaleText {
  confidenceExtremelyHigh: string;
  confidenceGood: string;
  confidenceMedium: string;
  confidenceLow: string;
  issueCoverage: string;
  issueEvidence: string;
  issueAmbiguity: string;
  issuePrefix: string;
  noSpecificFeedback: string;
  priorityLabel: string;
  strengthsLabel: string;
  improvementsLabel: string;
  encouragementExcellent: string;
  encouragementGood: string;
  encouragementFair: string;
  encouragementNeedsWork: string;
  defaultOverallGood: string;
  defaultOverallNeedsWork: string;
  totalScorePrefix: string;
  missingSparringQuestionsError: string;
  similarityNoIssue: string;
  similarityDetected: string;
}

function getAgentLocaleText(userLanguage?: string): AgentLocaleText {
  const isZh = (userLanguage || 'zh-TW').startsWith('zh');

  if (isZh) {
    return {
      confidenceExtremelyHigh: '信心度極高，評分證據充分且標準明確',
      confidenceGood: '信心度良好，評分基本可靠',
      confidenceMedium: '信心度中等，建議人工審核以確保準確性',
      confidenceLow: '信心度偏低，強烈建議人工審核',
      issueCoverage: '部分評分標準未完全涵蓋',
      issueEvidence: '證據品質不夠充分',
      issueAmbiguity: '評分標準存在模糊性',
      issuePrefix: '。問題：',
      noSpecificFeedback: '無具體回饋',
      priorityLabel: '優先改進',
      strengthsLabel: '優點',
      improvementsLabel: '改進建議',
      encouragementExcellent: '表現優異！繼續保持！',
      encouragementGood: '整體表現良好，仍有進步空間。',
      encouragementFair: '表現尚可，建議加強以下方面的學習。',
      encouragementNeedsWork: '建議重新檢視作業要求，並針對評分標準逐項改進。',
      defaultOverallGood: '整體表現良好，仍有進步空間。',
      defaultOverallNeedsWork: '建議重新檢視作業要求，並針對評分標準逐項改進。',
      totalScorePrefix: '總分',
      missingSparringQuestionsError: `MISSING REQUIRED FIELD: sparringQuestions.
You MUST provide at least 1 challenging "sparring question" based on your grading.
This is a mandatory requirement. Please retry and include the 'sparringQuestions' array.`,
      similarityNoIssue: '未發現異常相似',
      similarityDetected: '發現 {{count}} 份高相似度作業（≥{{threshold}}%），建議人工確認是否為抄襲',
    };
  }

  return {
    confidenceExtremelyHigh: 'Confidence is very high; evidence is sufficient and rubric alignment is clear.',
    confidenceGood: 'Confidence is good; the grading result is generally reliable.',
    confidenceMedium: 'Confidence is moderate; human review is recommended for accuracy.',
    confidenceLow: 'Confidence is low; human review is strongly recommended.',
    issueCoverage: 'Some rubric criteria were not fully covered',
    issueEvidence: 'Evidence quality is not strong enough',
    issueAmbiguity: 'Rubric criteria contain ambiguity',
    issuePrefix: '. Issues: ',
    noSpecificFeedback: 'No specific feedback provided',
    priorityLabel: 'Top Priority',
    strengthsLabel: 'Strengths',
    improvementsLabel: 'Suggestions for Improvement',
    encouragementExcellent: 'Excellent work. Keep it up!',
    encouragementGood: 'Overall performance is good, with room to improve.',
    encouragementFair: 'The work is acceptable, but targeted improvement is recommended.',
    encouragementNeedsWork: 'Please review the assignment requirements and improve each rubric area step by step.',
    defaultOverallGood: 'Overall performance is good, with room to improve.',
    defaultOverallNeedsWork: 'Please review the assignment requirements and improve each rubric area step by step.',
    totalScorePrefix: 'Total Score',
    missingSparringQuestionsError: `MISSING REQUIRED FIELD: sparringQuestions.
You MUST provide at least 1 challenging "sparring question" based on your grading.
This is a mandatory requirement. Please retry and include the 'sparringQuestions' array.`,
    similarityNoIssue: 'No unusual similarity detected',
    similarityDetected: 'Detected {{count}} high-similarity submissions (≥{{threshold}}%). Manual plagiarism review is recommended.',
  };
}


/**
 * Tool 5: Calculate Confidence
 * 計算評分的信心度分數
 */
function createCalculateConfidenceTool(isZh: boolean, localeText: AgentLocaleText) {
  return tool({
    description: isZh
      ? `計算 AI 對評分結果的信心度。

  此工具會：
  1. 評估 rubric 覆蓋率（是否所有標準都有評到）
  2. 評估證據品質（high/medium/low）
  3. 評估標準的模糊程度
  4. 綜合計算 0-1 的信心度分數
  5. 決定是否需要人工審核（< 0.7）

  使用時機：評分完成後，評估結果的可靠性。`
      : `Calculate confidence for the grading result.

  This tool will:
  1. Evaluate rubric coverage
  2. Evaluate evidence quality (high/medium/low)
  3. Evaluate rubric ambiguity
  4. Compute a weighted confidence score between 0 and 1
  5. Determine whether human review is needed (< 0.7)

  Use this after grading to assess reliability.`,

    inputSchema: CalculateConfidenceInputSchema,

    execute: async ({
      rubricCoverage,
      evidenceQuality,
      criteriaAmbiguity,
    }: {
      rubricCoverage: number;
      evidenceQuality: 'high' | 'medium' | 'low';
      criteriaAmbiguity: number;
    }): Promise<ConfidenceScore> => {
      const evidenceScore = ({
        high: 1.0,
        medium: 0.7,
        low: 0.4,
      } as Record<'high' | 'medium' | 'low', number>)[evidenceQuality];

      const confidenceScore =
        rubricCoverage * 0.4 +
        evidenceScore * 0.4 +
        (1 - criteriaAmbiguity) * 0.2;

      const shouldReview = confidenceScore < 0.7;

      let reason = '';
      if (confidenceScore >= 0.85) {
        reason = localeText.confidenceExtremelyHigh;
      } else if (confidenceScore >= 0.7) {
        reason = localeText.confidenceGood;
      } else if (confidenceScore >= 0.5) {
        reason = localeText.confidenceMedium;
      } else {
        reason = localeText.confidenceLow;
      }

      const issues: string[] = [];
      if (rubricCoverage < 0.9) issues.push(localeText.issueCoverage);
      if (evidenceQuality !== 'high') issues.push(localeText.issueEvidence);
      if (criteriaAmbiguity > 0.3) issues.push(localeText.issueAmbiguity);

      if (issues.length > 0) {
        reason += `${localeText.issuePrefix}${issues.join(isZh ? '、' : '; ')}`;
      }

      logger.debug({
        confidenceScore,
        shouldReview,
        factors: { rubricCoverage, evidenceQuality, criteriaAmbiguity },
      }, '[Agent Tool] Confidence calculated');

      return {
        confidenceScore,
        shouldReview,
        reason,
        factors: {
          rubricCoverage,
          evidenceQuality,
          criteriaAmbiguity,
        },
      };
    },
  });
}

/**
 * Tool 6: Generate Feedback
 * 生成結構化的評分反饋
 */
function createGenerateFeedbackTool(isZh: boolean, localeText: AgentLocaleText) {
  return tool({
    description: isZh
      ? `根據各項評分標準的分數和證據，生成結構化的評分反饋。

  ⚠️ **重要：以下欄位為必填！**

  1. **overallFeedback** - 給學生的整體回饋【必填！】：
     - 2-4 句話，語氣溫暖像班導師
     - 包含：整體表現、最大優點、最需改進點、鼓勵語
     - 這直接顯示在評分結果頁面，不能為空

  2. **reasoning** - 完整的評分推理過程：
     - 對每個評分項目的逐項分析
     - 引用學生原文作為證據（用「」標示）
     - 解釋為什麼給這個分數
     - 指出優點和可改進之處

  3. **sparringQuestions** - 對練問題【必填！生成 3 個】：
     - 生成 3 個挑戰性問題
     - 選擇學生表現最弱的評分維度
     - 必須包含：related_rubric_id, target_quote, provocation_strategy, question, ai_hidden_reasoning
     - 這是系統核心功能，缺少會導致錯誤

  此工具會：
  1. 保存你的評分推理過程
  2. 彙總各項評分標準的分數
  3. 整合各項反饋
  4. 生成整體評語
  5. 計算總分
  6. 生成對練問題供學生反思

  使用時機：完成所有評分標準的評分後，生成最終結果。`
      : `Generate structured grading feedback from rubric scores and evidence.

  ⚠️ **Required fields**
  1. **overallFeedback** (required): 2-4 warm, student-facing sentences
  2. **reasoning**: detailed teacher-facing grading rationale
  3. **sparringQuestions** (required): 3 reflective challenge questions

  Use this tool after all rubric-level judgments are complete.`,

    inputSchema: GenerateFeedbackInputSchema,

    execute: async ({
      reasoning,
      criteriaScores,
      overallObservation,
      overallFeedback: directOverallFeedback,
      strengths,
      improvements,
      messageToStudent,
      topPriority,
      encouragement,
      sparringQuestions,
    }) => {
      logger.info(`🎯 [Agent Tool] generate_feedback called - sparringQuestions: ${sparringQuestions ? `YES (${sparringQuestions.length})` : 'NO/UNDEFINED'}`);
      if (sparringQuestions && sparringQuestions.length > 0) {
        logger.info(`🎯 [Agent Tool] sparringQuestions[0]: ${JSON.stringify(sparringQuestions[0]).substring(0, 300)}`);
      }

      const buildFallbackSparringQuestions = () => {
        const weakestCriteria = [...criteriaScores]
          .sort((a, b) => {
            const aRatio = a.maxScore > 0 ? a.score / a.maxScore : 1;
            const bRatio = b.maxScore > 0 ? b.score / b.maxScore : 1;
            return aRatio - bRatio;
          })
          .slice(0, 3);

        const baseQuestions = weakestCriteria.map((c, idx) => {
          const quote = c.evidence?.trim() || (isZh ? '文中未提供可引用句子。' : 'No direct quote available from submission.');
          const question = isZh
            ? `你在「${c.name}」這一項目前得分是 ${c.score}/${c.maxScore}。如果你要把這段內容修到更高層次，你會先改哪一句，為什麼？`
            : `Your score for "${c.name}" is ${c.score}/${c.maxScore}. If you revise this part to a higher level, which sentence would you change first, and why?`;

          return {
            related_rubric_id: c.criteriaId,
            target_quote: quote,
            provocation_strategy: idx === 0 ? 'logic_gap' : idx === 1 ? 'evidence_check' : 'metacognitive',
            question,
            ai_hidden_reasoning: isZh
              ? `系統自動生成：此維度相對較弱（${c.score}/${c.maxScore}），用於確保對練流程不中斷。`
              : `Auto-generated fallback: this criterion is relatively weak (${c.score}/${c.maxScore}) to keep sparring flow available.`,
          };
        });

        while (baseQuestions.length < 3) {
          baseQuestions.push({
            related_rubric_id: weakestCriteria[0]?.criteriaId || 'general',
            target_quote: isZh ? '請回到你的作業內容，選一段最想強化的段落。' : 'Please return to your submission and choose one paragraph you most want to improve.',
            provocation_strategy: 'metacognitive',
            question: isZh
              ? '若要讓你的觀點更有說服力，你會補哪一個證據或反例？'
              : 'To make your claim more convincing, which evidence or counterexample would you add?',
            ai_hidden_reasoning: isZh
              ? '系統補齊題目數量，避免評分流程因格式不完整中斷。'
              : 'System-added filler item to avoid workflow interruption due to incomplete format.',
          });
        }

        return baseQuestions;
      };

      const safeSparringQuestions =
        sparringQuestions && sparringQuestions.length > 0
          ? sparringQuestions
          : buildFallbackSparringQuestions();

      if (!sparringQuestions || sparringQuestions.length === 0) {
        logger.warn('[Agent Tool] Missing sparringQuestions; using auto-generated fallback questions');
      }

      const sanitizedCriteriaScores = criteriaScores.map((c) => {
        const safeMaxScore = Number.isFinite(c.maxScore) && c.maxScore > 0 ? c.maxScore : 0;
        const rawScore = Number.isFinite(c.score) ? c.score : 0;
        const safeScore = Math.max(0, Math.min(rawScore, safeMaxScore));

        return {
          ...c,
          score: safeScore,
          maxScore: safeMaxScore,
        };
      });

      const totalScore = sanitizedCriteriaScores.reduce((sum: number, c: { score: number }) => sum + c.score, 0);
      const maxScore = sanitizedCriteriaScores.reduce((sum: number, c: { maxScore: number }) => sum + c.maxScore, 0);
      const percentage = maxScore > 0 ? Math.min(100, (totalScore / maxScore) * 100) : 0;

      const breakdown = sanitizedCriteriaScores.map((c) => {
        let feedback = '';

        if (c.analysis) {
          feedback = c.analysis;
        } else if (c.justification) {
          feedback = c.justification;
        }

        if (c.evidence && feedback) {
          feedback += isZh ? `\n\n**引用原文：**\n「${c.evidence}」` : `\n\n**Evidence Quote:**\n"${c.evidence}"`;
        } else if (c.evidence && !feedback) {
          feedback = isZh ? `「${c.evidence}」` : `"${c.evidence}"`;
        }

        return {
          criteriaId: c.criteriaId,
          name: c.name,
          score: c.score,
          // 模型自己的分數尺度；agent-executor 會據此把分數換算成 rubric 的 maxScore
          maxScore: c.maxScore,
          feedback: feedback || localeText.noSpecificFeedback,
        };
      });

      let overallFeedback = (directOverallFeedback || messageToStudent || overallObservation || '').trim();

      if (topPriority) {
        overallFeedback += `\n\n**${localeText.priorityLabel}:**\n${topPriority}`;
      }

      if (strengths && strengths.length > 0) {
        overallFeedback += `\n\n**${localeText.strengthsLabel}:**\n${strengths.map((s: string) => `- ${s}`).join('\n')}`;
      }

      if (improvements && improvements.length > 0) {
        overallFeedback += `\n\n**${localeText.improvementsLabel}:**\n${improvements.map((i: string) => `- ${i}`).join('\n')}`;
      }

      if (encouragement?.trim()) {
        overallFeedback += `\n\n${encouragement.trim()}`;
      } else if (percentage >= 90) {
        overallFeedback += `\n\n${localeText.encouragementExcellent}`;
      } else if (percentage >= 70) {
        overallFeedback += `\n\n${localeText.encouragementGood}`;
      } else if (percentage >= 50) {
        overallFeedback += `\n\n${localeText.encouragementFair}`;
      } else {
        overallFeedback += `\n\n${localeText.encouragementNeedsWork}`;
      }

      const finalOverallFeedback =
        overallFeedback.trim() || (percentage >= 70 ? localeText.defaultOverallGood : localeText.defaultOverallNeedsWork);

      const combinedVisibleText = [
        finalOverallFeedback,
        ...breakdown.map((item) => item.feedback || ''),
      ].join('\n');
      const cjkCount = (combinedVisibleText.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
      const alphaCount = (combinedVisibleText.match(/[A-Za-z]/g) || []).length;
      const visibleCount = cjkCount + alphaCount;
      const cjkRatio = visibleCount > 0 ? cjkCount / visibleCount : 0;
      const alphaRatio = visibleCount > 0 ? alphaCount / visibleCount : 0;

      if (isZh) {
        if (visibleCount >= 80 && cjkRatio < 0.4) {
          throw new Error('LANGUAGE_MISMATCH: feedback fields must be predominantly Traditional Chinese when UI language is zh.');
        }
      } else if (visibleCount >= 80 && (cjkRatio > 0.15 || alphaRatio < 0.5)) {
        throw new Error('LANGUAGE_MISMATCH: feedback fields must be English when UI language is non-zh.');
      }

      logger.debug({
        totalScore,
        maxScore,
        percentage: percentage.toFixed(1),
        hasReasoning: !!reasoning,
        reasoningLength: reasoning?.length || 0,
        sparringQuestionsCount: safeSparringQuestions.length,
      }, '[Agent Tool] Feedback generated');

      return {
        reasoning,
        breakdown,
        overallFeedback: finalOverallFeedback,
        totalScore,
        maxScore,
        percentage: Math.round(percentage),
        summary: `${localeText.totalScorePrefix}: ${totalScore}/${maxScore} (${percentage.toFixed(1)}%)`,
        sparringQuestions: safeSparringQuestions,
      };
    },
  });
}

/**
 * Tool: Evaluate Subtrait (Phase 1) - DEPRECATED/REMOVED
 * 評估單一子面向
 */
// export const evaluateSubtraitTool = ... (Removed for efficiency)

/**
 * Tool: Match to Level (Phase 2) - DEPRECATED/REMOVED
 * 對照 Rubric Level 給分
 */
// export const matchToLevelTool = ... (Removed for efficiency)


/**
 * All Agent tools collection
 */
export const createAgentTools = (context: {
  referenceDocuments?: ReferenceDocument[];
  currentContent: string;
  assignmentType?: string;
  sessionId?: string;
  userLanguage?: string;
}) => {
  const isZh = (context.userLanguage || 'zh-TW').startsWith('zh');
  const localeText = getAgentLocaleText(context.userLanguage);

  const hasCjk = (text: string): boolean => /[\u3400-\u9FFF\uF900-\uFAFF]/.test(text);
  const countCjk = (text: string): number => (text.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
  const countAlpha = (text: string): number => (text.match(/[A-Za-z]/g) || []).length;
  const countVisibleLetters = (text: string): number => (text.match(/[A-Za-z\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;

  const searchReferenceTool = tool({
    description: `搜尋參考文件中與學生作業相關的內容。

  此工具會：
  1. 在參考文件中搜尋相關段落
  2. 計算相關度分數
  3. 返回最相關的前 N 個結果

  使用時機：需要根據課程講義或參考資料進行評分時。`,

    inputSchema: SearchReferenceInputSchema.omit({ referenceDocuments: true }),

    execute: async ({
      query,
      topK = 3,
    }: any): Promise<ReferenceSearchResult> => {
      const { referenceDocuments } = context;
      if (!referenceDocuments || referenceDocuments.length === 0) {
        return {
          foundReferences: [],
          totalMatches: 0,
          searchQuery: query,
        };
      }

      // 簡單的關鍵字搜尋 + TF-IDF style scoring
      const queryTerms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((t: string) => t.length > 2);

      const results = referenceDocuments
        .map((doc: any) => {
          const content = doc.content.toLowerCase();
          let relevanceScore = 0;

          // 計算每個查詢詞的出現頻率
          queryTerms.forEach((term: string) => {
            const count = (content.match(new RegExp(term, 'g')) || []).length;
            relevanceScore += count;
          });

          // 正規化分數（0-1）
          relevanceScore = Math.min(relevanceScore / (queryTerms.length * 5), 1);

          // 提取摘要（包含關鍵字的段落）
          let excerpt = '';
          const firstMatch = queryTerms.find((term: string) => content.includes(term));
          if (firstMatch) {
            const index = content.indexOf(firstMatch);
            const start = Math.max(0, index - 100);
            const end = Math.min(content.length, index + 400);
            excerpt = doc.content.substring(start, end);
          } else {
            excerpt = doc.content.substring(0, 500);
          }

          return {
            fileName: doc.fileName,
            content: doc.content,
            relevanceScore,
            excerpt: excerpt.trim(),
          };
        })
        .filter((r: any) => r.relevanceScore > 0.1) // Filter out low relevance
        .sort((a: any, b: any) => b.relevanceScore - a.relevanceScore)
        .slice(0, topK);

      logger.debug({
        query,
        totalDocuments: referenceDocuments.length,
        foundMatches: results.length,
      }, '[Agent Tool] Reference search completed');

      return {
        foundReferences: results,
        totalMatches: results.length,
        searchQuery: query,
      };
    },
  });

  const checkSimilarityTool = tool({
    description: `檢查學生作業與歷史提交的相似度，偵測可能的抄襲。

  此工具會：
  1. 與同一作業區的歷史提交比對
  2. 計算文字相似度
  3. 標記高相似度案例

  使用時機：懷疑作業可能有抄襲時，或作為標準檢查流程。`,

    inputSchema: CheckSimilarityInputSchema.omit({ currentSubmission: true }),

    execute: async ({
      assignmentAreaId,
      threshold = 0.8,
    }: any): Promise<SimilarityCheckResult> => {
      const { currentContent: currentSubmission } = context;
      try {
        // 從資料庫取得同作業區的已評分提交（排除當前提交）
        const historicalSubmissions = await db.submission.findMany({
          where: {
            assignmentAreaId,
            status: {
              in: ['ANALYZED', 'GRADED'],
            },
          },
          select: {
            id: true,
            filePath: true,
            student: {
              select: {
                name: true,
              },
            },
          },
          take: 20, // 最多檢查 20 份
        });

        if (historicalSubmissions.length === 0) {
          return {
            hasSuspiciousSimilarity: false,
            matches: [],
            recommendation: '無歷史作業可比對',
            checked: 0,
          };
        }

        // 簡化的相似度計算（Jaccard similarity on word sets）
        const calculateSimilarity = (text1: string, text2: string): number => {
          const words1 = new Set(
            text1
              .toLowerCase()
              .split(/\s+/)
              .filter((w) => w.length > 3)
          );
          const words2 = new Set(
            text2
              .toLowerCase()
              .split(/\s+/)
              .filter((w) => w.length > 3)
          );

          const intersection = new Set([...words1].filter((w) => words2.has(w)));
          const union = new Set([...words1, ...words2]);

          return union.size > 0 ? intersection.size / union.size : 0;
        };

        const similarities = historicalSubmissions
          .map((sub: any) => ({
            submissionId: sub.id,
            studentName: sub.student.name,
            similarity: calculateSimilarity(currentSubmission, sub.filePath || ''),
          }))
          .filter((s: any) => s.similarity >= threshold)
          .sort((a: any, b: any) => b.similarity - a.similarity);

        const hasSuspiciousSimilarity = similarities.length > 0;

        let recommendation = localeText.similarityNoIssue;
        if (similarities.length > 0) {
          recommendation = localeText.similarityDetected
            .replace('{{count}}', String(similarities.length))
            .replace('{{threshold}}', (threshold * 100).toFixed(0));
        }

        logger.info({
          assignmentAreaId,
          checked: historicalSubmissions.length,
          suspicious: similarities.length,
        }, '[Agent Tool] Similarity check completed');

        return {
          hasSuspiciousSimilarity,
          matches: similarities.slice(0, 5), // Top 5
          recommendation,
          checked: historicalSubmissions.length,
        };
      } catch (error) {
        logger.error({ error }, '[Agent Tool] Similarity check failed');
        return {
          hasSuspiciousSimilarity: false,
          matches: [],
          recommendation: isZh ? '相似度檢查失敗' : 'Similarity check failed',
          checked: 0,
        };
      }
    },
  });

  // Tool: Think Aloud - Hattie & Timperley Framework
  const thinkAloudTool = tool({
    description: isZh
      ? `請使用 Hattie & Timperley「三個問題（Three Questions）」框架分析作業。
    這必須是評分流程的第一步。
    
    【語言規範】思考過程必須使用繁體中文（可保留必要專有名詞），不可輸出英文整句。
    
    **格式**：請使用 Markdown 並清楚分段：
    
    ## Feed Up（學習目標）
    說明本作業的學習目標與評量期待。
    
    ## Feed Back（目前表現）
    依據學生原文證據，評估目前表現。
    
    ## Feed Forward（下一步）
    提出可執行的改進方向。
    
    ## Strategy（評分策略）
    根據以上分析，定義接下來的評分策略。
    
    你的分析會即時串流給使用者。`
      : `Analyze the submission using Hattie & Timperley's "Three Questions" framework.
    This MUST be the first step in your grading process.

    [Language Rule] The full thinking process must be in English. Do not output Chinese sentences (except unavoidable proper nouns or direct quotes).
    
    **FORMAT**: Use Markdown formatting with clear sections:
    
    ## Feed Up: Where am I going? (the goals)
    Analyze the learning goals and expectations for this assignment.
    
    ## Feed Back: How am I going?
    Evaluate the student's current performance with specific evidence.
    
    ## Feed Forward: Where to next?
    Identify actionable next steps for improvement.
    
    ## Strategy
    Define your grading approach based on the analysis above.
    
    Your analysis will be streamed live to the user.`,

    inputSchema: z.object({
      analysis: z.string().describe(isZh
        ? `請用繁體中文完成結構化分析（可保留必要專有名詞），使用 Hattie & Timperley 框架。

請使用以下格式：

## Feed Up（學習目標）
[本作業的學習目標是什麼？]

## Feed Back（目前表現）
[學生目前表現如何？請引用具體原文證據]

## Feed Forward（下一步）
[下一步可執行的改進是什麼？]

## Strategy（評分策略）
[你的評分策略]

請使用 Markdown 讓內容清楚可讀。`
        : `Complete structured analysis using the Hattie & Timperley framework in English.

Use this format:

## Feed Up
[What are the learning goals?]

## Feed Back  
[How is the student performing? Use specific evidence from their work]

## Feed Forward
[What are the next steps?]

## Strategy
[Your grading approach]

Use Markdown formatting for clarity.`)
    }),

    execute: async ({ analysis }: { analysis: string }) => {
      const cjkCount = countCjk(analysis);
      const alphaCount = countAlpha(analysis);
      const visibleCount = countVisibleLetters(analysis);
      const cjkRatio = visibleCount > 0 ? cjkCount / visibleCount : 0;
      const alphaRatio = visibleCount > 0 ? alphaCount / visibleCount : 0;

      if (isZh) {
        if (!hasCjk(analysis)) {
          throw new Error('LANGUAGE_MISMATCH: think_aloud must be Traditional Chinese when UI language is zh.');
        }
        if (visibleCount >= 60 && cjkRatio < 0.5) {
          throw new Error('LANGUAGE_MISMATCH: think_aloud must be predominantly Traditional Chinese when UI language is zh.');
        }
      } else if (visibleCount >= 60 && (cjkRatio > 0.2 || alphaRatio < 0.5)) {
        throw new Error('LANGUAGE_MISMATCH: think_aloud must be English when UI language is non-zh.');
      }

      // Stream thinking to frontend via Redis (same as thinkTool)
      if (context.sessionId && analysis) {
        try {
          await redis.publish(
            `session:${context.sessionId}`,
            JSON.stringify({
              type: 'text-delta',
              content: analysis,
            })
          );
          
          logger.info({
            analysisLength: analysis.length,
            sessionId: context.sessionId
          }, '[Agent ThinkAloud] Streaming analysis via tool');
        } catch (error) {
          logger.error({ err: error }, '[Agent ThinkAloud] Failed to publish analysis');
        }
      }

      return {
        acknowledged: true,
        message: isZh
          ? '框架分析已記錄。請繼續計算信心度並生成最終回饋。'
          : 'Framework analysis recorded. Proceed to calculate confidence and generate feedback.'
      };
    },
  });

  // Tool: Think (Inspired by Anthropic's Extended Thinking)
  // This allows model to explicitly output thinking before taking action
  const thinkTool = tool({
    description: `Use this tool to think through the grading task step-by-step BEFORE calling other tools.
    
    **MANDATORY FIRST STEP**: You MUST call this tool first to analyze the submission.
    
    Your thinking should include:
    1. Initial impression of the student's work
    2. Item-by-item comparison with the Rubric
    3. Evidence from the student's text (quote specific sentences)
    4. Your reasoning for each score
    
    This thinking process will be streamed live to the user, showing your professional analysis.
    
    **After thinking, then call calculate_confidence and generate_feedback.**`,

    inputSchema: z.object({
      thought: z.string().describe('Your detailed step-by-step thinking and analysis process. Be thorough and quote evidence from the student work.')
    }),

    execute: async ({ thought }: { thought: string }) => {
      const cjkCount = countCjk(thought);
      const alphaCount = countAlpha(thought);
      const visibleCount = countVisibleLetters(thought);
      const cjkRatio = visibleCount > 0 ? cjkCount / visibleCount : 0;
      const alphaRatio = visibleCount > 0 ? alphaCount / visibleCount : 0;

      if (isZh) {
        if (!hasCjk(thought)) {
          throw new Error('LANGUAGE_MISMATCH: think must be Traditional Chinese when UI language is zh.');
        }
        if (visibleCount >= 60 && cjkRatio < 0.5) {
          throw new Error('LANGUAGE_MISMATCH: think must be predominantly Traditional Chinese when UI language is zh.');
        }
      } else if (visibleCount >= 60 && (cjkRatio > 0.2 || alphaRatio < 0.5)) {
        throw new Error('LANGUAGE_MISMATCH: think must be English when UI language is non-zh.');
      }

      // Stream thinking to frontend via Redis
      if (context.sessionId && thought) {
        try {
          await redis.publish(
            `session:${context.sessionId}`,
            JSON.stringify({
              type: 'text-delta',
              content: thought,
            })
          );
          
          logger.info({
            thoughtLength: thought.length,
            sessionId: context.sessionId
          }, '[Agent Think] Streaming thinking via tool');
        } catch (error) {
          logger.error({ err: error }, '[Agent Think] Failed to publish thinking');
        }
      }

      return {
        acknowledged: true,
        message: isZh
          ? '思考過程已記錄。請繼續計算信心度並生成最終回饋。'
          : 'Thinking process recorded. Proceed to calculate confidence and generate feedback.'
      };
    },
  });

  return {
    // think: thinkTool,  // Temporarily disabled for testing
    think_aloud: thinkAloudTool,  // Testing Hattie & Timperley framework
    search_reference: searchReferenceTool,
    check_similarity: checkSimilarityTool,
    calculate_confidence: createCalculateConfidenceTool(isZh, localeText),
    generate_feedback: createGenerateFeedbackTool(isZh, localeText),
    // evaluate_subtrait: evaluateSubtraitTool, // Removed for efficiency
    // match_to_level: matchToLevelTool, // Removed for efficiency
  };
};

export type AgentToolName = keyof ReturnType<typeof createAgentTools>;

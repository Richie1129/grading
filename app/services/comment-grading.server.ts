import { db } from '@/lib/db.server';
import { getAIGrader } from './ai-grader.server';
import { GeminiCacheManager } from '@/services/gemini-cache.server';
import { gradeWithAI, convertToLegacyFormat, isAISDKGradingEnabled } from './ai-grader-sdk.server';
import { getModelNameForProvider } from './ai-sdk-provider.server';
import { GeminiPrompts } from './gemini-prompts.server';
import { extractOverallFeedback } from '@/utils/grading-helpers';
import {
  parseRubricCriteria,
  flattenCategoriesToCriteria,
  type DbCriterion,
} from '@/schemas/rubric-data';
import logger from '@/utils/logger';

/**
 * Comment Grading Service
 * Grades community post comments (reflection assignments) using AI
 */

export interface GradeCommentResult {
  success: boolean;
  error?: string;
  result?: {
    totalScore: number;
    maxScore: number;
    normalizedScore: number;
    overallFeedback: string;
    breakdown: Array<{
      criteriaId: string;
      criteriaName: string;
      score: number;
      maxScore: number;
      feedback: string;
    }>;
  };
  gradingResultId?: string;
  thoughtSummary?: string | null;
  createdAt?: string | Date;
}

/**
 * Grade a community comment using the post's linked assignment rubric
 */
export async function gradeComment(
  commentId: string,
  graderId: string,
  options?: {
    rubricId?: string; // Override rubric if provided
    userLanguage?: 'zh' | 'en';
  }
): Promise<GradeCommentResult> {
  const startTime = Date.now();
  const userLanguage = options?.userLanguage || 'en';

  try {
    logger.info(`📝 [Comment Grading] Starting grading for comment ${commentId}`);

    // 1. Fetch comment with post and assignment info
    const comment = await db.coursePostComment.findUnique({
      where: { id: commentId },
      include: {
        post: {
          include: {
            rubric: true, // Direct rubric link
            assignmentArea: {
              include: {
                rubric: true,
              },
            },
          },
        },
        author: {
          select: { id: true, name: true, email: true },
        },
        gradingResult: true, // Check if already graded
      },
    });

    if (!comment) {
      return { success: false, error: 'Comment not found' };
    }

    if (comment.isDeleted) {
      return { success: false, error: 'Comment has been deleted' };
    }

    // 2. Determine rubric to use (priority: explicit > post.rubric > assignmentArea.rubric)
    let rubricId = options?.rubricId;
    let rubric;

    if (rubricId) {
      rubric = await db.rubric.findUnique({ where: { id: rubricId } });
    } else if (comment.post.rubric) {
      // Direct rubric link on post (new method)
      rubric = comment.post.rubric;
      rubricId = rubric.id;
    } else if (comment.post.assignmentArea?.rubric) {
      // Legacy: via assignmentArea
      rubric = comment.post.assignmentArea.rubric;
      rubricId = rubric.id;
    }

    if (!rubric) {
      return { success: false, error: 'No rubric found for grading. Please select a rubric when creating the assignment post.' };
    }

    // 3. Parse rubric criteria
    let criteria: DbCriterion[];
    try {
      const rubricData = parseRubricCriteria(rubric.criteria);
      if (rubricData && rubricData.length > 0) {
        const firstItem = rubricData[0];
        if (firstItem && 'criteria' in firstItem && Array.isArray((firstItem as any).criteria)) {
          criteria = flattenCategoriesToCriteria(rubricData);
        } else {
          criteria = rubricData as any as DbCriterion[];
        }
      } else {
        criteria = [];
      }
    } catch (error) {
      return { success: false, error: 'Invalid rubric format' };
    }

    if (criteria.length === 0) {
      return { success: false, error: 'No grading criteria found in rubric' };
    }

    // 4. Fetch attachment content (if any)
    let referenceContent = '';
    const postAttachments = comment.post.attachments as Array<{ fileId: string; fileName: string }> | null;
    
    if (postAttachments && postAttachments.length > 0) {
      logger.info(`📎 [Comment Grading] Fetching ${postAttachments.length} attachment(s) for context`);
      
      const attachmentContents: string[] = [];
      for (const att of postAttachments) {
        try {
          const file = await db.uploadedFile.findUnique({
            where: { id: att.fileId },
            select: { parsedContent: true, fileName: true, parseStatus: true },
          });
          
          if (file?.parsedContent) {
            attachmentContents.push(`[附件: ${file.fileName}]\n${file.parsedContent.substring(0, 50000)}`); // Limit to 50k chars
            logger.info(`✅ Loaded content from ${file.fileName} (${file.parsedContent.length} chars)`);
          } else if (file?.parseStatus !== 'COMPLETED') {
            logger.warn(`⚠️ Attachment ${att.fileName} not yet parsed`);
          }
        } catch (err) {
          logger.warn({ err: err }, `⚠️ Failed to fetch attachment ${att.fileId}:`);
        }
      }
      
      if (attachmentContents.length > 0) {
        referenceContent = attachmentContents.join('\n\n---\n\n');
      }
    }

    // 5. Prepare grading request
    const referenceDocuments = referenceContent
      ? postAttachments!.map((att, idx) => ({
          fileId: att.fileId,
          fileName: att.fileName,
          content: referenceContent.split('\n\n---\n\n')[idx] || '',
          wasTruncated: referenceContent.length > 50000,
        }))
      : undefined;

    const gradingRequest = {
      content: comment.content,
      criteria: criteria,
      fileName: `comment-${comment.id}`,
      rubricName: rubric.name,
      assignmentTitle: comment.post.assignmentArea?.name || comment.post.title,
      assignmentDescription: comment.post.assignmentArea?.description || comment.post.content,
      referenceDocuments, // Include parsed attachment content for AI context
    };

    // 5. Generate prompt and call AI
    // Use split prompt to support Context Caching if available
    const splitPrompt = GeminiPrompts.generateSplitGradingPrompt(gradingRequest);
    const fullPrompt = `${splitPrompt.cachedContent}\n\n${splitPrompt.userPrompt}`;
    
    // Calculate context hash for caching
    const contextContent = splitPrompt.cachedContent;
    // We include systemInstruction in the hash so that prompt updates invalidate the cache
    const contextHash = GeminiCacheManager.hashContent(contextContent + splitPrompt.systemInstruction);

    const useAISDK = isAISDKGradingEnabled();

    let gradingResponse;

    if (useAISDK) {
      const sdkResult = await gradeWithAI({
        prompt: fullPrompt, // Fallback for non-caching providers (OpenAI)
        userId: graderId,
        resultId: `comment-${commentId}`,
        language: userLanguage,
        contextHash,
        contextContent,
        userPrompt: splitPrompt.userPrompt,
      });

      if (sdkResult.success) {
        const legacyFormat = convertToLegacyFormat(sdkResult.data);
        const totalScore = legacyFormat.breakdown.reduce((sum, item) => sum + item.score, 0);
        const maxScore = criteria.reduce((sum, c) => sum + (c.maxScore || 0), 0);

        gradingResponse = {
          success: true,
          result: {
            breakdown: legacyFormat.breakdown,
            totalScore,
            maxScore,
            overallFeedback: legacyFormat.overallFeedback,
          },
          thoughtSummary: sdkResult.thoughtSummary,
          provider: sdkResult.provider,
          metadata: {
            model: getModelNameForProvider(sdkResult.provider),
            tokens: sdkResult.usage.totalTokens,
            duration: sdkResult.responseTimeMs,
          },
        };
      } else {
        gradingResponse = { success: false, error: sdkResult.error };
      }
    } else {
      // Legacy grading
      const aiGrader = getAIGrader();
      gradingResponse = await aiGrader.grade(gradingRequest, userLanguage);
    }

    if (!gradingResponse.success || !gradingResponse.result) {
      return { success: false, error: gradingResponse.error || 'AI grading failed' };
    }

    // 6. Calculate normalized score
    const { totalScore, maxScore } = gradingResponse.result;
    const normalizedScore = maxScore > 0 ? Math.round((totalScore / maxScore) * 10000) / 100 : 0;
    const overallFeedback = extractOverallFeedback(gradingResponse.result) || '';
    const duration = Date.now() - startTime;

    // 7. Save or update grading result
    const gradingResultData = {
      graderId,
      rubricId: rubric.id,
      result: {
        totalScore,
        maxScore,
        breakdown: gradingResponse.result.breakdown || [],
        overallFeedback,
      },
      normalizedScore,
      thoughtSummary: gradingResponse.thoughtSummary,
      gradingModel: gradingResponse.provider || gradingResponse.metadata?.model,
      gradingTokens: gradingResponse.metadata?.tokens,
      gradingDuration: duration,
    };

    let savedResult;
    if (comment.gradingResult) {
      // Update existing result
      savedResult = await db.commentGradingResult.update({
        where: { id: comment.gradingResult.id },
        data: gradingResultData,
      });
    } else {
      // Create new result
      savedResult = await db.commentGradingResult.create({
        data: {
          commentId,
          ...gradingResultData,
        },
      });
    }

    logger.info({
      normalizedScore,
      duration,
      tokens: gradingResponse.metadata?.tokens,
    }, `✅ [Comment Grading] Completed for comment ${commentId}`);

    return {
      success: true,
      gradingResultId: savedResult.id,
      thoughtSummary: gradingResponse.thoughtSummary,
      createdAt: savedResult.createdAt,
      result: {
        totalScore,
        maxScore,
        normalizedScore,
        overallFeedback,
        breakdown: gradingResponse.result.breakdown.map((b: any) => ({
          criteriaId: b.criteriaId || b.id,
          criteriaName: b.name || criteria.find(c => c.id === b.criteriaId)?.name || 'Unknown',
          score: b.score,
          maxScore: criteria.find(c => c.id === b.criteriaId)?.maxScore || b.maxScore || 0,
          feedback: b.feedback || '',
        })),
      },
    };
  } catch (error) {
    logger.error({ err: error }, `❌ [Comment Grading] Failed for comment ${commentId}:`);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Comment grading failed',
    };
  }
}

/**
 * Get grading result for a comment
 */
export async function getCommentGradingResult(commentId: string) {
  return db.commentGradingResult.findUnique({
    where: { commentId },
    include: {
      grader: {
        select: { id: true, name: true, picture: true },
      },
      rubric: {
        select: { id: true, name: true },
      },
    },
  });
}

/**
 * Check if user can grade a comment (must be teacher of the course)
 */
export async function canGradeComment(userId: string, commentId: string): Promise<boolean> {
  const comment = await db.coursePostComment.findUnique({
    where: { id: commentId },
    include: {
      post: {
        include: {
          course: true,
        },
      },
    },
  });

  if (!comment) return false;

  // User must be the course teacher
  return comment.post.course.teacherId === userId;
}

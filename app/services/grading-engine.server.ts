import { db, GradingStatus, type Prisma } from '@/types/database';
import { getAIGrader } from './ai-grader.server';
import { gradeWithAI, convertToLegacyFormat, isAISDKGradingEnabled } from './ai-grader-sdk.server';
import { getModelNameForProvider, GEMINI_GRADING_MODEL } from './ai-sdk-provider.server';
import { SimpleProgressService } from './progress-simple.server';
import { loadReferenceDocuments, getCustomGradingInstructions } from './assignment-area.server';
import { getGradingLogger } from './grading-logger.server';
import { GeminiPrompts } from './gemini-prompts.server';
import logger from '@/utils/logger';
import {
  parseRubricCriteria,
  flattenCategoriesToCriteria,
  type DbCriterion,
} from '@/schemas/rubric-data';
import { extractOverallFeedback } from '@/utils/grading-helpers';
import { gradingQueue } from './queue.server';
import { GeminiCacheManager } from './gemini-cache.server';

/**
 * Simple grading engine - no fallback hell, no special cases
 * Follows Linus principle: solve real problems simply
 */
export async function processGradingResult(
  resultId: string,
  _userId: string,
  sessionId: string,
  userLanguage: 'zh' | 'en' = 'en',
  useDirectGrading: boolean = false
): Promise<{ success: boolean; error?: string }> {
  const startTime = Date.now();
  const isZh = userLanguage === 'zh';
  const gradingLogger = getGradingLogger();
  gradingLogger.initializeSessionLog(sessionId, resultId);

  try {
    logger.info(`Processing grading result: ${resultId}`);

    // Get result with required data
    const result = await db.gradingResult.findUnique({
      where: { id: resultId },
      include: {
        uploadedFile: true,
        rubric: true,
        gradingSession: {
          include: {
            user: true,
          },
        },
        assignmentArea: true,
      },
    });

    if (!result) {
      return { success: false, error: 'Grading result not found' };
    }

    // Log user information
    if (result.gradingSession?.user) {
      gradingLogger.addUserInfo(
        sessionId,
        result.gradingSession.user.id,
        result.gradingSession.user.email,
        result.gradingSession.user.role
      );
    }

    // Log assignment information
    if (result.assignmentArea) {
      gradingLogger.addAssignmentInfo(
        sessionId,
        result.assignmentArea.id,
        result.assignmentArea.name || 'Untitled Assignment'
      );
    }

    // Log file and rubric information
    if (result.uploadedFile) {
      gradingLogger.addFileInfo(
        sessionId,
        result.uploadedFileId,
        result.uploadedFile.originalFileName,
        `s3://${result.uploadedFile.fileKey}`
      );
    }

    if (result.rubric) {
      gradingLogger.addRubricInfo(
        sessionId,
        result.rubricId,
        result.rubric.name
      );
    }

    // Allow retries for FAILED or PROCESSING status (e.g., after throttle recovery)
    // Only skip if already COMPLETED or SKIPPED
    if (result.status === 'COMPLETED' || result.status === 'SKIPPED') {
      logger.info(`Grading result ${resultId} already processed with status: ${result.status}`);
      return { success: true }; // Already processed successfully
    }

    // Reset status to PENDING if it's FAILED or PROCESSING (retry scenario)
    if (result.status !== 'PENDING') {
      logger.info(`Resetting status from ${result.status} to PENDING for retry`);
      await db.gradingResult.update({
        where: { id: resultId },
        data: { status: 'PENDING', progress: 0 },
      });
    }

    // Type narrowing: explicit null checks so TypeScript knows fields are non-null
    if (!result.uploadedFile) {
      return { success: false, error: 'File not found' };
    }

    if (!result.uploadedFile.parsedContent || !result.uploadedFile.parsedContent.trim()) {
      const parseStatus = result.uploadedFile.parseStatus;
      const parseError = result.uploadedFile.parseError;
      const detailedError =
        parseStatus === 'FAILED' && parseError
          ? `File parsing failed: ${parseError}`
          : parseStatus === 'PROCESSING'
            ? 'File parsing is still in progress. Please retry in a moment.'
            : 'File has no parsed content';

      await db.gradingResult.update({
        where: { id: resultId },
        data: {
          status: 'FAILED',
          progress: 100,
          errorMessage: detailedError,
          completedAt: new Date(),
        },
      });

      return { success: false, error: 'File has no parsed content' };
    }

    if (!result.rubric || !result.rubric.name) {
      return { success: false, error: 'Rubric not found or has no name' };
    }

    if (!result.uploadedFile.originalFileName) {
      return { success: false, error: 'File has no name' };
    }

    // Update to processing
    await SimpleProgressService.updateGradingProgress(resultId, 10, 'PROCESSING');

    // Parse criteria - handle both old and new format
    let criteria: DbCriterion[];
    try {
      const rubricData = parseRubricCriteria(result.rubric.criteria);

      if (rubricData && rubricData.length > 0) {
        // Check if it's the new category format (categories with nested criteria)
        // DbRubricCriteria is (DbCategory | DbCriterion)[]
        const firstItem = rubricData[0];
        if (firstItem && 'criteria' in firstItem && Array.isArray((firstItem as any).criteria)) {
          // This is DbCategory format with nested criteria
          criteria = flattenCategoriesToCriteria(rubricData);
        } else {
          // Assume it's flat DbCriterion array
          criteria = rubricData as any as DbCriterion[];
        }
      } else {
        criteria = [];
      }
    } catch (error) {
      await db.gradingResult.update({
        where: { id: resultId },
        data: {
          status: 'FAILED',
          progress: 100,
          errorMessage: 'Invalid rubric format',
          completedAt: new Date(),
        },
      });
      return { success: false, error: 'Invalid rubric format' };
    }

    if (!Array.isArray(criteria) || criteria.length === 0) {
      await db.gradingResult.update({
        where: { id: resultId },
        data: {
          status: 'FAILED',
          progress: 100,
          errorMessage: 'No grading criteria found',
          completedAt: new Date(),
        },
      });
      return { success: false, error: 'No grading criteria found' };
    }

    // Update progress
    await SimpleProgressService.updateGradingProgress(resultId, 50);

    // Feature 004: Load context if assignmentAreaId is available
    let referenceDocuments: Array<{ fileId: string; fileName: string; content: string; wasTruncated: boolean }> = [];
    let customInstructions: string | null = null;

    if (result.assignmentAreaId) {
      try {
        logger.info(`📚 Loading context for assignment ${result.assignmentAreaId}`);
        referenceDocuments = await loadReferenceDocuments(result.assignmentAreaId);
        customInstructions = await getCustomGradingInstructions(result.assignmentAreaId);

        logger.info(
          `Loaded ${referenceDocuments.length} reference documents, custom instructions: ${customInstructions ? 'yes' : 'no'}`
        );

        // Log context information for Feature 004
        gradingLogger.addContextInfo(
          sessionId,
          referenceDocuments.map((doc) => ({
            fileId: doc.fileId,
            fileName: doc.fileName,
            contentLength: doc.content.length,
            wasTruncated: doc.wasTruncated,
          })),
          !!customInstructions,
          customInstructions?.length
        );
      } catch (error) {
        // Graceful degradation - log error but continue with grading
        logger.warn({ err: error }, `⚠️ Failed to load context for assignment ${result.assignmentAreaId}:`);
        // Log context loading failure
        gradingLogger.addError(sessionId, 'Context loading', error instanceof Error ? error.message : String(error));
      }
    }

    // Grade with AI - check feature flags
    const useAgentGrading = process.env.USE_AGENT_GRADING === 'true';
    const useAISDK = isAISDKGradingEnabled();

    logger.info(`🤖 Using ${useAgentGrading ? 'Agent' : useAISDK ? 'AI SDK' : 'Legacy'} grading system`);

    // Log prompt information for complete traceability
    const gradingRequest = {
      content: result.uploadedFile.parsedContent,
      criteria: criteria,
      fileName: result.uploadedFile.originalFileName,
      rubricName: result.rubric.name,
      language: userLanguage,

      // options field
      ...(referenceDocuments.length > 0 && { referenceDocuments }),
      ...(customInstructions && { customInstructions }),
      assignmentTitle: result.assignmentArea?.name || 'Untitled Assignment',
      assignmentDescription: result.assignmentArea?.description || undefined,
    };

    logger.info({
      hasAssignmentArea: !!result.assignmentArea,
      assignmentTitle: gradingRequest.assignmentTitle,
      assignmentDescriptionLength: gradingRequest.assignmentDescription?.length || 0,
    }, `📝 [Grading Engine] Prepared grading request for assignment: "${gradingRequest.assignmentTitle}"`);

    // Generate and log the prompt (for research traceability)
    const splitPrompt = GeminiPrompts.generateSplitGradingPrompt(gradingRequest);
    const prompt = `${splitPrompt.cachedContent}\n\n${splitPrompt.userPrompt}`;
    const promptTokenEstimate = Math.ceil(prompt.length / 3.5); // Simple token estimate
    gradingLogger.addPromptInfo(sessionId, prompt, promptTokenEstimate, userLanguage);
    
    // Calculate context hash for caching (must include system instruction as it's part of the cache config)
    const contextContent = splitPrompt.cachedContent;
    // We include systemInstruction in the hash so that prompt updates invalidate the cache
    const contextHash = GeminiCacheManager.hashContent(contextContent + splitPrompt.systemInstruction);

    let gradingResponse;

    if (useAgentGrading) {
      // ... (Agent path unchanged for now, it handles its own prompts)
      // Agent-based grading path (AI SDK 6 beta)
      const { executeGradingAgent } = await import('./agent-executor.server');
      const { saveAgentExecution } = await import('./agent-logger.server');

      logger.info({ resultId }, '🤖 Starting Agent-based grading');

      const agentResult = await executeGradingAgent({
        submissionId: result.uploadedFile.id,
        uploadedFileId: result.uploadedFile.id,
        fileName: result.uploadedFile.originalFileName,
        content: result.uploadedFile.parsedContent,
        rubricId: result.rubric.id,
        rubricName: result.rubric.name,
        useDirectGrading,
        criteria: criteria.map(c => ({
          criteriaId: c.id,
          name: c.name,
          description: c.description,
          maxScore: c.maxScore,
          levels: c.levels?.map(l => ({
            score: l.score,
            description: l.description
          }))
        })),
        referenceDocuments: referenceDocuments.length > 0 ? referenceDocuments.map(ref => ({
          fileId: ref.fileId,
          fileName: ref.fileName,
          content: ref.content,
          contentLength: ref.content.length,
          wasTruncated: ref.wasTruncated,
        })) : undefined,
        customInstructions: customInstructions || undefined,
        assignmentType: 'other', // TODO: detect from assignment
        assignmentTitle: result.assignmentArea?.name || 'Untitled Assignment',
        assignmentDescription: result.assignmentArea?.description || undefined,
        userId: _userId,
        resultId,
        sessionId,
        userLanguage,
        maxSteps: 50,
        confidenceThreshold: parseFloat(process.env.AGENT_CONFIDENCE_THRESHOLD || '0.7'),
        enableSimilarityCheck: result.assignmentAreaId !== null,
      });

      // 🔍 CRITICAL: Check agentResult.data IMMEDIATELY after executeGradingAgent
      logger.info(`🔍 [IMMEDIATE] agentResult.data keys: ${Object.keys(agentResult.data || {}).join(', ')}`);
      logger.info(`🔍 [IMMEDIATE] agentResult.data.sparringQuestions: ${JSON.stringify((agentResult.data as any)?.sparringQuestions || 'UNDEFINED').substring(0, 300)}`);

      // Save Agent execution to database
      await saveAgentExecution(resultId, agentResult);

      if (agentResult.success && agentResult.data) {
        // Cast to any for sparringQuestions access (type will be updated separately)
        const agentData = agentResult.data as any;
        const processingDiagnostics = {
          interrupted: !!agentResult.interrupted,
          interruptionReasonCode: agentResult.interruptionReasonCode || null,
          interruptionReason: agentResult.interruptionReason || null,
          toolCallStats: agentResult.toolCallStats || { total: 0, byTool: {} },
          capturedSteps: agentResult.steps.length,
        };
        
        // 🔍 Log the agentResult.data structure for debugging (use separate logs for visibility)
        logger.info(`🔍 [Grading Engine] agentResult.data keys: ${Object.keys(agentData || {}).join(', ')}`);
        logger.info(`🔍 [Grading Engine] hasSparringQuestions: ${!!agentData.sparringQuestions}, count: ${agentData.sparringQuestions?.length || 0}`);
        if (agentData.sparringQuestions && agentData.sparringQuestions.length > 0) {
          logger.info(`🔍 [Grading Engine] sparringQuestions[0]: ${JSON.stringify(agentData.sparringQuestions[0]).substring(0, 300)}`);
        }

        // Convert to standard format with null safety
        if (!agentResult.data.breakdown || !Array.isArray(agentResult.data.breakdown)) {
          logger.error({
            resultId,
            breakdown: agentResult.data.breakdown,
          }, '❌ [Grading Engine] Invalid breakdown structure');
          throw new Error('Agent returned invalid breakdown structure (not an array)');
        }

        const totalScore = agentResult.data.breakdown.reduce((sum, item) => sum + item.score, 0);
        const maxScore = criteria.reduce((sum, c) => sum + (c.maxScore || 0), 0);

        // Format reasoning for transparency (XAI)
        // 收集 AI 的即時思考過程和最終評分推理
        let thoughtSummary = '';
        let thinkingProcess = '';
        let gradingRationale = '';
        
        // 1. Collect Thinking Process from think/think_aloud tools
        // Some runs may emit think_aloud as multiple tool calls; merge all chunks in step order.
        const thinkSteps = agentResult.steps
          .filter((s: any) =>
            (s.toolName === 'think' || s.toolName === 'think_aloud') &&
            typeof s.reasoning === 'string' &&
            s.reasoning.length > 0
          )
          .sort((a: any, b: any) => (a.stepNumber || 0) - (b.stepNumber || 0));

        if (thinkSteps.length > 0) {
          const mergedChunks: string[] = [];
          for (const step of thinkSteps) {
            const chunk = step.reasoning as string;
            if (!chunk) continue;
            if (mergedChunks.length > 0 && mergedChunks[mergedChunks.length - 1] === chunk) {
              continue;
            }
            mergedChunks.push(chunk);
          }

          thinkingProcess = mergedChunks.join('');
        } else {
          // Fallback: collect from all steps (for backward compatibility with old data)
          thinkingProcess = agentResult.steps
            .map((s: any) => s.reasoning)
            .filter((r: string) => r && r !== 'Tool Execution' && r !== 'Analysis')
            .join('\n\n---\n\n');
        }

        // 0.5 Capture Direct Mode Thinking (Gemini Native)
        const directThinkingStep = agentResult.steps.find((s: any) => s.toolName === 'direct_grading' && s.reasoning);
        if (directThinkingStep?.reasoning) {
          // If we have native thinking from direct mode, use it as thinkingProcess
          if (!thinkingProcess) {
             thinkingProcess = directThinkingStep.reasoning;
          } else {
             thinkingProcess += `\n\n## Native Thinking\n${directThinkingStep.reasoning}`;
          }
        }
        
        // 2. Determine Grading Rationale (The "Why")
        const feedbackStep = agentResult.steps.find((s: any) => 
          s.toolName === 'generate_feedback' && s.reasoning
        );
        
        if (feedbackStep?.reasoning && feedbackStep.reasoning.length > 20) {
          // If generate_feedback has substantial reasoning, use it
          gradingRationale = feedbackStep.reasoning;
        } else {
          // Fallback: use the accumulated thinking process if specific rationale is missing
          gradingRationale = thinkingProcess;
        }

        // 3. Prepend Confidence Summary to Grading Rationale
        const confidenceStep = agentResult.steps.find((s: any) => s.toolName === 'calculate_confidence');
        const confidenceInfo = confidenceStep?.toolOutput as { confidenceScore?: number; reason?: string } | undefined;
        
        let confidenceHeader = '';
        if (confidenceInfo?.confidenceScore !== undefined) {
          confidenceHeader = isZh
            ? `**評分信心度：${(confidenceInfo.confidenceScore * 100).toFixed(0)}%**\n${confidenceInfo.reason || ''}\n\n`
            : `**Grading Confidence: ${(confidenceInfo.confidenceScore * 100).toFixed(0)}%**\n${confidenceInfo.reason || ''}\n\n`;
          gradingRationale = confidenceHeader + gradingRationale;
        }

        // thoughtSummary should ONLY contain confidence info, not the full thinking process
        // This prevents duplication when displaying thinkingProcess and thoughtSummary together
        thoughtSummary = confidenceHeader.trim() || (isZh
          ? `評分已完成。總分：${totalScore}/${maxScore}`
          : `Grading complete. Total score: ${totalScore}/${maxScore}`);


        gradingResponse = {
          success: true,
          result: {
            breakdown: agentData.breakdown,
            totalScore,
            maxScore,
            overallFeedback: agentData.overallFeedback,
            // Sparring Questions for Productive Friction
            sparringQuestions: agentData.sparringQuestions || [],
            processingDiagnostics,
          },
          thoughtSummary,
          thinkingProcess, // New Field
          gradingRationale, // New Field
          provider: `${agentResult.provider ?? 'gemini'}-agent`,
          metadata: {
            model: `${agentResult.modelName ?? GEMINI_GRADING_MODEL}-agent`,
            tokens: agentResult.totalTokens,
            duration: agentResult.executionTimeMs,
            agentSteps: agentResult.steps.length,
            confidenceScore: agentResult.confidenceScore,
            requiresReview: agentResult.requiresReview,
          },
        };

        logger.info({
          resultId,
          confidence: agentResult.confidenceScore,
          requiresReview: agentResult.requiresReview,
          steps: agentResult.steps.length,
        }, `  Agent grading succeeded`);

        // If requires review, send notification to teacher
        if (agentResult.requiresReview) {
          logger.warn({
            resultId,
            confidence: agentResult.confidenceScore,
          }, `⚠️ Low confidence grading - requires human review`);
          // TODO: Send WebSocket notification to teacher
        }
      } else {
        // Agent failed, fallback to AI SDK or Legacy
        logger.error({
          resultId,
          error: agentResult.error,
        }, `❌ Agent grading failed, falling back`);
        gradingResponse = {
          success: false,
          error: agentResult.error || 'Agent grading failed',
        };
      }
    } else if (useAISDK) {
      // New AI SDK grading path
      const sdkResult = await gradeWithAI({
        prompt, // Use full prompt as fallback / standard
        userId: _userId,
        resultId,
        language: userLanguage,
        contextHash,
        contextContent,
        userPrompt: splitPrompt.userPrompt,
      });

      if (sdkResult.success) {
        // Convert AI SDK result to legacy format
        const legacyFormat = convertToLegacyFormat(sdkResult.data);

        // Calculate total and max scores from breakdown
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
        logger.info(`  AI SDK grading succeeded with ${sdkResult.provider}`);
      } else {
        // AI SDK failed, return error
        gradingResponse = {
          success: false,
          error: sdkResult.error,
        };
        logger.error(`❌ AI SDK grading failed: ${sdkResult.error}`);
      }
    } else {
      // Legacy grading path
      const aiGrader = getAIGrader();
      gradingResponse = await aiGrader.grade(gradingRequest, userLanguage);
    }

    // Update progress
    await SimpleProgressService.updateGradingProgress(resultId, 80);

    if (gradingResponse.success && gradingResponse.result) {
      // Calculate 100-point normalized score
      const { totalScore, maxScore } = gradingResponse.result;
      const normalizedScore =
        maxScore > 0
          ? Math.max(0, Math.min(100, Math.round((totalScore / maxScore) * 10000) / 100))
          : null;

      logger.info(`📊 Normalized score: ${totalScore}/${maxScore} → ${normalizedScore}/100`);

      // Log thought summary if available
      if (gradingResponse.thoughtSummary) {
        logger.info(`💭 Thought summary available (${gradingResponse.thoughtSummary.length} chars)`);
      }

      // Feature 004: Build context transparency metadata
      const usedContext =
        result.assignmentAreaId && (referenceDocuments.length > 0 || customInstructions)
          ? {
              assignmentAreaId: result.assignmentAreaId,
              referenceFilesUsed: referenceDocuments.map((doc) => ({
                fileId: doc.fileId,
                fileName: doc.fileName,
                contentLength: doc.content.length,
                wasTruncated: doc.wasTruncated,
              })),
              customInstructionsUsed: !!customInstructions,
            }
          : null;

      // Read overallFeedback directly — avoid extractOverallFeedback which validates the
      // entire result object and fails when unrelated fields (e.g. sparringQuestions enum) are invalid
      const rawFeedback = gradingResponse.result.overallFeedback;
      let overallFeedbackStr: string =
        typeof rawFeedback === 'string'
          ? rawFeedback
          : (rawFeedback && typeof rawFeedback === 'object' && 'summary' in rawFeedback
              ? String((rawFeedback as Record<string, unknown>).summary ?? '')
              : '');

      // Final safeguard: ensure overallFeedback is never empty
      // Agent / AI SDK 應該都會填，但如果模型回傳空字串，這裡用 breakdown 自動組一個整體回饋
      if (!overallFeedbackStr.trim()) {
        const breakdown = gradingResponse.result.breakdown || [];

        if (Array.isArray(breakdown) && breakdown.length > 0) {
          overallFeedbackStr = breakdown
            .map((item: any, idx: number) => {
              const name = item.name || (isZh ? `項目 ${idx + 1}` : `Item ${idx + 1}`);
              const fb = item.feedback || '';
              return fb ? `${idx + 1}. ${name}${isZh ? '：' : ': '} ${fb}` : `${idx + 1}. ${name}`;
            })
            .join('\n\n');
        }

        if (!overallFeedbackStr.trim()) {
          overallFeedbackStr = isZh
            ? '評分已完成，請參考各個評分項目的具體回饋進行修正與精進。'
            : 'Grading is complete. Please review each criterion feedback and revise accordingly.';
        }
      }

      const normalizedSparringQuestions = Array.isArray(gradingResponse.result.sparringQuestions)
        ? gradingResponse.result.sparringQuestions.slice(0, 1)
        : [];

      // 🔍 CRITICAL DEBUG: Check sparringQuestions BEFORE saving to DB
      logger.info(`🔍 [DB Save] gradingResponse.result.sparringQuestions: ${JSON.stringify(normalizedSparringQuestions || 'UNDEFINED').substring(0, 300)}`);
      logger.info(`🔍 [DB Save] sparringQuestions count: ${normalizedSparringQuestions.length || 0}`);

      await db.gradingResult.update({
        where: { id: resultId },
        data: {
          status: 'COMPLETED',
          progress: 100,
          result: {
            totalScore: gradingResponse.result.totalScore,
            maxScore: gradingResponse.result.maxScore,
            breakdown: gradingResponse.result.breakdown || [],
            overallFeedback: overallFeedbackStr,
            // Sparring Questions for Productive Friction
            sparringQuestions: normalizedSparringQuestions,
            processingDiagnostics: (gradingResponse.result as any).processingDiagnostics || undefined,
          },
          thoughtSummary: gradingResponse.thoughtSummary, // Feature 005: Save AI thinking process
          thinkingProcess: gradingResponse.thinkingProcess, // Feature 012: Save raw thinking process
          gradingRationale: gradingResponse.gradingRationale, // Feature 012: Save grading rationale
          normalizedScore,
          gradingModel: gradingResponse.provider,
          gradingTokens: gradingResponse.metadata?.tokens,
          sparringTokens: 0, // Initialize to 0 so subsequent increment operations work (NULL + N = NULL)
          gradingDuration: gradingResponse.metadata?.duration,
          usedContext: usedContext ? {
            assignmentAreaId: usedContext.assignmentAreaId,
            referenceFilesUsed: usedContext.referenceFilesUsed,
            customInstructionsUsed: usedContext.customInstructionsUsed,
          } : undefined, // Use undefined instead of null for optional JSON fields
          completedAt: new Date(),
        },
      });

      // Backfill submission score fields by sessionId.
      // This fixes race conditions where student submits before grading fully completes,
      // causing submission.normalizedScore/finalScore to remain null.
      try {
        const linkedSubmission = await db.submission.findFirst({
          where: {
            sessionId,
            isDeleted: false,
            status: { in: ['SUBMITTED', 'ANALYZED'] },
          },
          orderBy: { updatedAt: 'desc' },
        });

        if (linkedSubmission) {
          const submissionUpdate: {
            normalizedScore?: number;
            finalScore?: number;
            status?: 'ANALYZED';
            aiAnalysisResult?: {
              totalScore: number;
              maxScore: number;
              breakdown: Prisma.InputJsonValue;
              overallFeedback: string;
              sparringQuestions: Prisma.InputJsonValue;
              processingDiagnostics?: Prisma.InputJsonValue;
            };
            thoughtSummary?: string | null;
            thinkingProcess?: string | null;
            gradingRationale?: string | null;
          } = {};

          if (
            normalizedScore !== null &&
            (linkedSubmission.normalizedScore === null || linkedSubmission.normalizedScore !== normalizedScore)
          ) {
            submissionUpdate.normalizedScore = normalizedScore;
          }

          const roundedFinalScore = Number.isFinite(totalScore) ? Math.round(totalScore) : null;
          if (
            roundedFinalScore !== null &&
            (linkedSubmission.finalScore === null || linkedSubmission.finalScore !== roundedFinalScore)
          ) {
            submissionUpdate.finalScore = roundedFinalScore;
          }

          if (linkedSubmission.status === 'SUBMITTED') {
            submissionUpdate.status = 'ANALYZED';
          }

          const currentAiTotal =
            linkedSubmission.aiAnalysisResult && typeof linkedSubmission.aiAnalysisResult === 'object'
              ? Number((linkedSubmission.aiAnalysisResult as Record<string, unknown>).totalScore)
              : null;
          if (currentAiTotal !== totalScore) {
            submissionUpdate.aiAnalysisResult = {
              totalScore: gradingResponse.result.totalScore,
              maxScore: gradingResponse.result.maxScore,
              breakdown: gradingResponse.result.breakdown || [],
              overallFeedback: overallFeedbackStr,
               sparringQuestions: normalizedSparringQuestions,
              processingDiagnostics: (gradingResponse.result as any).processingDiagnostics || undefined,
            };
          }

          if (linkedSubmission.thoughtSummary !== (gradingResponse.thoughtSummary ?? null)) {
            submissionUpdate.thoughtSummary = gradingResponse.thoughtSummary ?? null;
          }

          if (linkedSubmission.thinkingProcess !== (gradingResponse.thinkingProcess ?? null)) {
            submissionUpdate.thinkingProcess = gradingResponse.thinkingProcess ?? null;
          }

          if (linkedSubmission.gradingRationale !== (gradingResponse.gradingRationale ?? null)) {
            submissionUpdate.gradingRationale = gradingResponse.gradingRationale ?? null;
          }

          if (Object.keys(submissionUpdate).length > 0) {
            await db.submission.update({
              where: { id: linkedSubmission.id },
              data: submissionUpdate,
            });

            logger.info(
              {
                submissionId: linkedSubmission.id,
                sessionId,
                submissionUpdate,
              },
              '✅ Backfilled submission scores from grading result'
            );
          }
        }
      } catch (backfillError) {
        logger.warn(
          { err: backfillError, sessionId, resultId },
          '⚠️ Failed to backfill submission scores from grading result'
        );
      }

      logger.info(`💾 Saved thoughtSummary (${gradingResponse.thoughtSummary?.length || 0} chars) to DB`);
      // 🆕 Debug: Log sparringQuestions saved to DB
      logger.info({
        resultId,
        sparringQuestionsCount: normalizedSparringQuestions.length || 0,
        sparringQuestionsPreview: normalizedSparringQuestions.length > 0
          ? JSON.stringify(normalizedSparringQuestions).substring(0, 200)
          : 'empty',
      }, `🎯 [Grading Engine] sparringQuestions saved to DB:`);

      // Log grading success
      gradingLogger.addResult(
        sessionId,
        gradingResponse.result?.totalScore,
        gradingResponse.result?.maxScore,
        normalizedScore || undefined,
        extractOverallFeedback(gradingResponse.result) || undefined,
        gradingResponse.result?.breakdown || []
      );
      // Log AI response (rawResponse only - avoid duplication with "result")
      gradingLogger.addAIResponse(
        sessionId,
        gradingResponse.provider || 'unknown',
        gradingResponse.result, // This is the rawResponse from Gemini
        gradingResponse.metadata?.tokens,
        gradingResponse.metadata?.duration,
        gradingResponse.metadata?.model || undefined
      );

      // Update session progress
      await SimpleProgressService.updateSessionProgress(sessionId);

      logger.info(`  Grading completed for ${result.uploadedFile.originalFileName}`);

      // Finalize and save log
      await gradingLogger.finalize(sessionId, startTime);

      return { success: true };
    } else {
      // Failure - save error AND fallback result (if available)
      // The fallback result ensures we never have null in database
      const updateData: any = {
        status: 'FAILED',
        progress: 100,
        errorMessage: gradingResponse.error || 'AI grading failed',
        completedAt: new Date(),
      };

      // Include fallback result if provided (prevents null in database)
      if (gradingResponse.result) {
        const fallbackRaw = gradingResponse.result.overallFeedback;
        const overallFeedbackStr: string =
          typeof fallbackRaw === 'string'
            ? fallbackRaw
            : (fallbackRaw && typeof fallbackRaw === 'object' && 'summary' in fallbackRaw
                ? String((fallbackRaw as Record<string, unknown>).summary ?? '')
                : '');
        updateData.result = {
          totalScore: gradingResponse.result.totalScore,
          maxScore: gradingResponse.result.maxScore,
          breakdown: gradingResponse.result.breakdown || [],
          overallFeedback: overallFeedbackStr,
          sparringQuestions: Array.isArray(gradingResponse.result.sparringQuestions)
            ? gradingResponse.result.sparringQuestions.slice(0, 1)
            : [],
          processingDiagnostics: (gradingResponse.result as any).processingDiagnostics || undefined,
        };
      }

      await db.gradingResult.update({
        where: { id: resultId },
        data: updateData,
      });

      // Log grading failure
      gradingLogger.addError(sessionId, 'AI grading', gradingResponse.error || 'AI grading failed');

      logger.error(`❌ Grading failed for ${result.uploadedFile.originalFileName}: ${gradingResponse.error}`);

      // Finalize and save log
      await gradingLogger.finalize(sessionId, startTime);

      return { success: false, error: gradingResponse.error };
    }
  } catch (error) {
    logger.error({ err: error }, `💥 Fatal error processing grading result ${resultId}:`);

    // Log fatal error
    gradingLogger.addError(
      sessionId,
      'Fatal error',
      error instanceof Error ? error.message : 'Processing error'
    );

    // Mark as failed
    try {
      await db.gradingResult.update({
        where: { id: resultId },
        data: {
          status: 'FAILED',
          progress: 100,
          errorMessage: error instanceof Error ? error.message : 'Processing error',
          completedAt: new Date(),
        },
      });
    } catch (updateError) {
      logger.error({ err: updateError }, `Failed to update result status for ${resultId}:`);
    }

    // Finalize and save log
    await gradingLogger.finalize(sessionId, startTime);

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Processing error',
    };
  }
}

/**
 * Process all pending results for a session - using BullMQ
 */
export async function processGradingSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
  try {
    logger.info(`🔄 Starting grading session ${sessionId} (Async Queue)`);

    const pendingResults = await db.gradingResult.findMany({
      where: {
        gradingSessionId: sessionId,
        status: 'PENDING',
      },
      include: { gradingSession: true },
      orderBy: { createdAt: 'asc' },
    });

    if (pendingResults.length === 0) {
      return { success: true };
    }

    logger.info(`📝 Adding ${pendingResults.length} jobs to grading queue`);

    // Add jobs to BullMQ
    const jobs = pendingResults.map((result) => ({
      name: 'grade-submission',
      data: {
        resultId: result.id,
        userId: result.gradingSession.userId,
        sessionId: result.gradingSessionId,
        userLanguage: 'en' as const,
      },
      opts: {
        jobId: `grade-${result.id}`, // Prevent duplicate jobs for same result
      },
    }));

    await gradingQueue.addBulk(jobs);

    logger.info(`  Queued ${jobs.length} grading jobs for session ${sessionId}`);
    return { success: true };
  } catch (error) {
    logger.error({ err: error }, `❌ Failed to queue grading session ${sessionId}:`);
    return { success: false, error: error instanceof Error ? error.message : 'Session queuing failed' };
  }
}

/**
 * Process all pending grading across all sessions - background job
 */
export async function processAllPendingGrading(): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;

  try {
    const pendingResults = await db.gradingResult.findMany({
      where: { status: 'PENDING' },
      include: { gradingSession: true },
      orderBy: { createdAt: 'asc' },
      take: 50, // Process in reasonable batches
    });

    logger.info(`🔄 Processing ${pendingResults.length} pending grading results`);

    for (const result of pendingResults) {
      // Feature 004: Use default fallback language for batch processing
      const processResult = await processGradingResult(
        result.id,
        result.gradingSession.userId,
        result.gradingSessionId,
        'en'
      );

      if (processResult.success) {
        processed++;
      } else {
        failed++;
      }

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    logger.info(`  Processed ${processed} results, ${failed} failed`);
  } catch (error) {
    logger.error({ err: error }, '❌ Failed to process pending grading:');
  }

  return { processed, failed };
}

/**
 * Retry failed grading results - simple version
 */
export async function retryFailedGrading(
  sessionId?: string
): Promise<{ success: boolean; retriedCount: number; error?: string }> {
  try {
    const where = sessionId
      ? { status: GradingStatus.FAILED, gradingSessionId: sessionId }
      : { status: GradingStatus.FAILED };

    const failedResults = await db.gradingResult.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: 20, // Retry in batches
    });

    let retriedCount = 0;

    for (const result of failedResults) {
      // Reset status to pending
      await db.gradingResult.update({
        where: { id: result.id },
        data: {
          status: 'PENDING',
          errorMessage: null,
          progress: 0,
        },
      });

      retriedCount++;
    }

    logger.info(`🔄 Reset ${retriedCount} failed grading results to pending`);

    return { success: true, retriedCount };
  } catch (error) {
    logger.error({ err: error }, '❌ Failed to retry failed grading:');
    return {
      success: false,
      retriedCount: 0,
      error: error instanceof Error ? error.message : 'Retry failed',
    };
  }
}

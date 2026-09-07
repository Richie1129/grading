/**
 * Agent-based Grading System Types
 *
 * TypeScript definitions for AI SDK 6 Agent grading functionality
 */

import type { AIGradingResult } from '@/services/ai-sdk-provider.server';

/**
 * Single step in Agent execution
 */
export interface AgentStep {
  stepNumber: number;
  toolName?: string; // undefined for pure reasoning steps
  toolInput?: unknown;
  toolOutput?: unknown;
  reasoning?: string; // AI's reasoning process
  durationMs: number;
  timestamp: Date;
}

/**
 * Complete Agent grading result
 */
export interface AgentGradingResult {
  success: boolean;
  data?: AIGradingResult; // Standard grading result format
  steps: AgentStep[];
  confidenceScore: number; // 0-1
  requiresReview: boolean;
  totalTokens: number;
  executionTimeMs: number;
  interrupted?: boolean;
  interruptionReasonCode?: string;
  interruptionReason?: string;
  toolCallStats?: {
    total: number;
    byTool: Record<string, number>;
  };
  error?: string;
  /** 實際使用的模型供應商（Agent 路徑支援 vllm / gemini） */
  provider?: 'vllm' | 'gemini';
  modelName?: string;
}

/**
 * Tool execution result
 */
export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: {
    durationMs: number;
    tokensUsed?: number;
  };
}

/**
 * Confidence scoring tool result
 */
export interface ConfidenceScore {
  confidenceScore: number; // 0-1
  shouldReview: boolean;
  reason: string;
  factors: {
    rubricCoverage: number;
    evidenceQuality: 'high' | 'medium' | 'low';
    criteriaAmbiguity: number;
  };
}

/**
 * Reference search tool result
 */
export interface ReferenceSearchResult {
  foundReferences: Array<{
    fileName: string;
    content: string;
    relevanceScore: number;
    excerpt: string; // First 500 chars
  }>;
  totalMatches: number;
  searchQuery: string;
}

/**
 * Similarity check tool result
 */
export interface SimilarityCheckResult {
  hasSuspiciousSimilarity: boolean;
  matches: Array<{
    submissionId: string;
    studentName?: string;
    similarity: number; // 0-1
    matchedSegments?: string[];
  }>;
  recommendation: string;
  checked: number; // Number of submissions checked
}

/**
 * Reference document for context
 */
export interface ReferenceDocument {
  fileId: string;
  fileName: string;
  content: string;
  contentLength: number;
  wasTruncated: boolean;
}

/**
 * Parsed rubric criterion for Agent processing
 */
export interface ParsedCriterion {
  criteriaId: string;
  name: string;
  description: string;
  maxScore: number;
  levels?: Array<{
    score: number;
    description: string;
  }>;
}

/**
 * Agent grading request parameters
 */
export interface AgentGradingParams {
  // Submission data
  submissionId: string;
  uploadedFileId: string;
  fileName: string;
  content: string;

  // Rubric data
  rubricId: string;
  rubricName: string;
  criteria: ParsedCriterion[];

  // Optional context
  referenceDocuments?: ReferenceDocument[];
  customInstructions?: string;
  assignmentType?: 'essay' | 'code' | 'math' | 'report' | 'other';
  assignmentTitle?: string;
  assignmentDescription?: string;

  // Metadata
  userId: string;
  resultId: string;
  sessionId?: string; // For real-time streaming
  userLanguage?: string;

  // Agent configuration
  maxSteps?: number; // Default: 10
  confidenceThreshold?: number; // Default: 0.7
  enableSimilarityCheck?: boolean; // Default: true
  useDirectGrading?: boolean; // Default: false
}

/**
 * Agent configuration options
 */
export interface AgentConfig {
  maxSteps: number;
  confidenceThreshold: number;
  temperature: number;
  maxOutputTokens: number;
  thinkingBudget: number;
  enableTools: {
    searchReference: boolean;
    checkSimilarity: boolean;
    calculateConfidence: boolean;
    generateFeedback: boolean;
  };
}

/**
 * Default Agent configuration
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxSteps: 10,
  confidenceThreshold: 0.7,
  temperature: 0.3,
  maxOutputTokens: 8192,
  thinkingBudget: 8192,
  enableTools: {
    searchReference: true,
    checkSimilarity: true,
    calculateConfidence: true,
    generateFeedback: true,
  },
};

/**
 * Agent execution state (for logging)
 */
export interface AgentExecutionState {
  resultId: string;
  startTime: Date;
  steps: AgentStep[];
  currentStep: number;
  isComplete: boolean;
  error?: string;
}

import { db, FileParseStatus, type UploadedFile } from '@/types/database';
import { uploadToStorage, type StorageError, StorageErrorType, getStorageErrorMessage } from './storage.server';
import { triggerPdfParsing } from './pdf-parser.server';
import logger from '@/utils/logger';

export interface UploadFileRequest {
  userId: string;
  file: File;
  originalFileName?: string;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

export interface UploadFileResult {
  success: boolean;
  fileId?: string;
  error?: string;
  errorType?: 'storage' | 'database' | 'validation' | 'network' | 'auth' | 'quota';
  retryable?: boolean;
}

function mapPdfParsingErrorToI18nKey(errorMessage: string): {
  key: 'grading:fileUpload.errors.tokenLimitExceeded' | 'grading:fileUpload.errors.parsingFailed' | 'grading:fileUpload.errors.parserServiceUnavailable';
  errorType: UploadFileResult['errorType'];
  retryable: boolean;
} {
  const normalizedMessage = errorMessage.toLowerCase();

  const isTokenLimitError =
    (normalizedMessage.includes('token') && normalizedMessage.includes('limit')) ||
    normalizedMessage.includes('content too large');

  if (isTokenLimitError) {
    return {
      key: 'grading:fileUpload.errors.tokenLimitExceeded',
      errorType: 'quota',
      retryable: false,
    };
  }

  const isParserServiceUnavailable =
    normalizedMessage.includes('eproto') ||
    normalizedMessage.includes('econnrefused') ||
    normalizedMessage.includes('enotfound') ||
    normalizedMessage.includes('eai_again') ||
    normalizedMessage.includes('etimedout') ||
    normalizedMessage.includes('econnreset') ||
    normalizedMessage.includes('ssl') ||
    normalizedMessage.includes('tls') ||
    normalizedMessage.includes('request to ') ||
    normalizedMessage.includes('failed to reach pdf parser') ||
    normalizedMessage.includes('pdf parser api error: 5') ||
    normalizedMessage.includes('aborterror');

  if (isParserServiceUnavailable) {
    return {
      key: 'grading:fileUpload.errors.parserServiceUnavailable',
      errorType: 'network',
      retryable: true,
    };
  }

  return {
    key: 'grading:fileUpload.errors.parsingFailed',
    errorType: 'network',
    retryable: true,
  };
}

/**
 * Uploads a file and creates a database record with comprehensive error handling
 */
export async function uploadFile(request: UploadFileRequest): Promise<UploadFileResult> {
  const startTime = Date.now();

  try {
    const { userId, file, originalFileName, onProgress } = request;

    // Validate file
    if (!file || file.size === 0) {
      return {
        success: false,
        error: '無效的文件或文件為空',
        errorType: 'validation',
        retryable: false,
      };
    }

    if (file.size > 10 * 1024 * 1024) {
      // 10MB limit
      return {
        success: false,
        error: '文件大小超過 10MB 限制',
        errorType: 'quota',
        retryable: false,
      };
    }

    // Generate unique file key
    const timestamp = Date.now();
    const sanitizedName = file.name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // 只替換檔案系統不安全字符
      .replace(/\s+/g, '_') // 將空格替換為下劃線
      .replace(/\.{2,}/g, '.') // 防止多個連續的點
      .substring(0, 255); // 限制檔名長度

    const fileKey = `uploads/${userId}/${timestamp}-${sanitizedName}`;

    logger.info(`Starting file upload: ${file.name} (${file.size} bytes) for user ${userId}`);

    // Convert file to buffer
    let buffer: Buffer;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch (error) {
      logger.error({ err: error }, 'Failed to read file data:');
      return {
        success: false,
        error: '無法讀取文件數據，請檢查文件是否損壞',
        errorType: 'validation',
        retryable: false,
      };
    }

    // Upload to storage with enhanced error handling
    let storageResult;
    try {
      storageResult = await uploadToStorage(buffer, fileKey, file.type, onProgress);
    } catch (error) {
      const storageError = error as StorageError;

      logger.error({
        error: storageError.message,
        type: storageError.type,
        retryable: storageError.retryable,
        fileName: file.name,
        fileSize: file.size,
        userId,
      }, 'Storage upload failed:');

      // Map storage error types to user-friendly messages
      let errorType: UploadFileResult['errorType'] = 'storage';
      const userMessage = getStorageErrorMessage(storageError);

      switch (storageError.type) {
        case StorageErrorType.AUTH:
          errorType = 'auth';
          break;
        case StorageErrorType.NETWORK:
          errorType = 'network';
          break;
        case StorageErrorType.QUOTA:
          errorType = 'quota';
          break;
        case StorageErrorType.VALIDATION:
          errorType = 'validation';
          break;
        default:
          errorType = 'storage';
      }

      return {
        success: false,
        error: userMessage,
        errorType,
        retryable: storageError.retryable,
      };
    }

    // Validate storage result
    if (!storageResult || !storageResult.key) {
      return {
        success: false,
        error: '存儲服務返回無效結果',
        errorType: 'storage',
        retryable: true,
      };
    }

    // Create database record
    let uploadedFile: UploadedFile;
    try {
      uploadedFile = await db.uploadedFile.create({
        data: {
          userId,
          fileName: sanitizedName,
          originalFileName: originalFileName || file.name,
          fileKey,
          fileSize: file.size,
          mimeType: file.type,
          parseStatus: FileParseStatus.PENDING,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'Database record creation failed:');

      // Try to clean up the uploaded file from storage
      try {
        const { deleteFromStorage } = await import('./storage.server');
        await deleteFromStorage(fileKey);
        logger.info(`Cleaned up orphaned file from storage: ${fileKey}`);
      } catch (cleanupError) {
        logger.error({ err: cleanupError }, `Failed to cleanup orphaned file ${fileKey}:`);
      }

      return {
        success: false,
        error: '無法創建文件記錄，請稍後重試',
        errorType: 'database',
        retryable: true,
      };
    }

    // Trigger file parsing if it's a supported format
    if (
      file.type === 'application/pdf' ||
      file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      file.type === 'text/plain'
    ) {
      try {
        // Wait for parse to fully complete so the client gets a definitive result
        // Pass buffer to avoid redundant S3 download (saves ~200-500ms)
        await triggerPdfParsing(uploadedFile.id, fileKey, originalFileName || file.name, userId, buffer);
      } catch (error) {
        // triggerPdfParsing already updated DB status to FAILED. Return failure to client.
        const errorMessage = error instanceof Error ? error.message : '解析過程發生錯誤';
        const mappedError = mapPdfParsingErrorToI18nKey(errorMessage);

        return {
          success: false,
          // Return i18n key for frontend to translate
          error: mappedError.key,
          errorType: mappedError.errorType,
          retryable: mappedError.retryable,
        };
      }
    } else {
      // Mark as completed for unsupported formats (we'll just use the file as-is)
      updateFileParseStatus(uploadedFile.id, FileParseStatus.COMPLETED, 'File uploaded successfully').catch((error) => {
        logger.error({ err: error }, `Failed to update parse status for ${uploadedFile.id}:`);
      });
    }

    const duration = Date.now() - startTime;
    logger.info(`File uploaded successfully: ${uploadedFile.id} (${file.size} bytes) in ${duration}ms`);

    return {
      success: true,
      fileId: uploadedFile.id,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error({
      error: error instanceof Error ? error.message : error,
      userId: request.userId,
      fileName: request.file?.name,
      fileSize: request.file?.size,
      duration,
    }, 'Unexpected error during file upload:');

    return {
      success: false,
      error: '文件上傳過程中發生未預期錯誤，請稍後重試',
      errorType: 'storage',
      retryable: true,
    };
  }
}

/**
 * Updates file parse status
 */
export async function updateFileParseStatus(
  fileId: string,
  status: FileParseStatus,
  parsedContent?: string,
  parseError?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await db.uploadedFile.update({
      where: { id: fileId },
      data: {
        parseStatus: status,
        parsedContent: parsedContent || undefined,
        parseError: parseError || undefined,
      },
    });

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, 'Failed to update file parse status:');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update parse status',
    };
  }
}

/**
 * Gets files by user with optional filtering
 */
export async function getUserFiles(
  userId: string,
  options?: {
    parseStatus?: FileParseStatus | null;
    limit?: number;
    offset?: number;
    includeDeleted?: boolean;
  }
): Promise<{ files: UploadedFile[]; total: number; error?: string }> {
  try {
    const { parseStatus, limit = 50, offset = 0, includeDeleted = false } = options || {};

    const whereClause: any = {
      userId,
      ...(includeDeleted ? {} : { isDeleted: false }),
    };
    if (parseStatus !== undefined) {
      whereClause.parseStatus = parseStatus;
    }

    const [files, total] = await Promise.all([
      db.uploadedFile.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.uploadedFile.count({
        where: whereClause,
      }),
    ]);

    return { files, total };
  } catch (error) {
    logger.error({ err: error }, 'Failed to get user files:');
    return {
      files: [],
      total: 0,
      error: error instanceof Error ? error.message : 'Failed to get files',
    };
  }
}

/**
 * Gets a single file by ID
 * Allows access if:
 * 1. User owns the file, OR
 * 2. User is a teacher and the file is from a student submission in their course
 */
export async function getFile(
  fileId: string,
  userId: string,
  includeDeleted: boolean = false
): Promise<{ file?: UploadedFile; error?: string }> {
  try {
    // First, try to get the file if user owns it
    const file = await db.uploadedFile.findFirst({
      where: {
        id: fileId,
        userId,
        ...(includeDeleted ? {} : { isDeleted: false }),
      },
    });

    if (file) {
      return { file };
    }

    // If not owned, check if user is a teacher accessing a student's submission file
    const teacherAccessFile = await db.uploadedFile.findFirst({
      where: {
        id: fileId,
        ...(includeDeleted ? {} : { isDeleted: false }),
        // Check if this file is used in a submission where the requesting user is the teacher
        user: {
          submissions: {
            some: {
              filePath: fileId,
              assignmentArea: {
                course: {
                  teacherId: userId,
                },
              },
            },
          },
        },
      },
    });

    if (teacherAccessFile) {
      return { file: teacherAccessFile };
    }

    return { error: 'File not found' };
  } catch (error) {
    logger.error({ err: error }, 'Failed to get file:');
    return {
      error: error instanceof Error ? error.message : 'Failed to get file',
    };
  }
}

/**
 * Deletes a file (soft delete if used in grading, hard delete otherwise)
 */
export async function deleteFile(
  fileId: string,
  userId: string
): Promise<{ success: boolean; error?: string; deletionType?: 'soft' | 'hard' }> {
  try {
    // Get file record
    const file = await db.uploadedFile.findFirst({
      where: {
        id: fileId,
        userId,
        isDeleted: false, // 只能刪除未刪除的檔案
      },
    });

    if (!file) {
      return { success: false, error: 'File not found or already deleted' };
    }

    // Check if file is being used in grading results
    const usedInGrading = await db.gradingResult.findFirst({
      where: { uploadedFileId: fileId },
    });

    if (usedInGrading) {
      // 軟刪除：已用於評分的檔案
      await db.uploadedFile.update({
        where: { id: fileId },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
        },
      });

      logger.info(`File soft deleted (used in grading): ${fileId}`);
      return { success: true, deletionType: 'soft' };
    } else {
      // 硬刪除：未用於評分的檔案
      await db.uploadedFile.delete({
        where: { id: fileId },
      });

      // TODO: 同時刪除儲存空間中的檔案
      logger.info(`File hard deleted (not used in grading): ${fileId}`);
      return { success: true, deletionType: 'hard' };
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete file:');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete file',
    };
  }
}

/**
 * Restores a soft-deleted file
 */
export async function restoreFile(fileId: string, userId: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Get deleted file record
    const file = await db.uploadedFile.findFirst({
      where: {
        id: fileId,
        userId,
        isDeleted: true,
      },
    });

    if (!file) {
      return { success: false, error: 'Deleted file not found' };
    }

    // 恢復檔案
    await db.uploadedFile.update({
      where: { id: fileId },
      data: {
        isDeleted: false,
        deletedAt: null,
      },
    });

    logger.info(`File restored: ${fileId}`);

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, 'Failed to restore file:');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to restore file',
    };
  }
}

/**
 * Gets files ready for grading (parsed successfully)
 */
export async function getReadyFiles(userId: string): Promise<{ files: UploadedFile[]; error?: string }> {
  try {
    const files = await db.uploadedFile.findMany({
      where: {
        userId,
        parseStatus: FileParseStatus.COMPLETED,
        isDeleted: false, // 過濾已刪除檔案
      },
      orderBy: { createdAt: 'desc' },
    });

    return { files };
  } catch (error) {
    logger.error({ err: error }, 'Failed to get ready files:');
    return {
      files: [],
      error: error instanceof Error ? error.message : 'Failed to get ready files',
    };
  }
}

/**
 * Collects file IDs that are still referenced and therefore must not be cleaned up.
 *
 * Neither reference is a foreign key, so the database will not block deletion:
 * - `submissions.filePath` holds an UploadedFile id (plain string column)
 * - `assignment_areas.referenceFileIds` holds a JSON array of UploadedFile ids
 */
async function getReferencedFileIds(): Promise<Set<string>> {
  const referencedIds = new Set<string>();

  const submissions = await db.submission.findMany({ select: { filePath: true } });
  for (const submission of submissions) {
    if (submission.filePath) {
      referencedIds.add(submission.filePath);
    }
  }

  const areas = await db.assignmentArea.findMany({
    where: { referenceFileIds: { not: null } },
    select: { id: true, referenceFileIds: true },
  });
  for (const area of areas) {
    if (!area.referenceFileIds) continue;

    try {
      const parsed: unknown = JSON.parse(area.referenceFileIds);
      if (Array.isArray(parsed)) {
        for (const fileId of parsed) {
          if (typeof fileId === 'string') {
            referencedIds.add(fileId);
          }
        }
      }
    } catch (error) {
      // 無法得知這個作業區引用了哪些檔案，中止清理而不是冒著誤刪參考檔的風險
      // （由 cleanupExpiredFiles 的 catch 接住，不會往上拋到 route）
      logger.error({ err: error, assignmentAreaId: area.id }, 'Invalid referenceFileIds JSON, aborting cleanup:');
      throw new Error(`Cannot determine referenced files: invalid referenceFileIds on assignment area ${area.id}`);
    }
  }

  return referencedIds;
}

/**
 * Cleans up expired files that nothing references anymore
 *
 * Expiry alone is not enough to delete a file. Files are skipped when:
 * 1. They have grading results — GradingResult has `onDelete: Cascade` on UploadedFile,
 *    so deleting the file also deletes its grading results and their AgentExecutionLogs
 * 2. They are referenced by a submission or by an assignment area's reference files
 *
 * Same rule as deleteFile(): a file used in grading is never hard deleted.
 * If the referenced-file set cannot be determined, nothing is deleted.
 */
export async function cleanupExpiredFiles(): Promise<{
  deletedCount: number;
  skippedCount: number;
  error?: string;
}> {
  try {
    const expiredFiles = await db.uploadedFile.findMany({
      where: {
        expiresAt: {
          lt: new Date(),
        },
        gradingResults: { none: {} },
      },
      select: { id: true, fileKey: true },
    });

    if (expiredFiles.length === 0) {
      return { deletedCount: 0, skippedCount: 0 };
    }

    const referencedIds = await getReferencedFileIds();
    const deletableFiles = expiredFiles.filter((file) => !referencedIds.has(file.id));
    const skippedCount = expiredFiles.length - deletableFiles.length;

    if (deletableFiles.length === 0) {
      logger.info(`No expired files to clean up (${skippedCount} still referenced)`);
      return { deletedCount: 0, skippedCount };
    }

    // Delete from database
    const deleteResult = await db.uploadedFile.deleteMany({
      where: {
        id: { in: deletableFiles.map((f) => f.id) },
      },
    });

    // TODO: Delete from storage
    // Note: Storage cleanup should be handled by a background job

    logger.info(`Cleaned up ${deleteResult.count} expired files (skipped ${skippedCount} still referenced)`);

    return { deletedCount: deleteResult.count, skippedCount };
  } catch (error) {
    logger.error({ err: error }, 'Failed to cleanup expired files:');
    return {
      deletedCount: 0,
      skippedCount: 0,
      error: error instanceof Error ? error.message : 'Failed to cleanup files',
    };
  }
}

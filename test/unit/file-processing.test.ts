import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { FileParseStatus } from '@/types/database';

// Mock all external dependencies BEFORE importing the service
vi.mock('@/types/database', () => ({
  db: {
    uploadedFile: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    gradingResult: {
      findFirst: vi.fn(),
    },
    submission: {
      findMany: vi.fn(),
    },
    assignmentArea: {
      findMany: vi.fn(),
    },
  },
  FileParseStatus: {
    PENDING: 'PENDING',
    PROCESSING: 'PROCESSING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
  },
}));

vi.mock('@/services/storage.server', () => ({
  uploadToStorage: vi.fn(),
  deleteFromStorage: vi.fn(),
  getStorageErrorMessage: vi.fn(),
  StorageErrorType: {
    AUTH: 'AUTH',
    NETWORK: 'NETWORK',
    QUOTA: 'QUOTA',
    VALIDATION: 'VALIDATION',
    STORAGE: 'STORAGE',
  },
}));

vi.mock('@/services/pdf-parser.server', () => ({
  triggerPdfParsing: vi.fn(),
}));

vi.mock('@/utils/logger', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import the mocked modules and service AFTER mocking
import { db } from '@/types/database';
import {
  uploadToStorage,
  deleteFromStorage,
  getStorageErrorMessage,
  StorageErrorType,
} from '@/services/storage.server';
import { triggerPdfParsing } from '@/services/pdf-parser.server';

// Import the service being tested
import {
  uploadFile,
  updateFileParseStatus,
  getUserFiles,
  getFile,
  deleteFile,
  restoreFile,
  getReadyFiles,
  cleanupExpiredFiles,
  type UploadFileRequest,
} from '@/services/uploaded-file.server';

/**
 * Unit Test #2: File Processing Logic
 *
 * Tests the critical file upload, processing, and management functionality
 * that handles all file operations in the grading system.
 */
describe('File Processing Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('File Upload Operations', () => {
    it('should upload file successfully with complete workflow', async () => {
      // Mock successful storage upload
      (uploadToStorage as Mock).mockResolvedValue({
        key: 'uploads/user123/1234567890-test.pdf',
        url: 'https://storage.example.com/test.pdf',
      });

      // Mock successful database creation
      const mockUploadedFile = {
        id: 'file123',
        userId: 'user123',
        fileName: 'test.pdf',
        originalFileName: 'test.pdf',
        fileKey: 'uploads/user123/1234567890-test.pdf',
        fileSize: 1024,
        mimeType: 'application/pdf',
        parseStatus: 'PENDING',
        parsedContent: null,
        parseError: null,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      };

      (db.uploadedFile.create as Mock).mockResolvedValue(mockUploadedFile);

      // Mock successful PDF parsing
      (triggerPdfParsing as Mock).mockResolvedValue({
        success: true,
        taskId: 'task123',
      });

      // Create test file with proper arrayBuffer method
      const fileContent = 'test content';
      const testFile = new File([fileContent], 'test.pdf', {
        type: 'application/pdf',
      });

      // Mock the arrayBuffer method to return proper Buffer
      vi.spyOn(testFile, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(fileContent.length));

      const request: UploadFileRequest = {
        userId: 'user123',
        file: testFile,
        originalFileName: 'test.pdf',
      };

      const result = await uploadFile(request);

      // Verify result
      expect(result.success).toBe(true);
      expect(result.fileId).toBe('file123');
      expect(result.error).toBeUndefined();

      // Verify storage upload was called
      expect(uploadToStorage).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.stringMatching(/uploads\/user123\/\d+-test\.pdf/),
        'application/pdf'
      );

      // Verify database record creation
      expect(db.uploadedFile.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user123',
          fileName: 'test.pdf',
          originalFileName: 'test.pdf',
          fileKey: expect.stringMatching(/uploads\/user123\/\d+-test\.pdf/),
          fileSize: testFile.size,
          mimeType: 'application/pdf',
          parseStatus: 'PENDING',
        }),
      });

      // Verify PDF parsing was triggered
      expect(triggerPdfParsing).toHaveBeenCalledWith(
        'file123',
        expect.stringMatching(/uploads\/user123\/\d+-test\.pdf/),
        'test.pdf',
        'user123'
      );

      console.log('  File upload workflow completed successfully');
    });

    it('should handle file validation errors', async () => {
      const testCases = [
        {
          description: 'empty file',
          file: new File([''], 'empty.pdf', { type: 'application/pdf' }),
          expectedError: '無效的文件或文件為空',
          expectedErrorType: 'validation',
        },
        {
          description: 'oversized file',
          file: new (globalThis as any).TestFile(['x'], 'huge.pdf', {
            type: 'application/pdf',
            size: 101 * 1024 * 1024, // 101MB
          }),
          expectedError: '文件大小超過 100MB 限制',
          expectedErrorType: 'quota',
        },
      ];

      for (const testCase of testCases) {
        const request: UploadFileRequest = {
          userId: 'user123',
          file: testCase.file,
        };

        const result = await uploadFile(request);

        expect(result.success).toBe(false);
        expect(result.error).toBe(testCase.expectedError);
        expect(result.errorType).toBe(testCase.expectedErrorType);
        expect(result.retryable).toBe(false);

        console.log(`  Validation error handled correctly for ${testCase.description}`);
      }
    });

    it('should handle storage upload errors with proper error mapping', async () => {
      const storageErrors = [
        {
          type: StorageErrorType.AUTH,
          message: 'Authentication failed',
          retryable: false,
          expectedErrorType: 'auth',
        },
        {
          type: StorageErrorType.NETWORK,
          message: 'Network timeout',
          retryable: true,
          expectedErrorType: 'network',
        },
        {
          type: StorageErrorType.QUOTA,
          message: 'Storage quota exceeded',
          retryable: false,
          expectedErrorType: 'quota',
        },
      ];

      for (const errorCase of storageErrors) {
        vi.clearAllMocks();

        const storageError = {
          message: errorCase.message,
          type: errorCase.type,
          retryable: errorCase.retryable,
        };

        (uploadToStorage as Mock).mockRejectedValue(storageError);
        (getStorageErrorMessage as Mock).mockReturnValue(errorCase.message);

        const fileContent = 'test';
        const testFile = new File([fileContent], 'test.pdf', { type: 'application/pdf' });

        // Mock the arrayBuffer method properly
        vi.spyOn(testFile, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(fileContent.length));

        const request: UploadFileRequest = {
          userId: 'user123',
          file: testFile,
        };

        const result = await uploadFile(request);

        expect(result.success).toBe(false);
        expect(result.error).toBe(errorCase.message);
        expect(result.errorType).toBe(errorCase.expectedErrorType);
        expect(result.retryable).toBe(errorCase.retryable);

        console.log(`  Storage error mapped correctly: ${errorCase.type} -> ${errorCase.expectedErrorType}`);
      }
    });

    it('should handle database creation errors with cleanup', async () => {
      // Mock successful storage upload
      (uploadToStorage as Mock).mockResolvedValue({
        key: 'uploads/user123/test.pdf',
        url: 'https://storage.example.com/test.pdf',
      });

      // Mock database creation failure
      (db.uploadedFile.create as Mock).mockRejectedValue(new Error('Database connection failed'));

      // Mock cleanup function
      (deleteFromStorage as Mock).mockResolvedValue(true);

      const fileContent = 'test';
      const testFile = new File([fileContent], 'test.pdf', { type: 'application/pdf' });

      // Mock the arrayBuffer method properly
      vi.spyOn(testFile, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(fileContent.length));

      const request: UploadFileRequest = {
        userId: 'user123',
        file: testFile,
      };

      const result = await uploadFile(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('無法創建文件記錄，請稍後重試');
      expect(result.errorType).toBe('database');
      expect(result.retryable).toBe(true);

      // Verify cleanup was attempted (the actual filename includes timestamp)
      expect(deleteFromStorage).toHaveBeenCalledWith(expect.stringMatching(/^uploads\/user123\/\d+-test\.pdf$/));

      console.log('  Database error handled with storage cleanup');
    });

    it('should handle unsupported file types correctly', async () => {
      // Mock successful storage and database operations
      (uploadToStorage as Mock).mockResolvedValue({
        key: 'uploads/user123/image.jpg',
        url: 'https://storage.example.com/image.jpg',
      });

      const mockUploadedFile = {
        id: 'file123',
        userId: 'user123',
        fileName: 'image.jpg',
        parseStatus: 'PENDING',
      };

      (db.uploadedFile.create as Mock).mockResolvedValue(mockUploadedFile);
      (db.uploadedFile.update as Mock).mockResolvedValue({});

      const fileContent = 'image data';
      const testFile = new File([fileContent], 'image.jpg', { type: 'image/jpeg' });

      // Mock the arrayBuffer method properly
      vi.spyOn(testFile, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(fileContent.length));

      const request: UploadFileRequest = {
        userId: 'user123',
        file: testFile,
      };

      const result = await uploadFile(request);

      expect(result.success).toBe(true);
      expect(result.fileId).toBe('file123');

      // Verify PDF parsing was NOT triggered for unsupported type
      expect(triggerPdfParsing).not.toHaveBeenCalled();

      console.log('  Unsupported file type handled correctly (no parsing triggered)');
    });

    it('should handle file name sanitization properly', async () => {
      (uploadToStorage as Mock).mockResolvedValue({ key: 'test', url: 'test' });
      (db.uploadedFile.create as Mock).mockResolvedValue({ id: 'file123' });

      const unsafeNames = [
        'file<script>.pdf',
        'file:with:colons.pdf',
        'file with spaces.pdf',
        'file...multiple...dots.pdf',
        'very'.repeat(100) + '.pdf', // Very long name
      ];

      for (const unsafeName of unsafeNames) {
        vi.clearAllMocks();

        const fileContent = 'test';
        const testFile = new File([fileContent], unsafeName, { type: 'text/plain' });

        // Mock the arrayBuffer method properly
        vi.spyOn(testFile, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(fileContent.length));

        const request: UploadFileRequest = {
          userId: 'user123',
          file: testFile,
        };

        await uploadFile(request);

        // Check if database create was called
        if ((db.uploadedFile.create as Mock).mock.calls.length > 0) {
          const createCall = (db.uploadedFile.create as Mock).mock.calls[0];
          const sanitizedFileName = createCall[0].data.fileName;

          // Verify sanitization
          expect(sanitizedFileName).not.toContain('<');
          expect(sanitizedFileName).not.toContain('>');
          expect(sanitizedFileName).not.toContain(':');
          expect(sanitizedFileName).not.toContain('  '); // No double spaces
          expect(sanitizedFileName.length).toBeLessThanOrEqual(255);

          console.log(`  File name sanitized: "${unsafeName}" -> "${sanitizedFileName}"`);
        }
      }
    });
  });

  describe('File Status and Content Management', () => {
    it('should update file parse status correctly', async () => {
      (db.uploadedFile.update as Mock).mockResolvedValue({
        id: 'file123',
        parseStatus: 'COMPLETED',
        parsedContent: 'parsed content',
      });

      const result = await updateFileParseStatus('file123', FileParseStatus.COMPLETED, 'parsed content', undefined);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      expect(db.uploadedFile.update).toHaveBeenCalledWith({
        where: { id: 'file123' },
        data: {
          parseStatus: 'COMPLETED',
          parsedContent: 'parsed content',
          parseError: undefined,
        },
      });

      console.log('  File parse status updated successfully');
    });

    it('should handle parse status update failures', async () => {
      (db.uploadedFile.update as Mock).mockRejectedValue(new Error('Database update failed'));

      const result = await updateFileParseStatus('file123', FileParseStatus.FAILED, undefined, 'Parse failed');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Database update failed');

      console.log('  Parse status update failure handled correctly');
    });

    it('should get user files with filtering and pagination', async () => {
      const mockFiles = [
        { id: 'file1', fileName: 'test1.pdf', parseStatus: 'COMPLETED' },
        { id: 'file2', fileName: 'test2.pdf', parseStatus: 'PENDING' },
      ];

      (db.uploadedFile.findMany as Mock).mockResolvedValue(mockFiles);
      (db.uploadedFile.count as Mock).mockResolvedValue(10);

      const result = await getUserFiles('user123', {
        parseStatus: FileParseStatus.COMPLETED,
        limit: 20,
        offset: 0,
        includeDeleted: false,
      });

      expect(result.files).toEqual(mockFiles);
      expect(result.total).toBe(10);
      expect(result.error).toBeUndefined();

      expect(db.uploadedFile.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user123',
          isDeleted: false,
          parseStatus: 'COMPLETED',
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        skip: 0,
      });

      console.log('  User files retrieved with filtering and pagination');
    });

    it('should get single file with proper authorization', async () => {
      const mockFile = {
        id: 'file123',
        userId: 'user123',
        fileName: 'test.pdf',
      };

      (db.uploadedFile.findFirst as Mock).mockResolvedValue(mockFile);

      const result = await getFile('file123', 'user123');

      expect(result.file).toEqual(mockFile);
      expect(result.error).toBeUndefined();

      expect(db.uploadedFile.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'file123',
          userId: 'user123',
          isDeleted: false,
        },
      });

      console.log('  Single file retrieved with authorization check');
    });

    it('should handle file not found scenarios', async () => {
      (db.uploadedFile.findFirst as Mock).mockResolvedValue(null);

      const result = await getFile('nonexistent', 'user123');

      expect(result.file).toBeUndefined();
      expect(result.error).toBe('File not found');

      console.log('  File not found scenario handled correctly');
    });
  });

  describe('File Deletion and Restoration', () => {
    it('should perform soft delete for files used in grading', async () => {
      const mockFile = {
        id: 'file123',
        userId: 'user123',
        fileName: 'test.pdf',
        isDeleted: false,
      };

      const mockGradingResult = {
        id: 'grade123',
        uploadedFileId: 'file123',
      };

      (db.uploadedFile.findFirst as Mock).mockResolvedValue(mockFile);
      (db.gradingResult.findFirst as Mock).mockResolvedValue(mockGradingResult);
      (db.uploadedFile.update as Mock).mockResolvedValue({});

      const result = await deleteFile('file123', 'user123');

      expect(result.success).toBe(true);
      expect(result.deletionType).toBe('soft');

      expect(db.uploadedFile.update).toHaveBeenCalledWith({
        where: { id: 'file123' },
        data: {
          isDeleted: true,
          deletedAt: expect.any(Date),
        },
      });

      console.log('  Soft delete performed for file used in grading');
    });

    it('should perform hard delete for files not used in grading', async () => {
      const mockFile = {
        id: 'file123',
        userId: 'user123',
        fileName: 'test.pdf',
        isDeleted: false,
      };

      (db.uploadedFile.findFirst as Mock).mockResolvedValue(mockFile);
      (db.gradingResult.findFirst as Mock).mockResolvedValue(null); // Not used in grading
      (db.uploadedFile.delete as Mock).mockResolvedValue({});

      const result = await deleteFile('file123', 'user123');

      expect(result.success).toBe(true);
      expect(result.deletionType).toBe('hard');

      expect(db.uploadedFile.delete).toHaveBeenCalledWith({
        where: { id: 'file123' },
      });

      console.log('  Hard delete performed for file not used in grading');
    });

    it('should restore soft-deleted files', async () => {
      const mockDeletedFile = {
        id: 'file123',
        userId: 'user123',
        fileName: 'test.pdf',
        isDeleted: true,
      };

      (db.uploadedFile.findFirst as Mock).mockResolvedValue(mockDeletedFile);
      (db.uploadedFile.update as Mock).mockResolvedValue({});

      const result = await restoreFile('file123', 'user123');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      expect(db.uploadedFile.update).toHaveBeenCalledWith({
        where: { id: 'file123' },
        data: {
          isDeleted: false,
          deletedAt: null,
        },
      });

      console.log('  Soft-deleted file restored successfully');
    });
  });

  describe('File Lifecycle and Maintenance', () => {
    it('should get ready files for grading', async () => {
      const mockReadyFiles = [
        { id: 'file1', parseStatus: 'COMPLETED', isDeleted: false },
        { id: 'file2', parseStatus: 'COMPLETED', isDeleted: false },
      ];

      (db.uploadedFile.findMany as Mock).mockResolvedValue(mockReadyFiles);

      const result = await getReadyFiles('user123');

      expect(result.files).toEqual(mockReadyFiles);
      expect(result.error).toBeUndefined();

      expect(db.uploadedFile.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user123',
          parseStatus: 'COMPLETED',
          isDeleted: false,
        },
        orderBy: { createdAt: 'desc' },
      });

      console.log('  Ready files for grading retrieved correctly');
    });

    it('should cleanup expired files', async () => {
      const expiredFiles = [
        { id: 'expired1', fileKey: 'uploads/user1/expired1.pdf' },
        { id: 'expired2', fileKey: 'uploads/user1/expired2.pdf' },
      ];

      (db.uploadedFile.findMany as Mock).mockResolvedValue(expiredFiles);
      (db.submission.findMany as Mock).mockResolvedValue([]);
      (db.assignmentArea.findMany as Mock).mockResolvedValue([]);
      (db.uploadedFile.deleteMany as Mock).mockResolvedValue({ count: 2 });

      const result = await cleanupExpiredFiles();

      expect(result.deletedCount).toBe(2);
      expect(result.skippedCount).toBe(0);
      expect(result.error).toBeUndefined();

      // Files with grading results are filtered out by the query itself: GradingResult
      // cascades on UploadedFile, so deleting one would delete its grading history too
      expect(db.uploadedFile.findMany).toHaveBeenCalledWith({
        where: {
          expiresAt: {
            lt: expect.any(Date),
          },
          gradingResults: { none: {} },
        },
        select: { id: true, fileKey: true },
      });

      expect(db.uploadedFile.deleteMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['expired1', 'expired2'] },
        },
      });

      console.log('  Expired files cleaned up successfully');
    });

    it('should skip expired files still referenced by a submission', async () => {
      (db.uploadedFile.findMany as Mock).mockResolvedValue([
        { id: 'referenced1', fileKey: 'uploads/user1/referenced1.pdf' },
        { id: 'orphan1', fileKey: 'uploads/user1/orphan1.pdf' },
      ]);
      (db.submission.findMany as Mock).mockResolvedValue([{ filePath: 'referenced1' }]);
      (db.assignmentArea.findMany as Mock).mockResolvedValue([]);
      (db.uploadedFile.deleteMany as Mock).mockResolvedValue({ count: 1 });

      const result = await cleanupExpiredFiles();

      expect(result.deletedCount).toBe(1);
      expect(result.skippedCount).toBe(1);

      // Only the orphan goes; the file a submission points to stays
      expect(db.uploadedFile.deleteMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['orphan1'] },
        },
      });

      console.log('  Files referenced by submissions are preserved');
    });

    it('should skip expired files used as assignment area reference files', async () => {
      (db.uploadedFile.findMany as Mock).mockResolvedValue([
        { id: 'ref-file-1', fileKey: 'uploads/teacher1/ref-file-1.pdf' },
      ]);
      (db.submission.findMany as Mock).mockResolvedValue([]);
      (db.assignmentArea.findMany as Mock).mockResolvedValue([
        { id: 'area1', referenceFileIds: JSON.stringify(['ref-file-1']) },
      ]);

      const result = await cleanupExpiredFiles();

      expect(result.deletedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(db.uploadedFile.deleteMany).not.toHaveBeenCalled();

      console.log('  Files used as assignment area references are preserved');
    });

    it('should delete nothing when referenced files cannot be determined', async () => {
      (db.uploadedFile.findMany as Mock).mockResolvedValue([
        { id: 'expired1', fileKey: 'uploads/user1/expired1.pdf' },
      ]);
      (db.submission.findMany as Mock).mockResolvedValue([]);
      (db.assignmentArea.findMany as Mock).mockResolvedValue([{ id: 'area1', referenceFileIds: 'not-json' }]);

      const result = await cleanupExpiredFiles();

      expect(result.deletedCount).toBe(0);
      expect(result.error).toBeDefined();
      expect(db.uploadedFile.deleteMany).not.toHaveBeenCalled();

      console.log('  Cleanup aborted when references are unreadable');
    });

    it('should handle cleanup when no expired files exist', async () => {
      (db.uploadedFile.findMany as Mock).mockResolvedValue([]);

      const result = await cleanupExpiredFiles();

      expect(result.deletedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(result.error).toBeUndefined();

      // Should not attempt deleteMany when no files found
      expect(db.uploadedFile.deleteMany).not.toHaveBeenCalled();

      console.log('  No expired files cleanup handled correctly');
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle unexpected errors gracefully', async () => {
      const fileContent = 'test';
      const testFile = new File([fileContent], 'test.pdf', { type: 'application/pdf' });

      // Mock arrayBuffer to fail
      vi.spyOn(testFile, 'arrayBuffer').mockRejectedValue(new Error('File read error'));

      const request: UploadFileRequest = {
        userId: 'user123',
        file: testFile,
      };

      const result = await uploadFile(request);

      expect(result.success).toBe(false);
      expect(result.error).toBe('無法讀取文件數據，請檢查文件是否損壞');
      expect(result.errorType).toBe('validation');
      expect(result.retryable).toBe(false);

      console.log('  File read error handled gracefully');
    });

    it('should handle database query failures', async () => {
      (db.uploadedFile.findMany as Mock).mockRejectedValue(new Error('Database connection lost'));

      const result = await getUserFiles('user123');

      expect(result.files).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.error).toBe('Database connection lost');

      console.log('  Database query failure handled with fallback values');
    });

    it('should validate file authorization correctly', async () => {
      // Mock the database returning null for authorization check failure
      (db.uploadedFile.findFirst as Mock).mockResolvedValue(null);

      const result = await getFile('file123', 'user123');

      expect(result.file).toBeUndefined();
      expect(result.error).toBe('File not found');

      console.log('  File authorization properly enforced');
    });
  });
});

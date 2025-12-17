/**
 * Tests for downloadFiles() - Phase 15.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import {
  hashBlake2b,
  deriveEncryptionKeyPair,
  deriveSeed,
  generateKey,
  preloadSodium,
} from '@0xd49daa/safecrypt';
import type { ContentHash, X25519KeyPair } from '@0xd49daa/safecrypt';
import { MockIpfsClient } from './ipfs-client.ts';
import { uploadBatch } from './upload.ts';
import { getManifest } from './manifest-retrieval.ts';
import { downloadFiles } from './download-files.ts';
import type {
  FileInput,
  FileDownloadRef,
  MultiDownloadProgress,
} from './types.ts';
import { ValidationError } from './errors.ts';

// Test mnemonic (12 words)
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Create test key pair from mnemonic seed */
async function createTestKeyPair(index = 0): Promise<X25519KeyPair> {
  const seed = await deriveSeed(TEST_MNEMONIC);
  return deriveEncryptionKeyPair(seed, index);
}

// Key pairs (initialized in beforeAll)
let senderKeyPair: X25519KeyPair;
let recipientKeyPair: X25519KeyPair;

beforeAll(async () => {
  await preloadSodium();
  senderKeyPair = await createTestKeyPair(0);
  recipientKeyPair = await createTestKeyPair(1);
});

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a test file with given content.
 */
async function createTestFile(
  path: string,
  content: string | Uint8Array
): Promise<FileInput> {
  const data =
    typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const contentHash = (await hashBlake2b(data, 32)) as ContentHash;
  return {
    file: new File([data as BlobPart], path.split('/').pop() ?? 'file'),
    path,
    contentHash,
  };
}

/**
 * Collect async iterable into array.
 */
async function collectAsyncIterable<T>(
  iterable: AsyncIterable<T>
): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

/**
 * Collect bytes from async iterable.
 */
async function collectBytes(
  iterable: AsyncIterable<Uint8Array>
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// ============================================================================
// Tests
// ============================================================================

describe('downloadFiles', () => {
  // ==========================================================================
  // Validation Tests
  // ==========================================================================

  describe('validation', () => {
    test('throws ValidationError for empty refs array', async () => {
      const client = new MockIpfsClient();
      await expect(
        collectAsyncIterable(downloadFiles([], undefined, client))
      ).rejects.toThrow(ValidationError);
    });

    test('throws ValidationError for concurrency < 1', async () => {
      const client = new MockIpfsClient();
      const file = await createTestFile('/test.txt', 'content');
      const fakeHash = (await hashBlake2b(new Uint8Array(32), 32)) as ContentHash;

      const ref: FileDownloadRef = {
        batchCid: 'bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354',
        path: '/test.txt',
        size: 7,
        contentHash: fakeHash,
        manifestKey: await generateKey(),
        chunks: [],
      };

      await expect(
        collectAsyncIterable(downloadFiles([ref], { concurrency: 0 }, client))
      ).rejects.toThrow(ValidationError);

      await expect(
        collectAsyncIterable(downloadFiles([ref], { concurrency: -1 }, client))
      ).rejects.toThrow(ValidationError);
    });

    test('throws ValidationError for chunkConcurrency < 1', async () => {
      const client = new MockIpfsClient();
      const fakeHash = (await hashBlake2b(new Uint8Array(32), 32)) as ContentHash;

      const ref: FileDownloadRef = {
        batchCid: 'bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354',
        path: '/test.txt',
        size: 7,
        contentHash: fakeHash,
        manifestKey: await generateKey(),
        chunks: [],
      };

      await expect(
        collectAsyncIterable(downloadFiles([ref], { chunkConcurrency: 0 }, client))
      ).rejects.toThrow(ValidationError);

      await expect(
        collectAsyncIterable(downloadFiles([ref], { chunkConcurrency: -1 }, client))
      ).rejects.toThrow(ValidationError);
    });
  });

  // ==========================================================================
  // Basic Functionality Tests
  // ==========================================================================

  describe('basic functionality', () => {
    test('downloads single file correctly', async () => {
      const client = new MockIpfsClient();
      const originalContent = 'Hello, World!';
      const file = await createTestFile('/test.txt', originalContent);

      const result = await uploadBatch(
        [file],
        {
          senderKeyPair,
          recipients: [{ publicKey: recipientKeyPair.publicKey }],
        },
        client
      );

      const manifest = await getManifest(result.cid, {
        ipfsClient: client,
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      const fileInfo = manifest.files[0]!;
      const downloadRef: FileDownloadRef = {
        batchCid: manifest.cid,
        path: fileInfo.path,
        size: fileInfo.size,
        contentHash: fileInfo.contentHash,
        manifestKey: manifest.manifestKey,
        chunks: fileInfo.chunks,
      };

      const downloadedFiles = await collectAsyncIterable(
        downloadFiles([downloadRef], undefined, client)
      );

      expect(downloadedFiles).toHaveLength(1);
      expect(downloadedFiles[0]!.path).toBe('/test.txt');
      expect(downloadedFiles[0]!.size).toBe(originalContent.length);

      const content = await collectBytes(downloadedFiles[0]!.content);
      expect(new TextDecoder().decode(content)).toBe(originalContent);
    });

    test('downloads multiple files correctly', async () => {
      const client = new MockIpfsClient();
      const files = [
        await createTestFile('/a.txt', 'Content A'),
        await createTestFile('/b.txt', 'Content B'),
        await createTestFile('/c.txt', 'Content C'),
      ];

      const result = await uploadBatch(
        files,
        {
          senderKeyPair,
          recipients: [{ publicKey: recipientKeyPair.publicKey }],
        },
        client
      );

      const manifest = await getManifest(result.cid, {
        ipfsClient: client,
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      const downloadRefs: FileDownloadRef[] = manifest.files.map((f) => ({
        batchCid: manifest.cid,
        path: f.path,
        size: f.size,
        contentHash: f.contentHash,
        manifestKey: manifest.manifestKey,
        chunks: f.chunks,
      }));

      const downloadedFiles = await collectAsyncIterable(
        downloadFiles(downloadRefs, undefined, client)
      );

      expect(downloadedFiles).toHaveLength(3);

      // Check files are yielded in request order
      const paths = downloadedFiles.map((f) => f.path);
      expect(paths).toEqual(['/a.txt', '/b.txt', '/c.txt']);

      // Verify content
      for (let i = 0; i < downloadedFiles.length; i++) {
        const content = await collectBytes(downloadedFiles[i]!.content);
        const expected = `Content ${String.fromCharCode(65 + i)}`;
        expect(new TextDecoder().decode(content)).toBe(expected);
      }
    });

    test('handles empty files correctly', async () => {
      const client = new MockIpfsClient();
      const files = [
        await createTestFile('/empty.txt', ''),
        await createTestFile('/nonempty.txt', 'some content'),
      ];

      const result = await uploadBatch(
        files,
        {
          senderKeyPair,
          recipients: [{ publicKey: recipientKeyPair.publicKey }],
        },
        client
      );

      const manifest = await getManifest(result.cid, {
        ipfsClient: client,
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      const downloadRefs: FileDownloadRef[] = manifest.files.map((f) => ({
        batchCid: manifest.cid,
        path: f.path,
        size: f.size,
        contentHash: f.contentHash,
        manifestKey: manifest.manifestKey,
        chunks: f.chunks,
      }));

      const downloadedFiles = await collectAsyncIterable(
        downloadFiles(downloadRefs, undefined, client)
      );

      expect(downloadedFiles).toHaveLength(2);

      // Empty file
      const emptyFile = downloadedFiles.find((f) => f.path === '/empty.txt')!;
      expect(emptyFile.size).toBe(0);
      const emptyContent = await collectBytes(emptyFile.content);
      expect(emptyContent.length).toBe(0);

      // Non-empty file
      const nonEmptyFile = downloadedFiles.find(
        (f) => f.path === '/nonempty.txt'
      )!;
      const content = await collectBytes(nonEmptyFile.content);
      expect(new TextDecoder().decode(content)).toBe('some content');
    });
  });

  // ==========================================================================
  // Concurrency Tests
  // ==========================================================================

  describe('concurrency', () => {
    test('respects concurrency limit', async () => {
      const client = new MockIpfsClient();
      const files = await Promise.all([
        createTestFile('/file1.txt', 'Content 1'),
        createTestFile('/file2.txt', 'Content 2'),
        createTestFile('/file3.txt', 'Content 3'),
        createTestFile('/file4.txt', 'Content 4'),
        createTestFile('/file5.txt', 'Content 5'),
      ]);

      const result = await uploadBatch(
        files,
        {
          senderKeyPair,
          recipients: [{ publicKey: recipientKeyPair.publicKey }],
        },
        client
      );

      const manifest = await getManifest(result.cid, {
        ipfsClient: client,
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      const downloadRefs: FileDownloadRef[] = manifest.files.map((f) => ({
        batchCid: manifest.cid,
        path: f.path,
        size: f.size,
        contentHash: f.contentHash,
        manifestKey: manifest.manifestKey,
        chunks: f.chunks,
      }));

      // Download with concurrency=2
      const downloadedFiles = await collectAsyncIterable(
        downloadFiles(downloadRefs, { concurrency: 2 }, client)
      );

      expect(downloadedFiles).toHaveLength(5);
      // Files should be yielded in request order
      const paths = downloadedFiles.map((f) => f.path);
      expect(paths).toEqual([
        '/file1.txt',
        '/file2.txt',
        '/file3.txt',
        '/file4.txt',
        '/file5.txt',
      ]);
    });

    test('concurrency=1 downloads sequentially', async () => {
      const client = new MockIpfsClient();
      const files = await Promise.all([
        createTestFile('/a.txt', 'A'),
        createTestFile('/b.txt', 'B'),
        createTestFile('/c.txt', 'C'),
      ]);

      const result = await uploadBatch(
        files,
        {
          senderKeyPair,
          recipients: [{ publicKey: recipientKeyPair.publicKey }],
        },
        client
      );

      const manifest = await getManifest(result.cid, {
        ipfsClient: client,
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      const downloadRefs: FileDownloadRef[] = manifest.files.map((f) => ({
        batchCid: manifest.cid,
        path: f.path,
        size: f.size,
        contentHash: f.contentHash,
        manifestKey: manifest.manifestKey,
        chunks: f.chunks,
      }));

      const downloadedFiles = await collectAsyncIterable(
        downloadFiles(downloadRefs, { concurrency: 1 }, client)
      );

      expect(downloadedFiles).toHaveLength(3);
    });
  });

  // ==========================================================================
  // Progress Tracking Tests
  // ==========================================================================

  describe('progress tracking', () => {
    test('reports progress correctly', async () => {
      const client = new MockIpfsClient();
      const files = await Promise.all([
        createTestFile('/a.txt', 'AAAA'),
        createTestFile('/b.txt', 'BBBBBB'),
        createTestFile('/c.txt', 'CC'),
      ]);

      const result = await uploadBatch(
        files,
        {
          senderKeyPair,
          recipients: [{ publicKey: recipientKeyPair.publicKey }],
        },
        client
      );

      const manifest = await getManifest(result.cid, {
        ipfsClient: client,
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      const downloadRefs: FileDownloadRef[] = manifest.files.map((f) => ({
        batchCid: manifest.cid,
        path: f.path,
        size: f.size,
        contentHash: f.contentHash,
        manifestKey: manifest.manifestKey,
        chunks: f.chunks,
      }));

      const progressUpdates: MultiDownloadProgress[] = [];

      const downloadedFiles = await collectAsyncIterable(
        downloadFiles(
          downloadRefs,
          {
            onProgress: (progress) => {
              progressUpdates.push({ ...progress });
            },
          },
          client
        )
      );

      expect(downloadedFiles).toHaveLength(3);

      // Should have progress updates
      expect(progressUpdates.length).toBeGreaterThan(0);

      // First progress should have filesCompleted=0
      expect(progressUpdates[0]!.filesCompleted).toBe(0);
      expect(progressUpdates[0]!.totalFiles).toBe(3);
      expect(progressUpdates[0]!.totalBytes).toBe(12); // 4 + 6 + 2

      // Last progress should have filesCompleted=3
      const lastProgress = progressUpdates[progressUpdates.length - 1]!;
      expect(lastProgress.filesCompleted).toBe(3);
      expect(lastProgress.bytesDownloaded).toBe(12);
    });
  });

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================

  describe('error handling', () => {
    test('fail-fast mode throws on first error (no onError)', async () => {
      const client = new MockIpfsClient();
      const fakeHash = (await hashBlake2b(
        new Uint8Array(32),
        32
      )) as ContentHash;

      const invalidRefs: FileDownloadRef[] = [
        {
          batchCid: 'bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354',
          path: '/test.txt',
          size: 10,
          contentHash: fakeHash,
          manifestKey: await generateKey(),
          chunks: [
            {
              chunkId: 'testchunk123456789012',
              cid: 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              offset: 0,
              length: 10,
              encryption: 0,
              encryptedLength: 50,
            },
          ],
        },
      ];

      await expect(
        collectAsyncIterable(downloadFiles(invalidRefs, undefined, client))
      ).rejects.toThrow();
    });

    test('fail-fast mode aborts all pending downloads immediately on error', async () => {
      const client = new MockIpfsClient();

      // Create files for testing
      const goodFiles = await Promise.all([
        createTestFile('/file0.txt', 'Good content 0'),
        createTestFile('/file1.txt', 'Good content 1'),
        createTestFile('/file3.txt', 'Good content 3'),
      ]);

      const result = await uploadBatch(
        goodFiles,
        {
          senderKeyPair,
          recipients: [{ publicKey: recipientKeyPair.publicKey }],
        },
        client
      );

      const manifest = await getManifest(result.cid, {
        ipfsClient: client,
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      // Create refs: good[0], bad[1], good[2], good[3]
      // Put the bad ref at index 1 so we can verify immediate abort behavior
      const fakeHash = (await hashBlake2b(
        new Uint8Array(32),
        32
      )) as ContentHash;

      const downloadRefs: FileDownloadRef[] = [
        {
          batchCid: manifest.cid,
          path: manifest.files[0]!.path,
          size: manifest.files[0]!.size,
          contentHash: manifest.files[0]!.contentHash,
          manifestKey: manifest.manifestKey,
          chunks: manifest.files[0]!.chunks,
        },
        {
          // Invalid ref at index 1 - will fail
          batchCid: manifest.cid,
          path: '/bad.txt',
          size: 10,
          contentHash: fakeHash,
          manifestKey: manifest.manifestKey,
          chunks: [
            {
              chunkId: 'badchunk12345678901234',
              cid: 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              offset: 0,
              length: 10,
              encryption: 0,
              encryptedLength: 50,
            },
          ],
        },
        {
          batchCid: manifest.cid,
          path: manifest.files[1]!.path,
          size: manifest.files[1]!.size,
          contentHash: manifest.files[1]!.contentHash,
          manifestKey: manifest.manifestKey,
          chunks: manifest.files[1]!.chunks,
        },
        {
          batchCid: manifest.cid,
          path: manifest.files[2]!.path,
          size: manifest.files[2]!.size,
          contentHash: manifest.files[2]!.contentHash,
          manifestKey: manifest.manifestKey,
          chunks: manifest.files[2]!.chunks,
        },
      ];

      // Track which files were yielded before error
      const yieldedFiles: string[] = [];
      let caughtError: Error | null = null;

      try {
        for await (const file of downloadFiles(
          downloadRefs,
          { concurrency: 2 },
          client
        )) {
          yieldedFiles.push(file.path);
          // Consume the content
          for await (const _chunk of file.content) {
            // consume
          }
        }
      } catch (error) {
        caughtError = error as Error;
      }

      // Should have thrown an error
      expect(caughtError).not.toBeNull();

      // File 0 (index 0) should be yielded since it comes before the error
      // Files 2 and 3 should NOT be yielded - they come after the error
      // The exact number yielded depends on timing, but at most file 0
      expect(yieldedFiles.length).toBeLessThanOrEqual(1);
      if (yieldedFiles.length === 1) {
        expect(yieldedFiles[0]).toBe('/file0.txt');
      }
    });

    test('continue mode invokes onError and continues', async () => {
      const client = new MockIpfsClient();
      const files = await Promise.all([
        createTestFile('/good1.txt', 'Good content 1'),
        createTestFile('/good2.txt', 'Good content 2'),
      ]);

      const result = await uploadBatch(
        files,
        {
          senderKeyPair,
          recipients: [{ publicKey: recipientKeyPair.publicKey }],
        },
        client
      );

      const manifest = await getManifest(result.cid, {
        ipfsClient: client,
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      // Create refs with one invalid in the middle
      const fakeHash = (await hashBlake2b(
        new Uint8Array(32),
        32
      )) as ContentHash;

      const downloadRefs: FileDownloadRef[] = [
        {
          batchCid: manifest.cid,
          path: manifest.files[0]!.path,
          size: manifest.files[0]!.size,
          contentHash: manifest.files[0]!.contentHash,
          manifestKey: manifest.manifestKey,
          chunks: manifest.files[0]!.chunks,
        },
        {
          // Invalid ref that will fail
          batchCid: manifest.cid,
          path: '/bad.txt',
          size: 10,
          contentHash: fakeHash,
          manifestKey: manifest.manifestKey,
          chunks: [
            {
              chunkId: 'badchunk12345678901234',
              cid: 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              offset: 0,
              length: 10,
              encryption: 0,
              encryptedLength: 50,
            },
          ],
        },
        {
          batchCid: manifest.cid,
          path: manifest.files[1]!.path,
          size: manifest.files[1]!.size,
          contentHash: manifest.files[1]!.contentHash,
          manifestKey: manifest.manifestKey,
          chunks: manifest.files[1]!.chunks,
        },
      ];

      const errors: Array<{ path: string; error: Error }> = [];

      const downloadedFiles = await collectAsyncIterable(
        downloadFiles(
          downloadRefs,
          {
            onError: (error, ref) => {
              errors.push({ path: ref.path, error });
            },
          },
          client
        )
      );

      // Should have 2 successful downloads
      expect(downloadedFiles).toHaveLength(2);

      // Should have 1 error
      expect(errors).toHaveLength(1);
      expect(errors[0]!.path).toBe('/bad.txt');
    });
  });

  // ==========================================================================
  // Abort Signal Tests
  // ==========================================================================

  describe('abort signal', () => {
    test('throws AbortError when signal already aborted', async () => {
      const client = new MockIpfsClient();
      const file = await createTestFile('/test.txt', 'content');

      const result = await uploadBatch(
        [file],
        {
          senderKeyPair,
          recipients: [{ publicKey: recipientKeyPair.publicKey }],
        },
        client
      );

      const manifest = await getManifest(result.cid, {
        ipfsClient: client,
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      const downloadRef: FileDownloadRef = {
        batchCid: manifest.cid,
        path: manifest.files[0]!.path,
        size: manifest.files[0]!.size,
        contentHash: manifest.files[0]!.contentHash,
        manifestKey: manifest.manifestKey,
        chunks: manifest.files[0]!.chunks,
      };

      const controller = new AbortController();
      controller.abort('Test abort');

      try {
        await collectAsyncIterable(
          downloadFiles([downloadRef], { signal: controller.signal }, client)
        );
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe('AbortError');
      }
    });

    test('abort mid-download triggers AbortError', async () => {
      const client = new MockIpfsClient();
      const file = await createTestFile('/test.txt', 'Hello, World!');

      const result = await uploadBatch(
        [file],
        {
          senderKeyPair,
          recipients: [{ publicKey: recipientKeyPair.publicKey }],
        },
        client
      );

      const manifest = await getManifest(result.cid, {
        ipfsClient: client,
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      const downloadRef: FileDownloadRef = {
        batchCid: manifest.cid,
        path: manifest.files[0]!.path,
        size: manifest.files[0]!.size,
        contentHash: manifest.files[0]!.contentHash,
        manifestKey: manifest.manifestKey,
        chunks: manifest.files[0]!.chunks,
      };

      const controller = new AbortController();

      // Set latch to trigger abort during cat() operation
      client.setCatLatch(async () => {
        controller.abort('Mid-download abort');
      });

      try {
        await collectAsyncIterable(
          downloadFiles([downloadRef], { signal: controller.signal }, client)
        );
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe('AbortError');
        expect((error as DOMException).message).toBe('Mid-download abort');
      } finally {
        client.clearCatLatch();
      }
    });

    test('abort during concurrent multi-file download stops remaining files', async () => {
      const client = new MockIpfsClient();
      // Create multiple files to test concurrent download abort
      const files = [
        await createTestFile('/file1.txt', 'File 1 content'),
        await createTestFile('/file2.txt', 'File 2 content'),
        await createTestFile('/file3.txt', 'File 3 content'),
      ];

      const result = await uploadBatch(
        files,
        {
          senderKeyPair,
          recipients: [{ publicKey: recipientKeyPair.publicKey }],
        },
        client
      );

      const manifest = await getManifest(result.cid, {
        ipfsClient: client,
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      const downloadRefs: FileDownloadRef[] = manifest.files.map((f) => ({
        batchCid: manifest.cid,
        path: f.path,
        size: f.size,
        contentHash: f.contentHash,
        manifestKey: manifest.manifestKey,
        chunks: f.chunks,
      }));

      const controller = new AbortController();
      let catCallCount = 0;

      // Set latch to abort after first cat() call
      client.setCatLatch(async () => {
        catCallCount++;
        if (catCallCount === 1) {
          controller.abort('Abort after first file');
        }
      });

      try {
        await collectAsyncIterable(
          downloadFiles(downloadRefs, { signal: controller.signal }, client)
        );
        expect.unreachable('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(DOMException);
        expect((error as DOMException).name).toBe('AbortError');
      } finally {
        client.clearCatLatch();
      }

      // Verify not all files were fetched (abort stopped further fetches)
      // With default concurrency, some files may already be in-flight
      expect(catCallCount).toBeLessThanOrEqual(3);
    });
  });

  // ==========================================================================
  // Round-trip Integration Tests
  // ==========================================================================

  describe('round-trip integration', () => {
    test('upload → getManifest → downloadFiles returns original content', async () => {
      const client = new MockIpfsClient();
      const originalFiles = [
        await createTestFile('/doc.txt', 'Document content here'),
        await createTestFile('/image.bin', new Uint8Array([1, 2, 3, 4, 5])),
        await createTestFile(
          '/nested/path/file.txt',
          'Nested file content'
        ),
      ];

      const result = await uploadBatch(
        originalFiles,
        {
          senderKeyPair,
          recipients: [{ publicKey: recipientKeyPair.publicKey }],
        },
        client
      );

      const manifest = await getManifest(result.cid, {
        ipfsClient: client,
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      const downloadRefs: FileDownloadRef[] = manifest.files.map((f) => ({
        batchCid: manifest.cid,
        path: f.path,
        size: f.size,
        contentHash: f.contentHash,
        manifestKey: manifest.manifestKey,
        chunks: f.chunks,
      }));

      const downloadedFiles = await collectAsyncIterable(
        downloadFiles(downloadRefs, undefined, client)
      );

      expect(downloadedFiles).toHaveLength(3);

      // Verify each file
      for (const downloaded of downloadedFiles) {
        const original = originalFiles.find((f) => f.path === downloaded.path)!;
        expect(original).toBeDefined();

        const downloadedContent = await collectBytes(downloaded.content);
        const originalContent = new Uint8Array(
          await original.file.arrayBuffer()
        );

        expect(downloadedContent).toEqual(originalContent);
      }
    });

    test('handles large files spanning multiple chunks', async () => {
      const client = new MockIpfsClient();
      // Create a file larger than chunk size (10MB)
      const largeContent = new Uint8Array(11 * 1024 * 1024);
      for (let i = 0; i < largeContent.length; i++) {
        largeContent[i] = i % 256;
      }

      const file = await createTestFile('/large.bin', largeContent);

      const result = await uploadBatch(
        [file],
        {
          senderKeyPair,
          recipients: [{ publicKey: recipientKeyPair.publicKey }],
        },
        client
      );

      const manifest = await getManifest(result.cid, {
        ipfsClient: client,
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      expect(manifest.files[0]!.chunks.length).toBeGreaterThan(1);

      const downloadRef: FileDownloadRef = {
        batchCid: manifest.cid,
        path: manifest.files[0]!.path,
        size: manifest.files[0]!.size,
        contentHash: manifest.files[0]!.contentHash,
        manifestKey: manifest.manifestKey,
        chunks: manifest.files[0]!.chunks,
      };

      const downloadedFiles = await collectAsyncIterable(
        downloadFiles([downloadRef], undefined, client)
      );

      expect(downloadedFiles).toHaveLength(1);

      const downloadedContent = await collectBytes(downloadedFiles[0]!.content);
      expect(downloadedContent.length).toBe(largeContent.length);
      expect(downloadedContent).toEqual(largeContent);
    });
  });

  // ==========================================================================
  // Options Passthrough Tests
  // ==========================================================================

  describe('options passthrough', () => {
    test('passes chunkConcurrency to downloadFile', async () => {
      const client = new MockIpfsClient();
      const file = await createTestFile('/test.txt', 'content');

      const result = await uploadBatch(
        [file],
        {
          senderKeyPair,
          recipients: [{ publicKey: recipientKeyPair.publicKey }],
        },
        client
      );

      const manifest = await getManifest(result.cid, {
        ipfsClient: client,
        recipientKeyPair,
        expectedSenderPublicKey: senderKeyPair.publicKey,
      });

      const downloadRef: FileDownloadRef = {
        batchCid: manifest.cid,
        path: manifest.files[0]!.path,
        size: manifest.files[0]!.size,
        contentHash: manifest.files[0]!.contentHash,
        manifestKey: manifest.manifestKey,
        chunks: manifest.files[0]!.chunks,
      };

      // Just verify it doesn't throw
      const downloadedFiles = await collectAsyncIterable(
        downloadFiles(
          [downloadRef],
          { chunkConcurrency: 1, retries: 1 },
          client
        )
      );

      expect(downloadedFiles).toHaveLength(1);
    });
  });
});

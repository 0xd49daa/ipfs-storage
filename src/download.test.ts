/**
 * Tests for Single File Download (Phase 14).
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import {
  preloadSodium,
  deriveEncryptionKeyPair,
  deriveSeed,
  hashBlake2b,
  type SymmetricKey,
  type ContentHash,
} from '@filemanager/encryptionv2';
import {
  downloadFile,
  uploadBatch,
  getManifest,
  MockIpfsClient,
  ValidationError,
  IntegrityError,
  ChunkUnavailableError,
  type FileInput,
  type FileDownloadRef,
  type DownloadOptions,
  type DownloadProgress,
  type BatchManifest,
} from './index.ts';

// ============================================================================
// Test Helpers
// ============================================================================

beforeAll(async () => {
  await preloadSodium();
});

/** Create a File object from string content */
function createFile(content: string, name = 'test.txt'): File {
  return new File([content], name, { type: 'text/plain' });
}

/** Create a File object from Uint8Array */
function createBinaryFile(data: Uint8Array, name = 'test.bin'): File {
  return new File([data], name, { type: 'application/octet-stream' });
}

/** Compute content hash for a string */
async function hashString(content: string): Promise<ContentHash> {
  const bytes = new TextEncoder().encode(content);
  return (await hashBlake2b(bytes, 32)) as ContentHash;
}

/** Compute content hash for Uint8Array */
async function hashBytes(data: Uint8Array): Promise<ContentHash> {
  return (await hashBlake2b(data, 32)) as ContentHash;
}

/** Create FileInput from string content */
async function createFileInput(
  content: string,
  path: string,
  name?: string
): Promise<FileInput> {
  return {
    file: createFile(content, name ?? path.split('/').pop()),
    path,
    contentHash: await hashString(content),
  };
}

/** Create FileInput from Uint8Array */
async function createBinaryFileInput(
  data: Uint8Array,
  path: string,
  name?: string
): Promise<FileInput> {
  return {
    file: createBinaryFile(data, name ?? path.split('/').pop()),
    path,
    contentHash: await hashBytes(data),
  };
}

// Test mnemonic (12 words)
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Create test key pair from mnemonic seed */
async function createTestKeyPair(index = 0) {
  const seed = await deriveSeed(TEST_MNEMONIC);
  return deriveEncryptionKeyPair(seed, index);
}

/** Collect async iterable to Uint8Array */
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

/** Upload a file and return ref for download */
async function uploadAndGetRef(
  content: string | Uint8Array,
  path: string,
  ipfsClient: MockIpfsClient
): Promise<{ ref: FileDownloadRef; originalContent: Uint8Array }> {
  const keyPair = await createTestKeyPair();
  const originalContent =
    typeof content === 'string' ? new TextEncoder().encode(content) : content;

  const file =
    typeof content === 'string'
      ? await createFileInput(content, path)
      : await createBinaryFileInput(content, path);

  const result = await uploadBatch(
    [file],
    {
      senderKeyPair: keyPair,
      recipients: [{ publicKey: keyPair.publicKey }],
    },
    ipfsClient
  );

  const manifest = await getManifest(result.cid, {
    ipfsClient,
    recipientKeyPair: keyPair,
    expectedSenderPublicKey: keyPair.publicKey,
  });

  const fileInfo = manifest.files[0]!;
  const ref: FileDownloadRef = {
    batchCid: manifest.cid,
    path: fileInfo.path,
    size: fileInfo.size,
    contentHash: fileInfo.contentHash,
    manifestKey: manifest.manifestKey,
    chunks: fileInfo.chunks,
  };

  return { ref, originalContent };
}

// ============================================================================
// Validation Tests
// ============================================================================

describe('downloadFile - validation', () => {
  test('throws ValidationError for empty batchCid', async () => {
    const ipfsClient = new MockIpfsClient();
    const ref: FileDownloadRef = {
      batchCid: '',
      path: '/test.txt',
      size: 10,
      contentHash: new Uint8Array(32) as ContentHash,
      manifestKey: new Uint8Array(32) as SymmetricKey,
      chunks: [],
    };

    await expect(collectBytes(downloadFile(ref, undefined, ipfsClient))).rejects.toThrow(
      ValidationError
    );
    await expect(collectBytes(downloadFile(ref, undefined, ipfsClient))).rejects.toThrow(
      'batchCid must be a non-empty string'
    );
  });

  test('throws ValidationError for empty path', async () => {
    const ipfsClient = new MockIpfsClient();
    const ref: FileDownloadRef = {
      batchCid: 'bafytest',
      path: '',
      size: 10,
      contentHash: new Uint8Array(32) as ContentHash,
      manifestKey: new Uint8Array(32) as SymmetricKey,
      chunks: [],
    };

    await expect(collectBytes(downloadFile(ref, undefined, ipfsClient))).rejects.toThrow(
      ValidationError
    );
    await expect(collectBytes(downloadFile(ref, undefined, ipfsClient))).rejects.toThrow(
      'path must be a non-empty string'
    );
  });

  test('throws ValidationError for negative size', async () => {
    const ipfsClient = new MockIpfsClient();
    const ref: FileDownloadRef = {
      batchCid: 'bafytest',
      path: '/test.txt',
      size: -1,
      contentHash: new Uint8Array(32) as ContentHash,
      manifestKey: new Uint8Array(32) as SymmetricKey,
      chunks: [],
    };

    await expect(collectBytes(downloadFile(ref, undefined, ipfsClient))).rejects.toThrow(
      ValidationError
    );
    await expect(collectBytes(downloadFile(ref, undefined, ipfsClient))).rejects.toThrow(
      'size must be a non-negative number'
    );
  });

  test('throws ValidationError for non-empty file with no chunks', async () => {
    const ipfsClient = new MockIpfsClient();
    const ref: FileDownloadRef = {
      batchCid: 'bafytest',
      path: '/test.txt',
      size: 100,
      contentHash: new Uint8Array(32) as ContentHash,
      manifestKey: new Uint8Array(32) as SymmetricKey,
      chunks: [],
    };

    await expect(collectBytes(downloadFile(ref, undefined, ipfsClient))).rejects.toThrow(
      ValidationError
    );
    await expect(collectBytes(downloadFile(ref, undefined, ipfsClient))).rejects.toThrow(
      'non-empty file must have at least one chunk'
    );
  });

  test('throws ValidationError for chunkConcurrency < 1', async () => {
    const ipfsClient = new MockIpfsClient();
    const ref: FileDownloadRef = {
      batchCid: 'bafytest',
      path: '/test.txt',
      size: 0, // Empty file to avoid chunk validation
      contentHash: new Uint8Array(32) as ContentHash,
      manifestKey: new Uint8Array(32) as SymmetricKey,
      chunks: [],
    };

    await expect(
      collectBytes(downloadFile(ref, { chunkConcurrency: 0 }, ipfsClient))
    ).rejects.toThrow(ValidationError);
    await expect(
      collectBytes(downloadFile(ref, { chunkConcurrency: 0 }, ipfsClient))
    ).rejects.toThrow('chunkConcurrency must be at least 1');

    await expect(
      collectBytes(downloadFile(ref, { chunkConcurrency: -1 }, ipfsClient))
    ).rejects.toThrow(ValidationError);
  });
});

// ============================================================================
// Basic Functionality Tests
// ============================================================================

describe('downloadFile - basic functionality', () => {
  test('downloads single-chunk file correctly', async () => {
    const ipfsClient = new MockIpfsClient();
    const { ref, originalContent } = await uploadAndGetRef(
      'Hello, World!',
      '/test.txt',
      ipfsClient
    );

    const downloaded = await collectBytes(downloadFile(ref, undefined, ipfsClient));

    expect(downloaded).toEqual(originalContent);
  });

  test('returns correct bytes matching original content', async () => {
    const ipfsClient = new MockIpfsClient();
    const content = 'The quick brown fox jumps over the lazy dog.';
    const { ref, originalContent } = await uploadAndGetRef(
      content,
      '/fox.txt',
      ipfsClient
    );

    const downloaded = await collectBytes(downloadFile(ref, undefined, ipfsClient));

    expect(new TextDecoder().decode(downloaded)).toBe(content);
    expect(downloaded).toEqual(originalContent);
  });

  test('handles empty file (size 0)', async () => {
    const ipfsClient = new MockIpfsClient();
    const { ref, originalContent } = await uploadAndGetRef('', '/empty.txt', ipfsClient);

    expect(ref.size).toBe(0);
    expect(ref.chunks.length).toBe(0);

    const downloaded = await collectBytes(downloadFile(ref, undefined, ipfsClient));

    expect(downloaded.length).toBe(0);
    expect(downloaded).toEqual(originalContent);
  });

  test('progress callback fires with correct values', async () => {
    const ipfsClient = new MockIpfsClient();
    const { ref } = await uploadAndGetRef('Hello, World!', '/test.txt', ipfsClient);

    const progressUpdates: DownloadProgress[] = [];
    const options: DownloadOptions = {
      onProgress: (progress) => progressUpdates.push({ ...progress }),
    };

    await collectBytes(downloadFile(ref, options, ipfsClient));

    expect(progressUpdates.length).toBeGreaterThan(0);

    // Final progress should show all bytes downloaded
    const finalProgress = progressUpdates[progressUpdates.length - 1]!;
    expect(finalProgress.bytesDownloaded).toBe(ref.size);
    expect(finalProgress.totalBytes).toBe(ref.size);
  });
});

// ============================================================================
// Multi-chunk File Tests
// ============================================================================

describe('downloadFile - multi-chunk files', () => {
  test('handles file with binary content', async () => {
    const ipfsClient = new MockIpfsClient();

    // Create binary content with various byte values
    const binaryContent = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      binaryContent[i] = i;
    }

    const { ref, originalContent } = await uploadAndGetRef(
      binaryContent,
      '/binary.bin',
      ipfsClient
    );

    const downloaded = await collectBytes(downloadFile(ref, undefined, ipfsClient));

    expect(downloaded).toEqual(originalContent);
  });

  test('handles larger file content', async () => {
    const ipfsClient = new MockIpfsClient();

    // Create 100KB of content
    const largeContent = new Uint8Array(100 * 1024);
    for (let i = 0; i < largeContent.length; i++) {
      largeContent[i] = i % 256;
    }

    const { ref, originalContent } = await uploadAndGetRef(
      largeContent,
      '/large.bin',
      ipfsClient
    );

    const downloaded = await collectBytes(downloadFile(ref, undefined, ipfsClient));

    expect(downloaded.length).toBe(originalContent.length);
    expect(downloaded).toEqual(originalContent);
  });
});

// ============================================================================
// Concurrent Fetch Tests
// ============================================================================

describe('downloadFile - concurrent fetch', () => {
  test('chunkConcurrency=1 works correctly', async () => {
    const ipfsClient = new MockIpfsClient();
    const { ref, originalContent } = await uploadAndGetRef(
      'Hello, World!',
      '/test.txt',
      ipfsClient
    );

    const downloaded = await collectBytes(
      downloadFile(ref, { chunkConcurrency: 1 }, ipfsClient)
    );

    expect(downloaded).toEqual(originalContent);
  });

  test('chunkConcurrency=3 works correctly', async () => {
    const ipfsClient = new MockIpfsClient();
    const { ref, originalContent } = await uploadAndGetRef(
      'Hello, World!',
      '/test.txt',
      ipfsClient
    );

    const downloaded = await collectBytes(
      downloadFile(ref, { chunkConcurrency: 3 }, ipfsClient)
    );

    expect(downloaded).toEqual(originalContent);
  });
});

// ============================================================================
// Retry Logic Tests
// ============================================================================

describe('downloadFile - retry logic', () => {
  test('throws ChunkUnavailableError after retries exhausted', async () => {
    const ipfsClient = new MockIpfsClient();
    const { ref } = await uploadAndGetRef('Hello, World!', '/test.txt', ipfsClient);

    // Clear the client so the chunk is no longer available
    ipfsClient.clear();

    await expect(
      collectBytes(downloadFile(ref, { retries: 2 }, ipfsClient))
    ).rejects.toThrow(ChunkUnavailableError);
  });

  test('ChunkUnavailableError includes batchCid and chunkId', async () => {
    const ipfsClient = new MockIpfsClient();
    const { ref } = await uploadAndGetRef('Hello, World!', '/test.txt', ipfsClient);

    // Clear the client so the chunk is no longer available
    ipfsClient.clear();

    try {
      await collectBytes(downloadFile(ref, { retries: 1 }, ipfsClient));
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ChunkUnavailableError);
      const chunkError = error as ChunkUnavailableError;
      expect(chunkError.batchCid).toBe(ref.batchCid);
      expect(chunkError.chunkId).toBe(ref.chunks[0]!.chunkId);
    }
  });
});

// ============================================================================
// Integrity Verification Tests
// ============================================================================

describe('downloadFile - integrity verification', () => {
  test('valid file passes integrity check silently', async () => {
    const ipfsClient = new MockIpfsClient();
    const { ref, originalContent } = await uploadAndGetRef(
      'Hello, World!',
      '/test.txt',
      ipfsClient
    );

    // Should not throw
    const downloaded = await collectBytes(downloadFile(ref, undefined, ipfsClient));
    expect(downloaded).toEqual(originalContent);
  });

  test('empty file verifies empty content hash', async () => {
    const ipfsClient = new MockIpfsClient();
    const { ref } = await uploadAndGetRef('', '/empty.txt', ipfsClient);

    // Should not throw - empty file with correct hash
    const downloaded = await collectBytes(downloadFile(ref, undefined, ipfsClient));
    expect(downloaded.length).toBe(0);
  });

  test('integrityMode strict is the default', async () => {
    const ipfsClient = new MockIpfsClient();
    const { ref, originalContent } = await uploadAndGetRef(
      'Hello, World!',
      '/test.txt',
      ipfsClient
    );

    // Without explicitly setting integrityMode, should still verify
    const downloaded = await collectBytes(downloadFile(ref, undefined, ipfsClient));
    expect(downloaded).toEqual(originalContent);
  });

  test('integrityMode warn allows passing callback', async () => {
    const ipfsClient = new MockIpfsClient();
    const { ref, originalContent } = await uploadAndGetRef(
      'Hello, World!',
      '/test.txt',
      ipfsClient
    );

    // No error expected because file is valid
    let callbackCalled = false;
    const downloaded = await collectBytes(
      downloadFile(
        ref,
        {
          integrityMode: 'warn',
          onIntegrityError: () => {
            callbackCalled = true;
          },
        },
        ipfsClient
      )
    );

    expect(downloaded).toEqual(originalContent);
    expect(callbackCalled).toBe(false); // No error, so callback not called
  });
});

// ============================================================================
// Abort Signal Tests
// ============================================================================

describe('downloadFile - abort signal', () => {
  test('throws AbortError when signal already aborted', async () => {
    const ipfsClient = new MockIpfsClient();
    const { ref } = await uploadAndGetRef('Hello, World!', '/test.txt', ipfsClient);

    const controller = new AbortController();
    controller.abort();

    try {
      await collectBytes(downloadFile(ref, { signal: controller.signal }, ipfsClient));
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('AbortError');
    }
  });

  test('abort reason preserved in error', async () => {
    const ipfsClient = new MockIpfsClient();
    const { ref } = await uploadAndGetRef('Hello, World!', '/test.txt', ipfsClient);

    const controller = new AbortController();
    controller.abort('Custom abort reason');

    try {
      await collectBytes(downloadFile(ref, { signal: controller.signal }, ipfsClient));
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('AbortError');
      expect((error as DOMException).message).toBe('Custom abort reason');
    }
  });

  test('abort mid-download triggers AbortError', async () => {
    const ipfsClient = new MockIpfsClient();
    const { ref } = await uploadAndGetRef('Hello, World!', '/test.txt', ipfsClient);

    const controller = new AbortController();
    let latchResolve: () => void;
    const latchPromise = new Promise<void>((resolve) => {
      latchResolve = resolve;
    });

    // Set latch to pause during cat() and trigger abort
    ipfsClient.setCatLatch(async () => {
      // Trigger abort while we're mid-fetch
      controller.abort('Mid-download abort');
      // Allow the fetch to complete so we can see the abort check
      latchResolve();
    });

    try {
      await collectBytes(downloadFile(ref, { signal: controller.signal }, ipfsClient));
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('AbortError');
    } finally {
      ipfsClient.clearCatLatch();
    }
  });

  test('abort during multi-chunk download stops after current chunk', async () => {
    const ipfsClient = new MockIpfsClient();
    // Create a file larger than 10MB to get multiple chunks
    const largeContent = new Uint8Array(11 * 1024 * 1024);
    for (let i = 0; i < largeContent.length; i++) {
      largeContent[i] = i % 256;
    }
    const { ref } = await uploadAndGetRef(largeContent, '/large.bin', ipfsClient);

    // Verify we have multiple chunks
    expect(ref.chunks.length).toBeGreaterThan(1);

    const controller = new AbortController();
    let catCallCount = 0;

    // Set latch to abort after first chunk fetch
    ipfsClient.setCatLatch(async () => {
      catCallCount++;
      if (catCallCount === 1) {
        // Abort after first chunk is fetched
        controller.abort('Abort after first chunk');
      }
    });

    try {
      await collectBytes(downloadFile(ref, { signal: controller.signal }, ipfsClient));
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('AbortError');
    } finally {
      ipfsClient.clearCatLatch();
    }

    // Verify not all chunks were fetched (abort stopped further fetches)
    // With concurrency=3 default, up to 3 chunks may be in-flight initially
    expect(catCallCount).toBeLessThanOrEqual(3);
  });
});

// ============================================================================
// Round-trip Integration Tests
// ============================================================================

describe('downloadFile - round-trip integration', () => {
  test('upload → getManifest → downloadFile returns original content', async () => {
    const ipfsClient = new MockIpfsClient();
    const keyPair = await createTestKeyPair();
    const content = 'Integration test content';

    // Upload
    const file = await createFileInput(content, '/integration.txt');
    const uploadResult = await uploadBatch(
      [file],
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      },
      ipfsClient
    );

    // Get manifest
    const manifest = await getManifest(uploadResult.cid, {
      ipfsClient,
      recipientKeyPair: keyPair,
      expectedSenderPublicKey: keyPair.publicKey,
    });

    // Download
    const fileInfo = manifest.files[0]!;
    const ref: FileDownloadRef = {
      batchCid: manifest.cid,
      path: fileInfo.path,
      size: fileInfo.size,
      contentHash: fileInfo.contentHash,
      manifestKey: manifest.manifestKey,
      chunks: fileInfo.chunks,
    };

    const downloaded = await collectBytes(downloadFile(ref, undefined, ipfsClient));

    expect(new TextDecoder().decode(downloaded)).toBe(content);
  });

  test('works with multiple files in batch', async () => {
    const ipfsClient = new MockIpfsClient();
    const keyPair = await createTestKeyPair();

    const files = [
      await createFileInput('Content 1', '/file1.txt'),
      await createFileInput('Content 2', '/file2.txt'),
      await createFileInput('Content 3', '/file3.txt'),
    ];

    const uploadResult = await uploadBatch(
      files,
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      },
      ipfsClient
    );

    const manifest = await getManifest(uploadResult.cid, {
      ipfsClient,
      recipientKeyPair: keyPair,
      expectedSenderPublicKey: keyPair.publicKey,
    });

    // Download each file and verify
    for (let i = 0; i < manifest.files.length; i++) {
      const fileInfo = manifest.files[i]!;
      const ref: FileDownloadRef = {
        batchCid: manifest.cid,
        path: fileInfo.path,
        size: fileInfo.size,
        contentHash: fileInfo.contentHash,
        manifestKey: manifest.manifestKey,
        chunks: fileInfo.chunks,
      };

      const downloaded = await collectBytes(downloadFile(ref, undefined, ipfsClient));
      const expectedContent = `Content ${i + 1}`;
      expect(new TextDecoder().decode(downloaded)).toBe(expectedContent);
    }
  });

  test('handles batch with empty and non-empty files', async () => {
    const ipfsClient = new MockIpfsClient();
    const keyPair = await createTestKeyPair();

    const files = [
      await createFileInput('', '/empty.txt'),
      await createFileInput('Not empty', '/notempty.txt'),
    ];

    const uploadResult = await uploadBatch(
      files,
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      },
      ipfsClient
    );

    const manifest = await getManifest(uploadResult.cid, {
      ipfsClient,
      recipientKeyPair: keyPair,
      expectedSenderPublicKey: keyPair.publicKey,
    });

    // Download empty file
    const emptyFile = manifest.files.find((f) => f.path === '/empty.txt')!;
    const emptyRef: FileDownloadRef = {
      batchCid: manifest.cid,
      path: emptyFile.path,
      size: emptyFile.size,
      contentHash: emptyFile.contentHash,
      manifestKey: manifest.manifestKey,
      chunks: emptyFile.chunks,
    };
    const emptyDownloaded = await collectBytes(
      downloadFile(emptyRef, undefined, ipfsClient)
    );
    expect(emptyDownloaded.length).toBe(0);

    // Download non-empty file
    const nonEmptyFile = manifest.files.find((f) => f.path === '/notempty.txt')!;
    const nonEmptyRef: FileDownloadRef = {
      batchCid: manifest.cid,
      path: nonEmptyFile.path,
      size: nonEmptyFile.size,
      contentHash: nonEmptyFile.contentHash,
      manifestKey: manifest.manifestKey,
      chunks: nonEmptyFile.chunks,
    };
    const nonEmptyDownloaded = await collectBytes(
      downloadFile(nonEmptyRef, undefined, ipfsClient)
    );
    expect(new TextDecoder().decode(nonEmptyDownloaded)).toBe('Not empty');
  });
});

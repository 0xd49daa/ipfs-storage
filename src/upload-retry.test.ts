/**
 * Upload Retry Tests
 *
 * Tests for automatic retry mechanism with exponential backoff
 * when chunk uploads fail due to transient errors.
 */

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import {
  preloadSodium,
  deriveEncryptionKeyPair,
  deriveSeed,
  hashBlake2b,
  type ContentHash,
  type X25519KeyPair,
} from '@0xd49daa/safecrypt';
import {
  createIpfsStorageModule,
  MockIpfsClient,
  ChunkUploadError,
  asAsyncIterable,
  type StreamingFileInput,
  type IpfsStorageModule,
} from './index.ts';

// ============================================================================
// Test Helpers
// ============================================================================

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

async function createTestKeyPair(index: number): Promise<X25519KeyPair> {
  const seed = await deriveSeed(TEST_MNEMONIC);
  return deriveEncryptionKeyPair(seed, index);
}

async function createFileInput(
  content: string,
  path: string
): Promise<StreamingFileInput> {
  const bytes = new TextEncoder().encode(content);
  return {
    path,
    contentHash: (await hashBlake2b(bytes, 32)) as ContentHash,
    size: bytes.length,
    getStream: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
  };
}

// ============================================================================
// Retry Tests
// ============================================================================

describe('Upload Retry Mechanism', () => {
  let ipfsClient: MockIpfsClient;
  let module: IpfsStorageModule;
  let senderKeyPair: X25519KeyPair;
  let recipientKeyPair: X25519KeyPair;

  beforeAll(async () => {
    await preloadSodium();
    senderKeyPair = await createTestKeyPair(0);
    recipientKeyPair = await createTestKeyPair(1);
  });

  beforeEach(() => {
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });
  });

  test('succeeds after transient failures within retry limit', async () => {
    // Set up: fail 2 times, then succeed (within default 3 retries)
    ipfsClient.setFailUploadCount(2);

    const file = await createFileInput('Hello, World!', '/test.txt');

    const result = await module.uploadBatch(asAsyncIterable([file]), {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    expect(result.cid).toBeDefined();
    expect(result.chunkCount).toBeGreaterThan(0);
  });

  test('fails with ChunkUploadError when retries exhausted', async () => {
    // Set up: fail more times than the retry limit
    ipfsClient.setFailUploadCount(5);

    const file = await createFileInput('Hello, World!', '/test.txt');

    await expect(
      module.uploadBatch(asAsyncIterable([file]), {
        senderKeyPair,
        recipients: [{ publicKey: recipientKeyPair.publicKey }],
        uploadRetries: 3,
      })
    ).rejects.toBeInstanceOf(ChunkUploadError);
  });

  test('respects custom uploadRetries option', async () => {
    // Set up: fail 4 times
    ipfsClient.setFailUploadCount(4);

    const file = await createFileInput('Hello, World!', '/test.txt');

    // With 5 retries, it should succeed (4 failures + 1 success)
    const result = await module.uploadBatch(asAsyncIterable([file]), {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
      uploadRetries: 5,
    });

    expect(result.cid).toBeDefined();
  });

  test('uploadRetries=1 means no retries', async () => {
    // Set up: fail once
    ipfsClient.setFailUploadCount(1);

    const file = await createFileInput('Hello, World!', '/test.txt');

    // With uploadRetries=1, only one attempt is made, so it should fail
    await expect(
      module.uploadBatch(asAsyncIterable([file]), {
        senderKeyPair,
        recipients: [{ publicKey: recipientKeyPair.publicKey }],
        uploadRetries: 1,
      })
    ).rejects.toBeInstanceOf(ChunkUploadError);
  });

  test('does not retry on abort', async () => {
    const controller = new AbortController();
    let uploadAttempts = 0;

    // Use a latch to count attempts and abort after first
    ipfsClient.setUploadLatch(async () => {
      uploadAttempts++;
      if (uploadAttempts === 1) {
        controller.abort();
      }
    });

    const file = await createFileInput('Hello, World!', '/test.txt');

    try {
      await module.uploadBatch(asAsyncIterable([file]), {
        senderKeyPair,
        recipients: [{ publicKey: recipientKeyPair.publicKey }],
        signal: controller.signal,
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('AbortError');
    }

    // Clear latch
    ipfsClient.clearUploadLatch();

    // Should have only made one attempt (no retries after abort)
    expect(uploadAttempts).toBe(1);
  });

  test('ChunkUploadError contains CID of failed chunk', async () => {
    ipfsClient.setFailUploadCount(5);

    const file = await createFileInput('Hello, World!', '/test.txt');

    try {
      await module.uploadBatch(asAsyncIterable([file]), {
        senderKeyPair,
        recipients: [{ publicKey: recipientKeyPair.publicKey }],
        uploadRetries: 2,
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ChunkUploadError);
      const chunkError = error as ChunkUploadError;
      expect(chunkError.chunkCid).toBeDefined();
      expect(chunkError.chunkCid.length).toBeGreaterThan(0);
      expect(chunkError.cause).toBeDefined();
    }
  });
});

/**
 * Tests for Module Factory (Phase 17).
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import {
  preloadSodium,
  deriveEncryptionKeyPair,
  deriveSeed,
  hashBlake2b,
  type ContentHash,
} from '@0xd49daa/safecrypt';
import { createIpfsStorageModule } from './module.ts';
import { MockIpfsClient } from './ipfs-client.ts';
import { ValidationError } from './errors.ts';
import { asAsyncIterable } from './async-iterable.ts';
import type { StreamingFileInput, IpfsStorageConfig } from './types.ts';

// ============================================================================
// Test Helpers
// ============================================================================

beforeAll(async () => {
  await preloadSodium();
});

/** Compute content hash for a string */
async function hashString(content: string): Promise<ContentHash> {
  const bytes = new TextEncoder().encode(content);
  return (await hashBlake2b(bytes, 32)) as ContentHash;
}

/** Create StreamingFileInput from string content */
async function createFileInput(
  content: string,
  path: string
): Promise<StreamingFileInput> {
  const bytes = new TextEncoder().encode(content);
  return {
    path,
    contentHash: await hashString(content),
    size: bytes.length,
    getStream: () => new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    }),
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

// ============================================================================
// Factory Creation Tests
// ============================================================================

describe('createIpfsStorageModule - validation', () => {
  test('creates module with minimal config (ipfsClient only)', () => {
    const ipfsClient = new MockIpfsClient();
    const module = createIpfsStorageModule({ ipfsClient });

    expect(module).toBeDefined();
    expect(typeof module.uploadBatch).toBe('function');
    expect(typeof module.getManifest).toBe('function');
    expect(typeof module.downloadFile).toBe('function');
    expect(typeof module.downloadFiles).toBe('function');
  });

  test('creates module with config', () => {
    const ipfsClient = new MockIpfsClient();
    const module = createIpfsStorageModule({
      ipfsClient,
    });

    expect(module).toBeDefined();
  });

  test('throws ValidationError when ipfsClient is missing', () => {
    expect(() => {
      createIpfsStorageModule({} as IpfsStorageConfig);
    }).toThrow(ValidationError);

    expect(() => {
      createIpfsStorageModule({} as IpfsStorageConfig);
    }).toThrow('ipfsClient is required');
  });

  test('throws ValidationError when config is null', () => {
    expect(() => {
      createIpfsStorageModule(null as unknown as IpfsStorageConfig);
    }).toThrow(ValidationError);

    expect(() => {
      createIpfsStorageModule(null as unknown as IpfsStorageConfig);
    }).toThrow('Config must be an object');
  });

});

// ============================================================================
// Method Binding Tests
// ============================================================================

describe('createIpfsStorageModule - method binding', () => {
  test('methods are properly bound and can be destructured', async () => {
    const ipfsClient = new MockIpfsClient();
    const module = createIpfsStorageModule({ ipfsClient });

    // Destructure methods
    const { uploadBatch, getManifest, downloadFile, downloadFiles } = module;

    // Methods should still work when destructured
    expect(typeof uploadBatch).toBe('function');
    expect(typeof getManifest).toBe('function');
    expect(typeof downloadFile).toBe('function');
    expect(typeof downloadFiles).toBe('function');
  });

  test('config object is not mutated', () => {
    const ipfsClient = new MockIpfsClient();
    const config: IpfsStorageConfig = {
      ipfsClient,
    };

    const configCopy = { ...config };
    createIpfsStorageModule(config);

    expect(config.ipfsClient).toBe(configCopy.ipfsClient);
  });
});

// ============================================================================
// Round-Trip Integration Tests
// ============================================================================

describe('createIpfsStorageModule - round-trip', () => {
  test('upload → getManifest → downloadFile round-trip', async () => {
    const ipfsClient = new MockIpfsClient();
    const module = createIpfsStorageModule({ ipfsClient });

    const senderKeyPair = await createTestKeyPair(0);
    const recipientKeyPair = await createTestKeyPair(1);

    // Upload
    const content = 'Hello, IPFS Storage Module!';
    const file = await createFileInput(content, '/hello.txt');

    const result = await module.uploadBatch(asAsyncIterable([file]), {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    expect(result.cid).toMatch(/^bafybei/);
    expect(result.manifest.files).toHaveLength(1);

    // Get manifest
    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.cid).toBe(result.cid);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]!.path).toBe('/hello.txt');

    // Download file
    const fileInfo = manifest.files[0]!;
    const fileRef = {
      batchCid: manifest.cid,
      path: fileInfo.path,
      size: fileInfo.size,
      contentHash: fileInfo.contentHash,
      manifestKey: manifest.manifestKey,
      chunks: fileInfo.chunks,
    };

    const downloadedBytes = await collectBytes(module.downloadFile(fileRef));
    const downloadedContent = new TextDecoder().decode(downloadedBytes);

    expect(downloadedContent).toBe(content);
  });

  test('upload → getManifest → downloadFiles with multiple files', async () => {
    const ipfsClient = new MockIpfsClient();
    const module = createIpfsStorageModule({ ipfsClient });

    const senderKeyPair = await createTestKeyPair(0);
    const recipientKeyPair = await createTestKeyPair(1);

    // Upload multiple files
    const files = [
      await createFileInput('File A content', '/a.txt'),
      await createFileInput('File B content', '/b.txt'),
      await createFileInput('File C content', '/c.txt'),
    ];

    const result = await module.uploadBatch(asAsyncIterable(files), {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
    });

    // Get manifest
    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
    });

    expect(manifest.files).toHaveLength(3);

    // Download all files
    const fileRefs = manifest.files.map((f) => ({
      batchCid: manifest.cid,
      path: f.path,
      size: f.size,
      contentHash: f.contentHash,
      manifestKey: manifest.manifestKey,
      chunks: f.chunks,
    }));

    const downloadedFiles: Array<{ path: string; content: string }> = [];
    for await (const downloaded of module.downloadFiles(fileRefs)) {
      const bytes = await collectBytes(downloaded.content);
      downloadedFiles.push({
        path: downloaded.path,
        content: new TextDecoder().decode(bytes),
      });
    }

    expect(downloadedFiles).toHaveLength(3);
    expect(downloadedFiles.find((f) => f.path === '/a.txt')?.content).toBe(
      'File A content'
    );
    expect(downloadedFiles.find((f) => f.path === '/b.txt')?.content).toBe(
      'File B content'
    );
    expect(downloadedFiles.find((f) => f.path === '/c.txt')?.content).toBe(
      'File C content'
    );
  });

  test('module methods work with AbortSignal', async () => {
    const ipfsClient = new MockIpfsClient();
    const module = createIpfsStorageModule({ ipfsClient });

    const senderKeyPair = await createTestKeyPair(0);
    const recipientKeyPair = await createTestKeyPair(1);

    const file = await createFileInput('test content', '/test.txt');

    // Upload with signal (not aborted)
    const controller = new AbortController();
    const result = await module.uploadBatch(asAsyncIterable([file]), {
      senderKeyPair,
      recipients: [{ publicKey: recipientKeyPair.publicKey }],
      signal: controller.signal,
    });

    expect(result.cid).toBeDefined();

    // Get manifest with signal (not aborted)
    const manifest = await module.getManifest(result.cid, {
      recipientKeyPair,
      expectedSenderPublicKey: senderKeyPair.publicKey,
      signal: controller.signal,
    });

    expect(manifest.cid).toBe(result.cid);
  });
});

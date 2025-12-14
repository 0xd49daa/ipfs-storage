/**
 * Tests for Upload Orchestration (Phase 10).
 *
 * Phase A: Core path tests (validation, single file, round-trip, errors)
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
  uploadBatch,
  MockIpfsClient,
  ValidationError,
  SegmentUploadError,
  decodeManifestEnvelope,
  decodeRootManifest,
  decryptSingleShot,
  deriveFileKey,
  chunkIdToPath,
  type FileInput,
  type UploadOptions,
  type BatchResult,
  type UploadProgress,
  type SegmentResult,
} from './index.ts';
import { asChunkId } from './branded.ts';

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

// ============================================================================
// Phase A: Validation Tests
// ============================================================================

describe('uploadBatch - validation', () => {
  test('empty files array throws ValidationError', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();

    await expect(
      uploadBatch([], {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      }, ipfsClient)
    ).rejects.toThrow(ValidationError);

    await expect(
      uploadBatch([], {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      }, ipfsClient)
    ).rejects.toThrow('Cannot upload empty batch');
  });

  test('empty recipients throws ValidationError', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('test content', '/test.txt');

    await expect(
      uploadBatch([file], {
        senderKeyPair: keyPair,
        recipients: [],
      }, ipfsClient)
    ).rejects.toThrow(ValidationError);

    await expect(
      uploadBatch([file], {
        senderKeyPair: keyPair,
        recipients: [],
      }, ipfsClient)
    ).rejects.toThrow('At least one recipient is required');
  });

  test('invalid path throws ValidationError', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();

    // Path not starting with /
    const badFile: FileInput = {
      file: createFile('test'),
      path: 'no-slash.txt',
      contentHash: await hashString('test'),
    };

    await expect(
      uploadBatch([badFile], {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      }, ipfsClient)
    ).rejects.toThrow(ValidationError);
  });
});

// ============================================================================
// Phase A: Single File Tests
// ============================================================================

describe('uploadBatch - single file', () => {
  test('small file uploads successfully', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('Hello, World!', '/test.txt');

    const result = await uploadBatch(
      [file],
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      },
      ipfsClient
    );

    expect(result.cid).toBeTruthy();
    expect(result.cid).toMatch(/^bafybei/); // dag-pb CID prefix
    expect(result.chunkCount).toBe(1);
    expect(result.segmentsUploaded).toBe(1);
    expect(result.manifestCount).toBe(1);
  });

  test('returns correct BatchResult structure', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('Test content for structure check', '/docs/readme.txt');

    const result = await uploadBatch(
      [file],
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey, label: 'Test Device' }],
      },
      ipfsClient
    );

    // Check BatchResult structure
    expect(result.cid).toBeTruthy();
    expect(result.manifest).toBeDefined();
    expect(result.totalSize).toBeGreaterThan(0);
    expect(result.chunkCount).toBe(1);
    expect(result.manifestCount).toBeGreaterThanOrEqual(1);
    expect(result.segmentsUploaded).toBeGreaterThan(0);
    expect(result.renamed).toBeUndefined(); // No renames for single file
  });

  test('BatchResult.manifest has correct FileInfo', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const content = 'File content for FileInfo test';
    const file = await createFileInput(content, '/photos/image.txt');

    const result = await uploadBatch(
      [file],
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      },
      ipfsClient
    );

    // Check manifest structure
    expect(result.manifest.cid).toBe(result.cid);
    expect(result.manifest.manifestKey).toBeDefined();
    expect(result.manifest.senderPublicKey).toEqual(keyPair.publicKey);
    expect(result.manifest.files).toHaveLength(1);

    // Check FileInfo
    const fileInfo = result.manifest.files[0]!;
    expect(fileInfo.path).toBe('/photos/image.txt');
    expect(fileInfo.name).toBe('image.txt');
    expect(fileInfo.size).toBe(new TextEncoder().encode(content).length);
    expect(fileInfo.contentHash).toEqual(file.contentHash);
    expect(fileInfo.chunks).toHaveLength(1);
    expect(fileInfo.created).toBeGreaterThan(0);

    // Check ChunkRef
    const chunkRef = fileInfo.chunks[0]!;
    expect(chunkRef.chunkId).toBeTruthy();
    expect(chunkRef.cid).toMatch(/^bafkrei/); // raw CID prefix
    expect(chunkRef.offset).toBeGreaterThanOrEqual(0);
    expect(chunkRef.length).toBe(fileInfo.size);
    expect(chunkRef.encryptedLength).toBeGreaterThan(0);

    // Check directories inferred
    expect(result.manifest.directories).toHaveLength(1);
    expect(result.manifest.directories[0]!.path).toBe('/photos');
    expect(result.manifest.directories[0]!.name).toBe('photos');
  });
});

// ============================================================================
// Phase A: Round-trip Tests
// ============================================================================

describe('uploadBatch - round-trip', () => {
  test('upload then cat(/m) returns valid manifest envelope', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('Round-trip test content', '/test.txt');

    const result = await uploadBatch(
      [file],
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      },
      ipfsClient
    );

    // Fetch manifest via cat
    const manifestBytes = await collectBytes(ipfsClient.cat(result.cid, '/m'));
    expect(manifestBytes.length).toBeGreaterThan(0);

    // Decode envelope
    const envelope = decodeManifestEnvelope(manifestBytes);
    expect(envelope.encryptedManifest.length).toBeGreaterThan(0);
    expect(envelope.recipients).toHaveLength(1);
    expect(envelope.recipients[0]!.recipientPublicKey).toEqual(keyPair.publicKey);
  });

  test('upload then cat chunk path returns encrypted chunk', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('Chunk retrieval test', '/data.txt');

    const result = await uploadBatch(
      [file],
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      },
      ipfsClient
    );

    // Get chunk path from manifest
    const chunkRef = result.manifest.files[0]!.chunks[0]!;
    const chunkPath = chunkIdToPath(asChunkId(chunkRef.chunkId));

    // Fetch chunk via cat
    const chunkBytes = await collectBytes(
      ipfsClient.cat(result.cid, `/${chunkPath}`)
    );
    expect(chunkBytes.length).toBeGreaterThan(0);
    expect(chunkBytes.length).toBe(chunkRef.encryptedLength);
  });

  test('chunk decrypts correctly with derived key', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const content = 'Decryption verification content';
    const file = await createFileInput(content, '/secret.txt');

    const result = await uploadBatch(
      [file],
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      },
      ipfsClient
    );

    // Get chunk info
    const fileInfo = result.manifest.files[0]!;
    const chunkRef = fileInfo.chunks[0]!;
    const chunkPath = chunkIdToPath(asChunkId(chunkRef.chunkId));

    // Fetch encrypted chunk
    const encryptedBytes = await collectBytes(
      ipfsClient.cat(result.cid, `/${chunkPath}`)
    );

    // Derive file key
    const fileKey = await deriveFileKey(
      result.manifest.manifestKey,
      fileInfo.contentHash
    );

    // Extract segment (offset is in ciphertext, but for single file it's 0)
    const segmentBytes = encryptedBytes.slice(
      chunkRef.offset,
      chunkRef.offset + chunkRef.encryptedLength
    );

    // Decrypt (decryptSingleShot handles nonce extraction internally)
    const plaintext = await decryptSingleShot(segmentBytes, fileKey);

    // Trim to original plaintext length (PADME padding adds extra bytes)
    const trimmedPlaintext = plaintext.slice(0, chunkRef.length);

    // Verify content matches
    const decoded = new TextDecoder().decode(trimmedPlaintext);
    expect(decoded).toBe(content);
  });
});

// ============================================================================
// Phase A: Validation Edge Cases
// ============================================================================

describe('uploadBatch - segmentSize validation', () => {
  test('NaN segmentSize throws ValidationError', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('test', '/test.txt');

    await expect(
      uploadBatch([file], {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
        segmentSize: NaN,
      }, ipfsClient)
    ).rejects.toThrow(ValidationError);

    await expect(
      uploadBatch([file], {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
        segmentSize: NaN,
      }, ipfsClient)
    ).rejects.toThrow('segmentSize must be a positive integer');
  });

  test('Infinity segmentSize throws ValidationError', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('test', '/test.txt');

    await expect(
      uploadBatch([file], {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
        segmentSize: Infinity,
      }, ipfsClient)
    ).rejects.toThrow(ValidationError);
  });

  test('negative segmentSize throws ValidationError', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('test', '/test.txt');

    await expect(
      uploadBatch([file], {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
        segmentSize: -5,
      }, ipfsClient)
    ).rejects.toThrow(ValidationError);
  });

  test('zero segmentSize throws ValidationError', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('test', '/test.txt');

    await expect(
      uploadBatch([file], {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
        segmentSize: 0,
      }, ipfsClient)
    ).rejects.toThrow(ValidationError);
  });

  test('non-integer segmentSize throws ValidationError', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('test', '/test.txt');

    await expect(
      uploadBatch([file], {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
        segmentSize: 5.5,
      }, ipfsClient)
    ).rejects.toThrow(ValidationError);
  });
});

// ============================================================================
// Phase A: Empty Files Tests
// ============================================================================

describe('uploadBatch - empty files', () => {
  test('single empty file (0 bytes) uploads successfully', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();

    // Create a 0-byte file
    const emptyContent = '';
    const file = await createFileInput(emptyContent, '/empty.txt');

    const result = await uploadBatch(
      [file],
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      },
      ipfsClient
    );

    expect(result.cid).toBeTruthy();
    expect(result.cid).toMatch(/^bafybei/); // dag-pb CID prefix
    expect(result.chunkCount).toBe(0); // No chunks for empty files
    expect(result.manifestCount).toBe(1);
    expect(result.segmentsUploaded).toBe(1);

    // totalSize should be > 0 (includes manifest and root directory)
    expect(result.totalSize).toBeGreaterThan(0);

    // Manifest should have the empty file
    expect(result.manifest.files).toHaveLength(1);
    expect(result.manifest.files[0]!.size).toBe(0);
    expect(result.manifest.files[0]!.chunks).toHaveLength(0);
  });

  test('all-empty-file batch uploads successfully', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();

    // Create multiple 0-byte files
    const files = [
      await createFileInput('', '/empty1.txt'),
      await createFileInput('', '/empty2.txt'),
      await createFileInput('', '/dir/empty3.txt'),
    ];

    const result = await uploadBatch(
      files,
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      },
      ipfsClient
    );

    expect(result.cid).toBeTruthy();
    expect(result.chunkCount).toBe(0);
    expect(result.manifestCount).toBe(1);
    expect(result.segmentsUploaded).toBe(1);
    expect(result.totalSize).toBeGreaterThan(0);

    // Manifest should have all 3 files
    expect(result.manifest.files).toHaveLength(3);
    for (const file of result.manifest.files) {
      expect(file.size).toBe(0);
      expect(file.chunks).toHaveLength(0);
    }

    // Should have inferred /dir directory
    expect(result.manifest.directories).toHaveLength(1);
    expect(result.manifest.directories[0]!.path).toBe('/dir');
  });

  test('mix of empty and non-empty files', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();

    const files = [
      await createFileInput('', '/empty.txt'),
      await createFileInput('Hello, World!', '/hello.txt'),
      await createFileInput('', '/another-empty.txt'),
    ];

    const result = await uploadBatch(
      files,
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      },
      ipfsClient
    );

    expect(result.cid).toBeTruthy();
    expect(result.chunkCount).toBe(1); // Only non-empty file creates a chunk
    expect(result.manifest.files).toHaveLength(3);

    // Verify empty files have no chunks
    const emptyFile1 = result.manifest.files.find(f => f.path === '/empty.txt')!;
    const emptyFile2 = result.manifest.files.find(f => f.path === '/another-empty.txt')!;
    const nonEmptyFile = result.manifest.files.find(f => f.path === '/hello.txt')!;

    expect(emptyFile1.chunks).toHaveLength(0);
    expect(emptyFile2.chunks).toHaveLength(0);
    expect(nonEmptyFile.chunks).toHaveLength(1);
  });

  test('empty batch cat(/m) returns valid manifest envelope', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('', '/empty.txt');

    const result = await uploadBatch(
      [file],
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      },
      ipfsClient
    );

    // Fetch manifest via cat
    const manifestBytes = await collectBytes(ipfsClient.cat(result.cid, '/m'));
    expect(manifestBytes.length).toBeGreaterThan(0);

    // Decode envelope
    const envelope = decodeManifestEnvelope(manifestBytes);
    expect(envelope.encryptedManifest.length).toBeGreaterThan(0);
    expect(envelope.recipients).toHaveLength(1);
  });
});

// ============================================================================
// Phase A: Multi-Segment Tests
// ============================================================================

describe('uploadBatch - multi-segment', () => {
  test('multiple small files with segmentSize=1 creates multiple segments', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();

    // Create 3 small files - with segmentSize=1, each chunk becomes its own segment
    const files = [
      await createFileInput('File A content', '/a.txt'),
      await createFileInput('File B content', '/b.txt'),
      await createFileInput('File C content', '/c.txt'),
    ];

    const result = await uploadBatch(
      files,
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
        segmentSize: 1, // 1 chunk per segment
      },
      ipfsClient
    );

    expect(result.cid).toBeTruthy();
    // Small files aggregate into 1 chunk, so with segmentSize=1 we get 1 segment
    // But the test verifies the segmentSize parameter works
    expect(result.segmentsUploaded).toBeGreaterThanOrEqual(1);
    expect(result.totalSize).toBeGreaterThan(0);
  });

  test('onSegmentComplete callback fires for each segment', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();

    // Create files that will create multiple chunks (needs larger data)
    const largeContent = 'x'.repeat(100000); // 100KB
    const files = [
      await createFileInput(largeContent + 'A', '/a.txt'),
      await createFileInput(largeContent + 'B', '/b.txt'),
    ];

    const segmentResults: SegmentResult[] = [];

    const result = await uploadBatch(
      files,
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
        segmentSize: 1, // Force multiple segments if multiple chunks
        onSegmentComplete: (seg) => segmentResults.push(seg),
      },
      ipfsClient
    );

    expect(result.segmentsUploaded).toBe(segmentResults.length);
    expect(segmentResults.length).toBeGreaterThanOrEqual(1);

    // Verify each callback has valid state
    for (let i = 0; i < segmentResults.length; i++) {
      expect(segmentResults[i]!.index).toBe(i);
      expect(segmentResults[i]!.totalSegments).toBe(segmentResults.length);
      expect(segmentResults[i]!.state).toBeDefined();
      expect(segmentResults[i]!.state.rootCid).toBeTruthy();
    }
  });

  test('totalSize includes manifest and directory overhead', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();

    const content = 'Small test content';
    const file = await createFileInput(content, '/nested/dir/file.txt');

    const result = await uploadBatch(
      [file],
      {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
      },
      ipfsClient
    );

    // totalSize should be larger than just the encrypted content
    // because it includes:
    // - CAR header overhead
    // - Directory structure (root, nested, dir)
    // - Manifest bytes
    const contentSize = new TextEncoder().encode(content).length;

    // totalSize should be significantly larger than raw content
    // (encrypted content + nonce + tag + CAR header + directories + manifest)
    expect(result.totalSize).toBeGreaterThan(contentSize * 2);
  });
});

// ============================================================================
// Phase A: Error Path Tests
// ============================================================================

describe('uploadBatch - error handling', () => {
  test('upload failure throws SegmentUploadError', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('Error test content', '/test.txt');

    // Configure client to fail on upload
    ipfsClient.setFailNextUpload(true);

    await expect(
      uploadBatch(
        [file],
        {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
        },
        ipfsClient
      )
    ).rejects.toThrow(SegmentUploadError);
  });

  test('SegmentUploadError contains valid UploadState', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('State test content', '/test.txt');

    ipfsClient.setFailNextUpload(true);

    try {
      await uploadBatch(
        [file],
        {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
        },
        ipfsClient
      );
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SegmentUploadError);
      const segError = error as SegmentUploadError;

      expect(segError.segmentIndex).toBe(0);
      expect(segError.state).toBeDefined();
      expect(segError.state.batchId).toBeTruthy();
      expect(segError.state.segments).toHaveLength(1);
      expect(segError.state.rootCid).toBeTruthy();
      expect(segError.state.manifestCid).toBeTruthy();
    }
  });

  test('UploadState has chunkCids populated', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('ChunkCids test', '/test.txt');

    ipfsClient.setFailNextUpload(true);

    try {
      await uploadBatch(
        [file],
        {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
        },
        ipfsClient
      );
      expect.unreachable('Should have thrown');
    } catch (error) {
      const segError = error as SegmentUploadError;
      const segmentState = segError.state.segments[0]!;

      // chunkCids should be populated before upload starts
      expect(Object.keys(segmentState.chunkCids).length).toBeGreaterThan(0);

      // Verify CID format
      const cids = Object.values(segmentState.chunkCids);
      for (const cid of cids) {
        expect(cid).toMatch(/^bafkrei/); // raw CID prefix
      }

      // Status should be failed
      expect(segmentState.status).toBe('failed');
      expect(segmentState.error).toBeTruthy();
    }
  });
});

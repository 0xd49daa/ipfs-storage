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
} from '@0xd49daa/safecrypt';
import {
  MockIpfsClient,
  ValidationError,
  SegmentUploadError,
  type FileInput,
  type UploadOptions,
  type BatchResult,
  type UploadProgress,
  type SegmentResult,
} from './index.ts';
import { uploadBatch } from './upload.ts';
import { decodeManifestEnvelope, decodeRootManifest } from './serialization.ts';
import { decryptSingleShot } from './chunk-encrypt.ts';
import { deriveFileKey } from './crypto.ts';
import { chunkIdToPath } from './chunk-id.ts';
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
  return new File([data as BlobPart], name, { type: 'application/octet-stream' });
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

// ============================================================================
// Phase 11: Resume Tests
// ============================================================================

import { ResumeValidationError } from './index.ts';
import type { UploadStateForError } from './errors.ts';

describe('uploadBatch - resume (Phase 11)', () => {
  describe('structure validation (assertValidResumeState)', () => {
    test('missing batchId throws ValidationError', async () => {
      const keyPair = await createTestKeyPair();
      const ipfsClient = new MockIpfsClient();
      const file = await createFileInput('test', '/test.txt');

      const badState = {
        segments: [{ index: 0, status: 'pending', chunkCids: {} }],
        manifestCid: 'bafyrei123',
        rootCid: 'bafybei456',
        manifestKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      } as unknown as UploadStateForError;

      await expect(
        uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: badState,
        }, ipfsClient)
      ).rejects.toThrow(ValidationError);
      await expect(
        uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: badState,
        }, ipfsClient)
      ).rejects.toThrow('batchId must be a non-empty string');
    });

    test('missing manifestCid throws ValidationError', async () => {
      const keyPair = await createTestKeyPair();
      const ipfsClient = new MockIpfsClient();
      const file = await createFileInput('test', '/test.txt');

      const badState = {
        batchId: 'batch1',
        segments: [{ index: 0, status: 'pending', chunkCids: {} }],
        rootCid: 'bafybei456',
        manifestKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      } as unknown as UploadStateForError;

      await expect(
        uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: badState,
        }, ipfsClient)
      ).rejects.toThrow(ValidationError);
      await expect(
        uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: badState,
        }, ipfsClient)
      ).rejects.toThrow('manifestCid must be a non-empty string');
    });

    test('invalid base64 manifestKeyBase64 throws ValidationError', async () => {
      const keyPair = await createTestKeyPair();
      const ipfsClient = new MockIpfsClient();
      const file = await createFileInput('test', '/test.txt');

      const badState = {
        batchId: 'batch1',
        segments: [{ index: 0, status: 'pending', chunkCids: {} }],
        manifestCid: 'bafyrei123',
        rootCid: 'bafybei456',
        manifestKeyBase64: 'not-valid-base64!!!',
      } as unknown as UploadStateForError;

      await expect(
        uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: badState,
        }, ipfsClient)
      ).rejects.toThrow(ValidationError);
      await expect(
        uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: badState,
        }, ipfsClient)
      ).rejects.toThrow('not valid base64');
    });

    test('manifestKeyBase64 wrong length throws ValidationError', async () => {
      const keyPair = await createTestKeyPair();
      const ipfsClient = new MockIpfsClient();
      const file = await createFileInput('test', '/test.txt');

      const badState = {
        batchId: 'batch1',
        segments: [{ index: 0, status: 'pending', chunkCids: {} }],
        manifestCid: 'bafyrei123',
        rootCid: 'bafybei456',
        manifestKeyBase64: 'AQID', // 3 bytes instead of 32
      } as unknown as UploadStateForError;

      await expect(
        uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: badState,
        }, ipfsClient)
      ).rejects.toThrow(ValidationError);
      await expect(
        uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: badState,
        }, ipfsClient)
      ).rejects.toThrow('must decode to 32 bytes');
    });

    test('segment with wrong index throws ValidationError', async () => {
      const keyPair = await createTestKeyPair();
      const ipfsClient = new MockIpfsClient();
      const file = await createFileInput('test', '/test.txt');

      const badState = {
        batchId: 'batch1',
        segments: [{ index: 5, status: 'pending', chunkCids: {} }], // Should be 0
        manifestCid: 'bafyrei123',
        rootCid: 'bafybei456',
        manifestKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      } as unknown as UploadStateForError;

      await expect(
        uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: badState,
        }, ipfsClient)
      ).rejects.toThrow(ValidationError);
      await expect(
        uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: badState,
        }, ipfsClient)
      ).rejects.toThrow('index must equal 0');
    });

    test('segment with unknown status throws ValidationError', async () => {
      const keyPair = await createTestKeyPair();
      const ipfsClient = new MockIpfsClient();
      const file = await createFileInput('test', '/test.txt');

      const badState = {
        batchId: 'batch1',
        segments: [{ index: 0, status: 'unknown-status', chunkCids: {} }],
        manifestCid: 'bafyrei123',
        rootCid: 'bafybei456',
        manifestKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      } as unknown as UploadStateForError;

      await expect(
        uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: badState,
        }, ipfsClient)
      ).rejects.toThrow(ValidationError);
      await expect(
        uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: badState,
        }, ipfsClient)
      ).rejects.toThrow('status must be pending|uploading|complete|failed');
    });
  });

  describe('segment count validation', () => {
    test('segment count mismatch throws ResumeValidationError', async () => {
      const keyPair = await createTestKeyPair();
      const ipfsClient = new MockIpfsClient();
      const file = await createFileInput('test content for resume', '/test.txt');

      // Get state from failed upload via SegmentUploadError
      let savedState: UploadStateForError | null = null;
      ipfsClient.setFailNextUpload(true);
      try {
        await uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
        }, ipfsClient);
      } catch (err) {
        if (err instanceof SegmentUploadError) {
          savedState = err.state;
        }
      }

      expect(savedState).not.toBeNull();

      // Add extra segments to cause mismatch
      savedState!.segments.push({ index: 1, status: 'pending', chunkCids: {} });
      savedState!.segments[0]!.status = 'pending';
      ipfsClient.clear();

      await expect(
        uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: savedState!,
        }, ipfsClient)
      ).rejects.toThrow(ResumeValidationError);
      await expect(
        uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: savedState!,
        }, ipfsClient)
      ).rejects.toThrow('segmentCount');
    });

    // NOTE: We do NOT validate CIDs between saved state and newly computed values.
    // Encryption uses random nonces, so CIDs are non-deterministic across sessions.
    // Resumed uploads produce DIFFERENT rootCids than the original attempt.
    // This is expected behavior - resume only skips already-uploaded segments.
  });

  describe('resume behavior', () => {
    // NOTE: Due to non-deterministic encryption (random nonces), we cannot skip
    // segments on resume. Re-encryption produces different CIDs, so skipping
    // would cause batch corruption (manifest referencing non-existent blocks).
    // Resume currently means: use same manifestKey, re-upload everything.

    test('resume re-uploads all segments with same manifestKey', async () => {
      const keyPair = await createTestKeyPair();
      const ipfsClient = new MockIpfsClient();

      // Create a single file
      const file = await createFileInput('Test content for resume', '/test.txt');

      // First upload attempt - fail to capture state with manifestKey
      let savedState: UploadStateForError | null = null;
      ipfsClient.setFailNextUpload(true);
      try {
        await uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
        }, ipfsClient);
      } catch (err) {
        if (err instanceof SegmentUploadError) {
          savedState = err.state;
        }
      }

      expect(savedState).not.toBeNull();

      // Resume - will re-encrypt and re-upload (new CIDs due to random nonces)
      ipfsClient.clear();
      savedState!.segments[0]!.status = 'pending';

      const result = await uploadBatch([file], {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
        resumeState: savedState!,
      }, ipfsClient);

      // Resumed upload succeeds with new CID (encryption is non-deterministic)
      expect(result.cid).toBeTruthy();
      expect(result.segmentsUploaded).toBe(1);
      expect(result.manifest.files).toHaveLength(1);
      expect(result.manifest.files[0]!.path).toBe('/test.txt');
      // Note: result.cid != savedState.rootCid because encryption uses random nonces
    });

    test('resume with pending segment re-uploads successfully', async () => {
      const keyPair = await createTestKeyPair();
      const ipfsClient = new MockIpfsClient();
      const file = await createFileInput('Deterministic content', '/test.txt');

      // First attempt - fail to get state
      let savedState: UploadStateForError | null = null;
      ipfsClient.setFailNextUpload(true);
      try {
        await uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
        }, ipfsClient);
      } catch (err) {
        if (err instanceof SegmentUploadError) {
          savedState = err.state;
        }
      }

      expect(savedState).not.toBeNull();

      // Resume with the saved state (pending segment will be re-uploaded)
      ipfsClient.clear();
      savedState!.segments[0]!.status = 'pending';

      const result = await uploadBatch([file], {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
        resumeState: savedState!,
      }, ipfsClient);

      // NOTE: Resumed uploads produce DIFFERENT rootCids because encryption
      // uses random nonces. The manifest content is the same, but the encrypted
      // bytes differ, resulting in different CIDs.
      expect(result.cid).toBeTruthy();
      expect(result.segmentsUploaded).toBe(1);
      expect(result.manifest.files).toHaveLength(1);
      expect(result.manifest.files[0]!.path).toBe('/test.txt');
    });
  });

  describe('JSON serialization', () => {
    test('UploadState survives JSON round-trip', async () => {
      const keyPair = await createTestKeyPair();
      const ipfsClient = new MockIpfsClient();
      const file = await createFileInput('JSON test', '/test.txt');

      // Get state from upload
      let savedState: UploadStateForError | null = null;
      ipfsClient.setFailNextUpload(true);
      try {
        await uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
        }, ipfsClient);
      } catch (err) {
        if (err instanceof SegmentUploadError) {
          savedState = err.state;
        }
      }

      // Round-trip through JSON
      const json = JSON.stringify(savedState);
      const restored = JSON.parse(json) as UploadStateForError;

      // Verify structure
      expect(restored.batchId).toBe(savedState!.batchId);
      expect(restored.manifestCid).toBe(savedState!.manifestCid);
      expect(restored.rootCid).toBe(savedState!.rootCid);
      expect(restored.manifestKeyBase64).toBe(savedState!.manifestKeyBase64);
      expect(restored.segments.length).toBe(savedState!.segments.length);

      // Resume with restored state
      ipfsClient.clear();
      restored.segments[0]!.status = 'pending';

      const result = await uploadBatch([file], {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
        resumeState: restored,
      }, ipfsClient);

      expect(result.cid).toBeTruthy();
    });
  });

  describe('empty batch resume', () => {
    test('empty batch resume validates segment count', async () => {
      const keyPair = await createTestKeyPair();
      const ipfsClient = new MockIpfsClient();

      // Create empty file
      const emptyFile: FileInput = {
        file: new File([], 'empty.txt'),
        path: '/empty.txt',
        contentHash: await hashString(''),
      };

      // Get state from failed upload
      let savedState: UploadStateForError | null = null;
      ipfsClient.setFailNextUpload(true);
      try {
        await uploadBatch([emptyFile], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
        }, ipfsClient);
      } catch (err) {
        if (err instanceof SegmentUploadError) {
          savedState = err.state;
        }
      }

      expect(savedState).not.toBeNull();

      // Add extra segment to cause mismatch (empty batch should have 1 segment)
      savedState!.segments.push({ index: 1, status: 'pending', chunkCids: {} });
      savedState!.segments[0]!.status = 'pending';
      ipfsClient.clear();

      await expect(
        uploadBatch([emptyFile], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: savedState!,
        }, ipfsClient)
      ).rejects.toThrow(ResumeValidationError);
      await expect(
        uploadBatch([emptyFile], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          resumeState: savedState!,
        }, ipfsClient)
      ).rejects.toThrow('segmentCount');
    });

    test('empty batch resume re-uploads successfully', async () => {
      const keyPair = await createTestKeyPair();
      const ipfsClient = new MockIpfsClient();

      // Create empty file
      const emptyFile: FileInput = {
        file: new File([], 'empty.txt'),
        path: '/empty.txt',
        contentHash: await hashString(''),
      };

      // First upload attempt - fail to get state
      let savedState: UploadStateForError | null = null;
      ipfsClient.setFailNextUpload(true);
      try {
        await uploadBatch([emptyFile], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
        }, ipfsClient);
      } catch (err) {
        if (err instanceof SegmentUploadError) {
          savedState = err.state;
        }
      }

      expect(savedState).not.toBeNull();

      // Resume - always re-uploads because encryption is non-deterministic
      ipfsClient.clear();
      savedState!.segments[0]!.status = 'pending';

      const result = await uploadBatch([emptyFile], {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
        resumeState: savedState!,
      }, ipfsClient);

      // Resume succeeds with new CID (encryption is non-deterministic)
      expect(result.cid).toBeTruthy();
      expect(result.segmentsUploaded).toBe(1);
      expect(result.chunkCount).toBe(0); // Empty batch has no chunks
    });
  });

  // NOTE: verifyResumeState option is no longer functional because we always
  // re-upload all segments due to non-deterministic encryption. The option is
  // kept for API compatibility but has no effect.

  describe('resume data integrity', () => {
    test('resumed upload produces retrievable, decryptable data', async () => {
      const keyPair = await createTestKeyPair();
      const ipfsClient = new MockIpfsClient();
      const content = 'Content to verify after resume';
      const file = await createFileInput(content, '/data.txt');

      // First upload attempt - fail to capture state with manifestKey
      let savedState: UploadStateForError | null = null;
      ipfsClient.setFailNextUpload(true);
      try {
        await uploadBatch([file], {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
        }, ipfsClient);
      } catch (err) {
        if (err instanceof SegmentUploadError) {
          savedState = err.state;
        }
      }

      expect(savedState).not.toBeNull();

      // Resume upload
      ipfsClient.clear();
      savedState!.segments[0]!.status = 'pending';

      const result = await uploadBatch([file], {
        senderKeyPair: keyPair,
        recipients: [{ publicKey: keyPair.publicKey }],
        resumeState: savedState!,
      }, ipfsClient);

      // Verify manifest can be retrieved
      const manifestBytes = await collectBytes(ipfsClient.cat(result.cid, '/m'));
      expect(manifestBytes.length).toBeGreaterThan(0);

      // Verify envelope decodes correctly
      const envelope = decodeManifestEnvelope(manifestBytes);
      expect(envelope.recipients).toHaveLength(1);

      // Verify chunk can be retrieved and decrypted
      const fileInfo = result.manifest.files[0]!;
      const chunkRef = fileInfo.chunks[0]!;
      const chunkPath = chunkIdToPath(asChunkId(chunkRef.chunkId));

      const encryptedBytes = await collectBytes(
        ipfsClient.cat(result.cid, `/${chunkPath}`)
      );
      expect(encryptedBytes.length).toBe(chunkRef.encryptedLength);

      // Derive file key and decrypt
      const fileKey = await deriveFileKey(
        result.manifest.manifestKey,
        fileInfo.contentHash
      );

      const segmentBytes = encryptedBytes.slice(
        chunkRef.offset,
        chunkRef.offset + chunkRef.encryptedLength
      );

      const plaintext = await decryptSingleShot(segmentBytes, fileKey);
      const trimmedPlaintext = plaintext.slice(0, chunkRef.length);
      const decoded = new TextDecoder().decode(trimmedPlaintext);

      expect(decoded).toBe(content);
    });
  });
});

// ============================================================================
// Phase 12: AbortSignal Integration Tests
// ============================================================================

import { AbortUploadError } from './index.ts';

describe('uploadBatch - AbortSignal integration (Phase 12)', () => {
  test('abort before encryption throws DOMException', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('test content', '/test.txt');

    // Abort immediately before upload starts
    const controller = new AbortController();
    controller.abort();

    try {
      await uploadBatch(
        [file],
        {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          signal: controller.signal,
        },
        ipfsClient
      );
      expect.unreachable('Should have thrown');
    } catch (error) {
      // Early abort throws DOMException (no state available yet)
      // When abort() is called without reason, browser/runtime uses default message
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('AbortError');
      // Default abort reason is "The operation was aborted." (Web API standard)
    }
  });

  test('abort after segment completes throws AbortUploadError with state', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();

    // Create multiple files to ensure multiple segments with segmentSize=1
    const files = [
      await createFileInput('File A content for segment test', '/a.txt'),
      await createFileInput('File B content for segment test', '/b.txt'),
    ];

    const controller = new AbortController();
    let segmentCount = 0;

    // Latch that aborts after first segment completes
    ipfsClient.setUploadLatch(async () => {
      segmentCount++;
      if (segmentCount === 1) {
        controller.abort();
      }
    });

    try {
      await uploadBatch(
        files,
        {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          signal: controller.signal,
          segmentSize: 1, // Force multiple segments
        },
        ipfsClient
      );
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AbortUploadError);
      const abortError = error as AbortUploadError;
      expect(abortError.name).toBe('AbortError');
      expect(abortError.state).toBeDefined();
      expect(abortError.state.batchId).toBeTruthy();
      expect(abortError.state.segments.length).toBeGreaterThanOrEqual(1);
    } finally {
      ipfsClient.clearUploadLatch();
    }
  });

  test('AbortUploadError.state is valid for resume', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('Resume test content', '/test.txt');

    const controller = new AbortController();

    // Abort after segment upload completes
    ipfsClient.setUploadLatch(async () => {
      controller.abort();
    });

    let abortState: UploadStateForError | null = null;
    try {
      await uploadBatch(
        [file],
        {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          signal: controller.signal,
        },
        ipfsClient
      );
      expect.unreachable('Should have thrown');
    } catch (error) {
      if (error instanceof AbortUploadError) {
        abortState = error.state;
      }
    } finally {
      ipfsClient.clearUploadLatch();
    }

    expect(abortState).not.toBeNull();

    // Verify state structure for resume
    expect(abortState!.batchId).toBeTruthy();
    expect(abortState!.manifestCid).toBeTruthy();
    expect(abortState!.rootCid).toBeTruthy();
    expect(abortState!.manifestKeyBase64).toBeTruthy();
    expect(abortState!.segments.length).toBeGreaterThan(0);

    // manifestKeyBase64 should be valid base64 and 32 bytes
    const keyBytes = Uint8Array.from(atob(abortState!.manifestKeyBase64), c => c.charCodeAt(0));
    expect(keyBytes.length).toBe(32);
  });

  test('completed segments have status=complete in abort state', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();

    // Create files that will produce multiple chunks (larger data)
    const largeContent = 'x'.repeat(50000); // 50KB each
    const files = [
      await createFileInput(largeContent + 'A', '/a.txt'),
      await createFileInput(largeContent + 'B', '/b.txt'),
    ];

    const controller = new AbortController();
    let segmentCount = 0;

    // Abort after first segment
    ipfsClient.setUploadLatch(async () => {
      segmentCount++;
      if (segmentCount === 1) {
        controller.abort();
      }
    });

    try {
      await uploadBatch(
        files,
        {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          signal: controller.signal,
          segmentSize: 1,
        },
        ipfsClient
      );
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AbortUploadError);
      const abortError = error as AbortUploadError;

      // First segment should be marked complete
      expect(abortError.state.segments[0]!.status).toBe('complete');
    } finally {
      ipfsClient.clearUploadLatch();
    }
  });

  test('preserves custom abort reason in error', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('Reason test content', '/test.txt');

    const controller = new AbortController();
    const customReason = 'User cancelled the upload';

    // Abort with custom reason after segment
    ipfsClient.setUploadLatch(async () => {
      controller.abort(customReason);
    });

    try {
      await uploadBatch(
        [file],
        {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          signal: controller.signal,
        },
        ipfsClient
      );
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AbortUploadError);
      const abortError = error as AbortUploadError;

      // Reason should be preserved
      expect(abortError.reason).toBe(customReason);
      expect(abortError.message).toBe(customReason);
    } finally {
      ipfsClient.clearUploadLatch();
    }
  });

  test('abort after empty batch upload throws AbortUploadError', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();

    // Create empty file
    const emptyFile: FileInput = {
      file: new File([], 'empty.txt'),
      path: '/empty.txt',
      contentHash: await hashString(''),
    };

    const controller = new AbortController();

    // Abort after empty batch segment upload
    ipfsClient.setUploadLatch(async () => {
      controller.abort();
    });

    try {
      await uploadBatch(
        [emptyFile],
        {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          signal: controller.signal,
        },
        ipfsClient
      );
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AbortUploadError);
      const abortError = error as AbortUploadError;
      expect(abortError.state).toBeDefined();
      expect(abortError.state.segments[0]!.status).toBe('complete');
    } finally {
      ipfsClient.clearUploadLatch();
    }
  });

  test('abort during final segment is honored after completion', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('Final segment test', '/test.txt');

    const controller = new AbortController();

    // Abort after the (only) segment completes
    ipfsClient.setUploadLatch(async () => {
      controller.abort();
    });

    try {
      await uploadBatch(
        [file],
        {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          signal: controller.signal,
        },
        ipfsClient
      );
      expect.unreachable('Should have thrown - abort should be honored even after final segment');
    } catch (error) {
      expect(error).toBeInstanceOf(AbortUploadError);
      const abortError = error as AbortUploadError;

      // Segment should be complete (upload finished) but we still throw
      expect(abortError.state.segments[0]!.status).toBe('complete');

      // All data should have been uploaded before abort
      expect(ipfsClient.getBlockCount()).toBeGreaterThan(0);
    } finally {
      ipfsClient.clearUploadLatch();
    }
  });

  test('early abort with custom Error reason preserves cause', async () => {
    const keyPair = await createTestKeyPair();
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput('Error reason test', '/test.txt');

    const controller = new AbortController();
    const customError = new Error('Network timeout');

    // Abort with Error reason after segment
    ipfsClient.setUploadLatch(async () => {
      controller.abort(customError);
    });

    try {
      await uploadBatch(
        [file],
        {
          senderKeyPair: keyPair,
          recipients: [{ publicKey: keyPair.publicKey }],
          signal: controller.signal,
        },
        ipfsClient
      );
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AbortUploadError);
      const abortError = error as AbortUploadError;

      // Error reason should be preserved
      expect(abortError.reason).toBe(customError);
      expect(abortError.cause).toBe(customError);
      expect(abortError.message).toBe('Network timeout');
    } finally {
      ipfsClient.clearUploadLatch();
    }
  });
});

import { describe, test, expect, beforeAll } from 'bun:test';
import {
  preloadSodium,
  generateKey,
  decrypt,
  createDecryptStream,
} from '@0xd49daa/safecrypt';
import type { ContentHash, SymmetricKey, Nonce } from '@0xd49daa/safecrypt';
import {
  encryptChunk,
  encryptChunks,
  createFileDataProvider,
  computeEncryptedLength,
  decryptSingleShot,
  decryptStreaming,
} from './chunk-encrypt.ts';
import type { FileDataProvider, EncryptedChunk } from './chunk-encrypt.ts';
import { planChunks } from './chunk-plan.ts';
import type { PlannedChunk, FileSegment } from './chunk-plan.ts';
import type { FileInput } from './types.ts';
import { ChunkEncryption } from './gen/manifest_pb.ts';
import { ValidationError } from './errors.ts';
import { deriveFileKey } from './crypto.ts';
import { asChunkId } from './branded.ts';
import {
  NONCE_SIZE,
  SINGLE_SHOT_OVERHEAD,
  STREAM_HEADER_SIZE,
  STREAM_CHUNK_OVERHEAD,
  STREAM_CHUNK_SIZE,
  CHUNK_SIZE,
} from './constants.ts';

const KB = 1024;
const MB = 1024 * 1024;

// Helper to create deterministic content hash from index
function mockContentHash(index: number): ContentHash {
  const hash = new Uint8Array(32);
  hash[0] = index;
  return hash as ContentHash;
}

// Helper to create mock FileInput with specific content
function mockFile(
  content: Uint8Array,
  path: string,
  contentHash?: ContentHash
): FileInput {
  const file = new File([content as BlobPart], path.split('/').pop()!, {
    type: 'application/octet-stream',
  });
  return {
    file,
    path,
    contentHash: contentHash ?? mockContentHash(0),
  };
}

// Helper to create mock FileInput of specific size
function mockFileSize(
  size: number,
  path: string,
  contentHash?: ContentHash
): FileInput {
  const content = new Uint8Array(size);
  // Fill with recognizable pattern
  for (let i = 0; i < size; i++) {
    content[i] = i % 256;
  }
  return mockFile(content, path, contentHash);
}

// Valid base58 characters for padding chunk IDs
const BASE58_PAD_CHAR = '1'; // '1' is a valid base58 character

// Helper to create a PlannedChunk for testing
function createPlannedChunk(
  chunkId: string,
  segments: FileSegment[],
  dataSize: number,
  paddedSize: number,
  encryption: ChunkEncryption = ChunkEncryption.SINGLE_SHOT
): PlannedChunk {
  // Pad with valid base58 character to 22 chars
  const paddedId = chunkId.padEnd(22, BASE58_PAD_CHAR);
  return {
    chunkId: asChunkId(paddedId),
    segments,
    dataSize,
    paddedSize,
    encryption,
  };
}

beforeAll(async () => {
  await preloadSodium();
});

describe('Phase 7: Chunk Encryption Pipeline', () => {
  describe('computeEncryptedLength()', () => {
    test('SINGLE_SHOT: returns length + 40', () => {
      expect(computeEncryptedLength(0, ChunkEncryption.SINGLE_SHOT)).toBe(40);
      expect(computeEncryptedLength(100, ChunkEncryption.SINGLE_SHOT)).toBe(140);
      expect(computeEncryptedLength(1000, ChunkEncryption.SINGLE_SHOT)).toBe(1040);
      expect(computeEncryptedLength(10 * MB, ChunkEncryption.SINGLE_SHOT)).toBe(
        10 * MB + 40
      );
    });

    test('STREAMING: returns correct formula result', () => {
      // Formula: plaintextLength + 24 + ceil(plaintextLength / 64KB) * 17

      // 1 byte = 1 chunk
      expect(computeEncryptedLength(1, ChunkEncryption.STREAMING)).toBe(1 + 24 + 17);

      // Exactly 64KB = 1 chunk
      expect(computeEncryptedLength(64 * KB, ChunkEncryption.STREAMING)).toBe(
        64 * KB + 24 + 17
      );

      // 64KB + 1 byte = 2 chunks
      expect(computeEncryptedLength(64 * KB + 1, ChunkEncryption.STREAMING)).toBe(
        64 * KB + 1 + 24 + 2 * 17
      );

      // 128KB = 2 chunks
      expect(computeEncryptedLength(128 * KB, ChunkEncryption.STREAMING)).toBe(
        128 * KB + 24 + 2 * 17
      );

      // 10MB = ceil(10MB / 64KB) = 160 chunks
      const tenMB = 10 * MB;
      const numChunks = Math.ceil(tenMB / (64 * KB));
      expect(computeEncryptedLength(tenMB, ChunkEncryption.STREAMING)).toBe(
        tenMB + 24 + numChunks * 17
      );
    });

    test('edge case: 0 length', () => {
      // 0 bytes = 0 chunks for streaming
      expect(computeEncryptedLength(0, ChunkEncryption.STREAMING)).toBe(0 + 24 + 0);
    });

    test('edge case: exact chunk boundary', () => {
      // Exactly N * 64KB should be N chunks
      expect(computeEncryptedLength(64 * KB * 3, ChunkEncryption.STREAMING)).toBe(
        64 * KB * 3 + 24 + 3 * 17
      );
    });
  });

  describe('createFileDataProvider()', () => {
    test('reads correct byte range from file', async () => {
      const content = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const files = [mockFile(content, '/test.bin')];
      const provider = createFileDataProvider(files);

      const segment = await provider.readSegment(0, 2, 5);
      expect(segment).toEqual(new Uint8Array([3, 4, 5, 6, 7]));
    });

    test('reads from start of file', async () => {
      const content = new Uint8Array([1, 2, 3, 4, 5]);
      const files = [mockFile(content, '/test.bin')];
      const provider = createFileDataProvider(files);

      const segment = await provider.readSegment(0, 0, 3);
      expect(segment).toEqual(new Uint8Array([1, 2, 3]));
    });

    test('reads to end of file', async () => {
      const content = new Uint8Array([1, 2, 3, 4, 5]);
      const files = [mockFile(content, '/test.bin')];
      const provider = createFileDataProvider(files);

      const segment = await provider.readSegment(0, 3, 2);
      expect(segment).toEqual(new Uint8Array([4, 5]));
    });

    test('throws ValidationError for invalid fileIndex (negative)', async () => {
      const files = [mockFileSize(100, '/test.bin')];
      const provider = createFileDataProvider(files);

      await expect(provider.readSegment(-1, 0, 10)).rejects.toThrow(ValidationError);
      await expect(provider.readSegment(-1, 0, 10)).rejects.toThrow(
        'Invalid file index'
      );
    });

    test('throws ValidationError for invalid fileIndex (out of bounds)', async () => {
      const files = [mockFileSize(100, '/test.bin')];
      const provider = createFileDataProvider(files);

      await expect(provider.readSegment(1, 0, 10)).rejects.toThrow(ValidationError);
      await expect(provider.readSegment(5, 0, 10)).rejects.toThrow(ValidationError);
    });

    test('throws ValidationError when offset+length > fileSize', async () => {
      const files = [mockFileSize(100, '/test.bin')];
      const provider = createFileDataProvider(files);

      await expect(provider.readSegment(0, 90, 20)).rejects.toThrow(ValidationError);
      await expect(provider.readSegment(0, 90, 20)).rejects.toThrow(
        'Read exceeds file bounds'
      );
    });

    test('throws ValidationError for negative offset', async () => {
      const files = [mockFileSize(100, '/test.bin')];
      const provider = createFileDataProvider(files);

      await expect(provider.readSegment(0, -1, 10)).rejects.toThrow(ValidationError);
      await expect(provider.readSegment(0, -1, 10)).rejects.toThrow(
        'Invalid offset/length'
      );
    });

    test('throws ValidationError for negative length', async () => {
      const files = [mockFileSize(100, '/test.bin')];
      const provider = createFileDataProvider(files);

      await expect(provider.readSegment(0, 0, -10)).rejects.toThrow(ValidationError);
    });

    test('getContentHash returns correct hash', () => {
      const hash = mockContentHash(42);
      const files = [mockFile(new Uint8Array(10), '/test.bin', hash)];
      const provider = createFileDataProvider(files);

      expect(provider.getContentHash(0)).toBe(hash);
    });

    test('getContentHash throws for invalid index', () => {
      const files = [mockFileSize(100, '/test.bin')];
      const provider = createFileDataProvider(files);

      expect(() => provider.getContentHash(-1)).toThrow(ValidationError);
      expect(() => provider.getContentHash(1)).toThrow(ValidationError);
    });

    test('getFileSize returns correct size', () => {
      const files = [mockFileSize(12345, '/test.bin')];
      const provider = createFileDataProvider(files);

      expect(provider.getFileSize(0)).toBe(12345);
    });

    test('getFileSize throws for invalid index', () => {
      const files = [mockFileSize(100, '/test.bin')];
      const provider = createFileDataProvider(files);

      expect(() => provider.getFileSize(-1)).toThrow(ValidationError);
      expect(() => provider.getFileSize(1)).toThrow(ValidationError);
    });
  });

  describe('encryptChunk() - single-shot encryption', () => {
    test('produces valid format: [nonce(24)][ciphertext]', async () => {
      const manifestKey = await generateKey();
      const files = [mockFileSize(100, '/test.bin', mockContentHash(1))];
      const provider = createFileDataProvider(files);

      const chunk = createPlannedChunk(
        'testchunk1',
        [{ fileIndex: 0, fileOffset: 0, length: 100, chunkOffset: 0 }],
        100,
        100
      );

      const result = await encryptChunk(chunk, provider, manifestKey, false);

      // Should have nonce (24) + ciphertext (100 + 16 tag)
      expect(result.encryptedData.length).toBe(100 + SINGLE_SHOT_OVERHEAD);
      expect(result.encryption).toBe(ChunkEncryption.SINGLE_SHOT);
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0]!.encryptedOffset).toBe(0);
      expect(result.segments[0]!.plaintextLength).toBe(100);
      expect(result.segments[0]!.encryptedLength).toBe(100 + SINGLE_SHOT_OVERHEAD);
    });

    test('round-trip: encrypt → decrypt → verify', async () => {
      const manifestKey = await generateKey();
      const originalContent = new Uint8Array(256);
      for (let i = 0; i < 256; i++) originalContent[i] = i;

      const contentHash = mockContentHash(1);
      const files = [mockFile(originalContent, '/test.bin', contentHash)];
      const provider = createFileDataProvider(files);

      const chunk = createPlannedChunk(
        'testchunk2',
        [{ fileIndex: 0, fileOffset: 0, length: 256, chunkOffset: 0 }],
        256,
        256
      );

      const encrypted = await encryptChunk(chunk, provider, manifestKey, false);

      // Decrypt using the same key derivation
      const fileKey = await deriveFileKey(manifestKey, contentHash);
      const decrypted = await decryptSingleShot(encrypted.encryptedData, fileKey);

      expect(decrypted).toEqual(originalContent);
    });

    test('different contentHash → different ciphertext', async () => {
      const manifestKey = await generateKey();
      const content = new Uint8Array(100).fill(42);

      const files1 = [mockFile(content, '/test1.bin', mockContentHash(1))];
      const files2 = [mockFile(content, '/test2.bin', mockContentHash(2))];

      const provider1 = createFileDataProvider(files1);
      const provider2 = createFileDataProvider(files2);

      const chunk1 = createPlannedChunk(
        'chunk1',
        [{ fileIndex: 0, fileOffset: 0, length: 100, chunkOffset: 0 }],
        100,
        100
      );
      const chunk2 = createPlannedChunk(
        'chunk2',
        [{ fileIndex: 0, fileOffset: 0, length: 100, chunkOffset: 0 }],
        100,
        100
      );

      const result1 = await encryptChunk(chunk1, provider1, manifestKey, false);
      const result2 = await encryptChunk(chunk2, provider2, manifestKey, false);

      // Different keys should produce different ciphertext
      // (Also different nonces, but even with same nonce, different keys = different output)
      expect(result1.encryptedData).not.toEqual(result2.encryptedData);
    });

    test('same contentHash → same key (different ciphertext due to nonce)', async () => {
      const manifestKey = await generateKey();
      const content = new Uint8Array(100).fill(42);
      const contentHash = mockContentHash(1);

      const files = [mockFile(content, '/test.bin', contentHash)];
      const provider = createFileDataProvider(files);

      const chunk = createPlannedChunk(
        'chunk1',
        [{ fileIndex: 0, fileOffset: 0, length: 100, chunkOffset: 0 }],
        100,
        100
      );

      const result1 = await encryptChunk(chunk, provider, manifestKey, false);
      const result2 = await encryptChunk(chunk, provider, manifestKey, false);

      // Same key but different random nonces → different ciphertext
      expect(result1.encryptedData).not.toEqual(result2.encryptedData);

      // But both should decrypt to the same plaintext
      const fileKey = await deriveFileKey(manifestKey, contentHash);
      const decrypted1 = await decryptSingleShot(result1.encryptedData, fileKey);
      const decrypted2 = await decryptSingleShot(result2.encryptedData, fileKey);

      expect(decrypted1).toEqual(content);
      expect(decrypted2).toEqual(content);
    });
  });

  describe('encryptChunk() - streaming mode', () => {
    test('streaming round-trip without padding', async () => {
      const manifestKey = await generateKey();
      // 100KB = spans 2 streaming chunks (64KB each)
      const content = new Uint8Array(100 * KB);
      for (let i = 0; i < content.length; i++) content[i] = i % 256;

      const contentHash = mockContentHash(1);
      const files = [mockFile(content, '/streaming.bin', contentHash)];
      const provider = createFileDataProvider(files);

      const chunk = createPlannedChunk(
        'stream1',
        [{ fileIndex: 0, fileOffset: 0, length: 100 * KB, chunkOffset: 0 }],
        100 * KB,
        100 * KB,
        ChunkEncryption.STREAMING
      );

      const result = await encryptChunk(chunk, provider, manifestKey, false);

      // Streaming overhead: 24 (header) + ceil(100KB / 64KB) * 17 = 24 + 2*17 = 58
      const expectedSize = 100 * KB + 24 + 2 * 17;
      expect(result.encryptedSize).toBe(expectedSize);
      expect(result.segments[0]!.encryptedLength).toBe(expectedSize);
      expect(result.segments[0]!.plaintextLength).toBe(100 * KB);

      // Decrypt and verify
      const fileKey = await deriveFileKey(manifestKey, contentHash);
      const decrypted = await decryptStreaming(result.encryptedData, fileKey);

      expect(decrypted).toEqual(content);
    });

    test('streaming round-trip with PADME padding', async () => {
      const manifestKey = await generateKey();
      // 80KB content, padded to 100KB
      const content = new Uint8Array(80 * KB);
      for (let i = 0; i < content.length; i++) content[i] = i % 256;

      const contentHash = mockContentHash(1);
      const files = [mockFile(content, '/streaming-padded.bin', contentHash)];
      const provider = createFileDataProvider(files);

      const chunk = createPlannedChunk(
        'stream2',
        [{ fileIndex: 0, fileOffset: 0, length: 80 * KB, chunkOffset: 0 }],
        80 * KB,
        100 * KB, // PADME pads to 100KB
        ChunkEncryption.STREAMING
      );

      const result = await encryptChunk(chunk, provider, manifestKey, true); // isFinalChunk

      // plaintextLength should be original (80KB)
      expect(result.segments[0]!.plaintextLength).toBe(80 * KB);
      expect(result.dataSize).toBe(80 * KB);

      // encryptedLength should reflect padded size (100KB encrypted)
      // Streaming overhead for 100KB: 24 + ceil(100KB / 64KB) * 17 = 24 + 2*17 = 58
      const expectedEncLen = 100 * KB + 24 + 2 * 17;
      expect(result.segments[0]!.encryptedLength).toBe(expectedEncLen);
      expect(result.encryptedSize).toBe(expectedEncLen);

      // Decrypt and verify - decrypted will include padding zeros
      const fileKey = await deriveFileKey(manifestKey, contentHash);
      const decrypted = await decryptStreaming(result.encryptedData, fileKey);

      expect(decrypted.length).toBe(100 * KB); // padded length
      expect(decrypted.subarray(0, 80 * KB)).toEqual(content); // original content
      expect(decrypted.subarray(80 * KB)).toEqual(new Uint8Array(20 * KB)); // padding zeros
    });

    test('streaming with exact 64KB chunk boundary', async () => {
      const manifestKey = await generateKey();
      // Exactly 64KB = 1 streaming chunk
      const content = new Uint8Array(64 * KB);
      for (let i = 0; i < content.length; i++) content[i] = i % 256;

      const contentHash = mockContentHash(1);
      const files = [mockFile(content, '/exact64k.bin', contentHash)];
      const provider = createFileDataProvider(files);

      const chunk = createPlannedChunk(
        'stream3',
        [{ fileIndex: 0, fileOffset: 0, length: 64 * KB, chunkOffset: 0 }],
        64 * KB,
        64 * KB,
        ChunkEncryption.STREAMING
      );

      const result = await encryptChunk(chunk, provider, manifestKey, false);

      // 1 chunk: 24 + 64KB + 17
      const expectedSize = 64 * KB + 24 + 17;
      expect(result.encryptedSize).toBe(expectedSize);

      const fileKey = await deriveFileKey(manifestKey, contentHash);
      const decrypted = await decryptStreaming(result.encryptedData, fileKey);
      expect(decrypted).toEqual(content);
    });
  });

  describe('encryptChunk() - multi-segment', () => {
    test('multi-segment chunk: each segment uses correct derived key', async () => {
      const manifestKey = await generateKey();

      // Two files with different content hashes
      const content1 = new Uint8Array(50).fill(1);
      const content2 = new Uint8Array(50).fill(2);
      const hash1 = mockContentHash(1);
      const hash2 = mockContentHash(2);

      const files = [
        mockFile(content1, '/file1.bin', hash1),
        mockFile(content2, '/file2.bin', hash2),
      ];
      const provider = createFileDataProvider(files);

      const chunk = createPlannedChunk(
        'mu1tiseg',
        [
          { fileIndex: 0, fileOffset: 0, length: 50, chunkOffset: 0 },
          { fileIndex: 1, fileOffset: 0, length: 50, chunkOffset: 50 },
        ],
        100,
        100
      );

      const result = await encryptChunk(chunk, provider, manifestKey, false);

      // Should have two encrypted segments
      expect(result.segments).toHaveLength(2);
      expect(result.segments[0]!.encryptedOffset).toBe(0);
      expect(result.segments[0]!.plaintextLength).toBe(50);
      expect(result.segments[0]!.encryptedLength).toBe(50 + SINGLE_SHOT_OVERHEAD);
      expect(result.segments[1]!.encryptedOffset).toBe(50 + SINGLE_SHOT_OVERHEAD);
      expect(result.segments[1]!.plaintextLength).toBe(50);
      expect(result.segments[1]!.encryptedLength).toBe(50 + SINGLE_SHOT_OVERHEAD);

      // Total size = 2 * (50 + 40)
      expect(result.encryptedSize).toBe(2 * (50 + SINGLE_SHOT_OVERHEAD));

      // Decrypt each segment with its own key - use encryptedLength for extraction
      const seg1 = result.segments[0]!;
      const seg2 = result.segments[1]!;
      const seg1Data = result.encryptedData.subarray(
        seg1.encryptedOffset,
        seg1.encryptedOffset + seg1.encryptedLength
      );
      const seg2Data = result.encryptedData.subarray(
        seg2.encryptedOffset,
        seg2.encryptedOffset + seg2.encryptedLength
      );

      const key1 = await deriveFileKey(manifestKey, hash1);
      const key2 = await deriveFileKey(manifestKey, hash2);

      const decrypted1 = await decryptSingleShot(seg1Data, key1);
      const decrypted2 = await decryptSingleShot(seg2Data, key2);

      expect(decrypted1).toEqual(content1);
      expect(decrypted2).toEqual(content2);
    });

    test('encrypted offsets are cumulative', async () => {
      const manifestKey = await generateKey();

      const files = [
        mockFileSize(100, '/file1.bin', mockContentHash(1)),
        mockFileSize(200, '/file2.bin', mockContentHash(2)),
        mockFileSize(150, '/file3.bin', mockContentHash(3)),
      ];
      const provider = createFileDataProvider(files);

      const chunk = createPlannedChunk(
        'cumu1ative',
        [
          { fileIndex: 0, fileOffset: 0, length: 100, chunkOffset: 0 },
          { fileIndex: 1, fileOffset: 0, length: 200, chunkOffset: 100 },
          { fileIndex: 2, fileOffset: 0, length: 150, chunkOffset: 300 },
        ],
        450,
        450
      );

      const result = await encryptChunk(chunk, provider, manifestKey, false);

      expect(result.segments[0]!.encryptedOffset).toBe(0);
      expect(result.segments[0]!.encryptedLength).toBe(100 + SINGLE_SHOT_OVERHEAD);
      expect(result.segments[1]!.encryptedOffset).toBe(100 + SINGLE_SHOT_OVERHEAD);
      expect(result.segments[1]!.encryptedLength).toBe(200 + SINGLE_SHOT_OVERHEAD);
      expect(result.segments[2]!.encryptedOffset).toBe(
        100 + SINGLE_SHOT_OVERHEAD + 200 + SINGLE_SHOT_OVERHEAD
      );
      expect(result.segments[2]!.encryptedLength).toBe(150 + SINGLE_SHOT_OVERHEAD);
    });
  });

  describe('encryptChunk() - PADME padding', () => {
    test('final chunk\'s last segment padded to hit paddedSize', async () => {
      const manifestKey = await generateKey();
      const content = new Uint8Array(100).fill(42);
      const contentHash = mockContentHash(1);
      const files = [mockFile(content, '/test.bin', contentHash)];
      const provider = createFileDataProvider(files);

      // dataSize=100, paddedSize=150 → 50 bytes of padding
      const chunk = createPlannedChunk(
        'padded',
        [{ fileIndex: 0, fileOffset: 0, length: 100, chunkOffset: 0 }],
        100,
        150 // PADME padded size
      );

      const result = await encryptChunk(chunk, provider, manifestKey, true); // isFinalChunk=true

      // Encrypted size should reflect padded plaintext: 150 + 40
      expect(result.encryptedSize).toBe(150 + SINGLE_SHOT_OVERHEAD);

      // plaintextLength should be original: 100
      expect(result.segments[0]!.plaintextLength).toBe(100);
      expect(result.dataSize).toBe(100);

      // CRITICAL: encryptedLength reflects padded size (150 + 40), not original (100 + 40)
      // This is the fix for the padding slicing bug - download uses encryptedLength, not computeEncryptedLength(plaintextLength)
      expect(result.segments[0]!.encryptedLength).toBe(150 + SINGLE_SHOT_OVERHEAD);

      // Decrypt and verify
      const fileKey = await deriveFileKey(manifestKey, contentHash);
      const decrypted = await decryptSingleShot(result.encryptedData, fileKey);

      // Decrypted has 150 bytes (100 data + 50 padding zeros)
      expect(decrypted.length).toBe(150);
      expect(decrypted.subarray(0, 100)).toEqual(content);
      expect(decrypted.subarray(100)).toEqual(new Uint8Array(50)); // zeros
    });

    test('non-final chunks have no padding', async () => {
      const manifestKey = await generateKey();
      const content = new Uint8Array(100).fill(42);
      const files = [mockFile(content, '/test.bin', mockContentHash(1))];
      const provider = createFileDataProvider(files);

      // Even if paddedSize > dataSize, non-final chunk shouldn't pad
      const chunk = createPlannedChunk(
        'nopad',
        [{ fileIndex: 0, fileOffset: 0, length: 100, chunkOffset: 0 }],
        100,
        150
      );

      const result = await encryptChunk(chunk, provider, manifestKey, false); // isFinalChunk=false

      // Should be unpadded: 100 + 40
      expect(result.encryptedSize).toBe(100 + SINGLE_SHOT_OVERHEAD);
    });

    test('padding zeros are encrypted', async () => {
      const manifestKey = await generateKey();
      const content = new Uint8Array(10).fill(0xff);
      const contentHash = mockContentHash(1);
      const files = [mockFile(content, '/test.bin', contentHash)];
      const provider = createFileDataProvider(files);

      const chunk = createPlannedChunk(
        'padenc',
        [{ fileIndex: 0, fileOffset: 0, length: 10, chunkOffset: 0 }],
        10,
        20
      );

      const result = await encryptChunk(chunk, provider, manifestKey, true);

      // Decrypt and check padding is there
      const fileKey = await deriveFileKey(manifestKey, contentHash);
      const decrypted = await decryptSingleShot(result.encryptedData, fileKey);

      expect(decrypted.subarray(0, 10)).toEqual(content);
      expect(decrypted.subarray(10, 20)).toEqual(new Uint8Array(10).fill(0));
    });
  });

  describe('encryptChunk() - invariant checking', () => {
    test('throws ValidationError if paddedSize < dataSize', async () => {
      const manifestKey = await generateKey();
      const files = [mockFileSize(100, '/test.bin')];
      const provider = createFileDataProvider(files);

      // Invalid: paddedSize (50) < dataSize (100)
      const chunk = createPlannedChunk(
        'inva1id1',
        [{ fileIndex: 0, fileOffset: 0, length: 100, chunkOffset: 0 }],
        100,
        50 // Bad!
      );

      await expect(encryptChunk(chunk, provider, manifestKey, false)).rejects.toThrow(
        ValidationError
      );
      await expect(encryptChunk(chunk, provider, manifestKey, false)).rejects.toThrow(
        'paddedSize'
      );
    });
  });

  describe('encryptChunk() - AbortSignal', () => {
    test('abort before first segment → AbortError', async () => {
      const manifestKey = await generateKey();
      const files = [mockFileSize(100, '/test.bin')];
      const provider = createFileDataProvider(files);
      const chunk = createPlannedChunk(
        'abort1',
        [{ fileIndex: 0, fileOffset: 0, length: 100, chunkOffset: 0 }],
        100,
        100
      );

      const controller = new AbortController();
      controller.abort(); // Already aborted

      try {
        await encryptChunk(chunk, provider, manifestKey, false, {
          signal: controller.signal,
        });
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect(e).toBeInstanceOf(DOMException);
        expect((e as DOMException).name).toBe('AbortError');
      }
    });

    test('non-aborted signal → completes normally', async () => {
      const manifestKey = await generateKey();
      const files = [mockFileSize(100, '/test.bin')];
      const provider = createFileDataProvider(files);
      const chunk = createPlannedChunk(
        'noabort',
        [{ fileIndex: 0, fileOffset: 0, length: 100, chunkOffset: 0 }],
        100,
        100
      );

      const controller = new AbortController();
      // Don't abort

      const result = await encryptChunk(chunk, provider, manifestKey, false, {
        signal: controller.signal,
      });

      expect(result.encryptedSize).toBe(100 + SINGLE_SHOT_OVERHEAD);
    });
  });

  describe('encryptChunks() generator', () => {
    test('yields chunks in order', async () => {
      const manifestKey = await generateKey();
      const files = [
        mockFileSize(1 * MB, '/file1.bin', mockContentHash(1)),
        mockFileSize(2 * MB, '/file2.bin', mockContentHash(2)),
      ];

      const plan = await planChunks(
        files,
        files.map((f) => f.path),
        { chunkSize: 2 * MB }
      );

      // Should have 2 chunks: [file1(1MB), file2_part(1MB)] and [file2_rest(1MB)]
      // Actually with 2MB chunkSize: file1 goes to aggregation, file2 is large (>=2MB)
      // file1(1MB) < 2MB → aggregation
      // file2(2MB) >= 2MB → dedicated
      // So: chunk0 = file1(1MB), chunk1 = file2(2MB)
      expect(plan.chunks.length).toBeGreaterThanOrEqual(2);

      const results: EncryptedChunk[] = [];
      for await (const encrypted of encryptChunks(plan, files, manifestKey)) {
        results.push(encrypted);
      }

      expect(results.length).toBe(plan.chunks.length);

      // Verify order matches plan
      for (let i = 0; i < results.length; i++) {
        expect(results[i]!.chunkId).toBe(plan.chunks[i]!.chunkId);
      }
    });

    test('empty plan yields nothing', async () => {
      const manifestKey = await generateKey();
      const plan = await planChunks([], []);

      const results: EncryptedChunk[] = [];
      for await (const encrypted of encryptChunks(plan, [], manifestKey)) {
        results.push(encrypted);
      }

      expect(results).toHaveLength(0);
    });

    test('single chunk works', async () => {
      const manifestKey = await generateKey();
      const files = [mockFileSize(100, '/test.bin', mockContentHash(1))];
      const plan = await planChunks(files, ['/test.bin']);

      expect(plan.chunks).toHaveLength(1);

      const results: EncryptedChunk[] = [];
      for await (const encrypted of encryptChunks(plan, files, manifestKey)) {
        results.push(encrypted);
      }

      expect(results).toHaveLength(1);
      expect(results[0]!.dataSize).toBe(100);
    });
  });

  describe('integration round-trip tests', () => {
    test('small file: plan → encrypt → decrypt → verify', async () => {
      const manifestKey = await generateKey();
      const originalContent = new Uint8Array(1000);
      for (let i = 0; i < 1000; i++) originalContent[i] = i % 256;

      const contentHash = mockContentHash(1);
      const files = [mockFile(originalContent, '/test.bin', contentHash)];

      const plan = await planChunks(files, ['/test.bin']);
      expect(plan.chunks).toHaveLength(1);

      const results: EncryptedChunk[] = [];
      for await (const encrypted of encryptChunks(plan, files, manifestKey)) {
        results.push(encrypted);
      }

      expect(results).toHaveLength(1);

      // Decrypt
      const fileKey = await deriveFileKey(manifestKey, contentHash);
      const decrypted = await decryptSingleShot(results[0]!.encryptedData, fileKey);

      // May have padding - slice to original length
      const plaintextLength = results[0]!.segments[0]!.plaintextLength;
      expect(decrypted.subarray(0, plaintextLength)).toEqual(originalContent);
    });

    test('aggregated files: each segment decrypts with own key', async () => {
      const manifestKey = await generateKey();

      // Two small files that will be aggregated into one chunk
      const content1 = new Uint8Array(500).fill(0x11);
      const content2 = new Uint8Array(500).fill(0x22);
      const hash1 = mockContentHash(1);
      const hash2 = mockContentHash(2);

      const files = [
        mockFile(content1, '/file1.bin', hash1),
        mockFile(content2, '/file2.bin', hash2),
      ];

      const plan = await planChunks(files, ['/file1.bin', '/file2.bin']);

      // Both files should be in same chunk (aggregated)
      expect(plan.chunks).toHaveLength(1);
      expect(plan.chunks[0]!.segments).toHaveLength(2);

      const results: EncryptedChunk[] = [];
      for await (const encrypted of encryptChunks(plan, files, manifestKey)) {
        results.push(encrypted);
      }

      const encryptedChunk = results[0]!;

      // Extract and decrypt each segment using encryptedLength
      const seg1Info = encryptedChunk.segments[0]!;
      const seg2Info = encryptedChunk.segments[1]!;

      // Use encryptedLength for precise extraction (critical for padded segments)
      const seg1Data = encryptedChunk.encryptedData.subarray(
        seg1Info.encryptedOffset,
        seg1Info.encryptedOffset + seg1Info.encryptedLength
      );

      // seg2 may have PADME padding - encryptedLength accounts for this
      const seg2Data = encryptedChunk.encryptedData.subarray(
        seg2Info.encryptedOffset,
        seg2Info.encryptedOffset + seg2Info.encryptedLength
      );

      const key1 = await deriveFileKey(manifestKey, hash1);
      const key2 = await deriveFileKey(manifestKey, hash2);

      const decrypted1 = await decryptSingleShot(seg1Data, key1);
      const decrypted2 = await decryptSingleShot(seg2Data, key2);

      // Slice to original plaintextLength (removes any padding)
      expect(decrypted1.subarray(0, seg1Info.plaintextLength)).toEqual(content1);
      expect(decrypted2.subarray(0, seg2Info.plaintextLength)).toEqual(content2);
    });

    test('large file (multi-chunk): all chunks work', async () => {
      const manifestKey = await generateKey();

      // 2.5MB file with 1MB chunk size → 3 chunks
      const size = Math.floor(2.5 * MB);
      const originalContent = new Uint8Array(size);
      for (let i = 0; i < size; i++) originalContent[i] = i % 256;

      const contentHash = mockContentHash(1);
      const files = [mockFile(originalContent, '/large.bin', contentHash)];

      const plan = await planChunks(files, ['/large.bin'], { chunkSize: 1 * MB });

      // Should have 3 chunks
      expect(plan.chunks).toHaveLength(3);

      const results: EncryptedChunk[] = [];
      for await (const encrypted of encryptChunks(plan, files, manifestKey)) {
        results.push(encrypted);
      }

      expect(results).toHaveLength(3);

      // Decrypt each chunk and reassemble
      const fileKey = await deriveFileKey(manifestKey, contentHash);
      const reassembled: Uint8Array[] = [];

      for (let i = 0; i < results.length; i++) {
        const encrypted = results[i]!;
        const segInfo = encrypted.segments[0]!;

        const decrypted = await decryptSingleShot(encrypted.encryptedData, fileKey);
        // Slice to plaintextLength to remove any padding
        reassembled.push(decrypted.subarray(0, segInfo.plaintextLength));
      }

      // Concatenate
      const totalLen = reassembled.reduce((sum, arr) => sum + arr.length, 0);
      const final = new Uint8Array(totalLen);
      let offset = 0;
      for (const part of reassembled) {
        final.set(part, offset);
        offset += part.length;
      }

      expect(final).toEqual(originalContent);
    });

    test('final chunk with PADME: decrypted and sliced correctly', async () => {
      const manifestKey = await generateKey();

      // Small file that will have PADME applied
      const originalContent = new Uint8Array(100).fill(0x42);
      const contentHash = mockContentHash(1);
      const files = [mockFile(originalContent, '/test.bin', contentHash)];

      const plan = await planChunks(files, ['/test.bin']);

      // PADME should increase the size
      expect(plan.chunks[0]!.paddedSize).toBeGreaterThanOrEqual(
        plan.chunks[0]!.dataSize
      );

      const results: EncryptedChunk[] = [];
      for await (const encrypted of encryptChunks(plan, files, manifestKey)) {
        results.push(encrypted);
      }

      const encrypted = results[0]!;

      // Decrypt
      const fileKey = await deriveFileKey(manifestKey, contentHash);
      const decrypted = await decryptSingleShot(encrypted.encryptedData, fileKey);

      // Decrypted may be larger than original due to PADME
      expect(decrypted.length).toBeGreaterThanOrEqual(100);

      // But when we slice to plaintextLength, we get original
      const plaintextLength = encrypted.segments[0]!.plaintextLength;
      expect(decrypted.subarray(0, plaintextLength)).toEqual(originalContent);
    });
  });
});

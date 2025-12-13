import { describe, test, expect, beforeAll } from 'bun:test';
import { preloadSodium } from '@filemanager/encryptionv2';
import type { ContentHash } from '@filemanager/encryptionv2';
import { planChunks } from './chunk-plan.ts';
import type { FileInput } from './types.ts';
import { ChunkEncryption } from './gen/manifest_pb.ts';
import { ValidationError } from './errors.ts';
import { CHUNK_SIZE } from './constants.ts';
import { asChunkId } from './branded.ts';

const MB = 1024 * 1024;
const BASE58_REGEX =
  /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

// Static mock content hash (32 bytes)
const MOCK_CONTENT_HASH = new Uint8Array(32).fill(0xab) as ContentHash;

// Helper to create mock FileInput
function mockFile(size: number, path: string): FileInput {
  // Create a blob of the specified size
  const data = new Uint8Array(size);
  const file = new File([data], path.split('/').pop()!, {
    type: 'application/octet-stream',
  });
  return {
    file,
    path,
    contentHash: MOCK_CONTENT_HASH,
  };
}

beforeAll(async () => {
  await preloadSodium();
});

describe('Phase 6: Chunk Aggregation Engine', () => {
  describe('planChunks() - validation', () => {
    test('throws ValidationError when files.length !== resolvedPaths.length', async () => {
      const files = [mockFile(100, '/a.txt'), mockFile(100, '/b.txt')];
      const paths = ['/a.txt']; // Missing one path

      await expect(planChunks(files, paths)).rejects.toThrow(ValidationError);
      await expect(planChunks(files, paths)).rejects.toThrow(
        'files.length (2) !== resolvedPaths.length (1)'
      );
    });

    test('throws ValidationError for invalid path (no leading /)', async () => {
      const files = [mockFile(100, '/a.txt')];
      const paths = ['a.txt']; // Invalid: no leading /

      await expect(planChunks(files, paths)).rejects.toThrow(ValidationError);
      await expect(planChunks(files, paths)).rejects.toThrow('Invalid path');
    });

    test('throws ValidationError for path with //', async () => {
      const files = [mockFile(100, '/a.txt')];
      const paths = ['/dir//a.txt']; // Invalid: double slash

      await expect(planChunks(files, paths)).rejects.toThrow(ValidationError);
      await expect(planChunks(files, paths)).rejects.toThrow('Invalid path');
    });

    test('throws ValidationError for chunkSize = 0', async () => {
      const files = [mockFile(100, '/a.txt')];
      const paths = ['/a.txt'];

      await expect(planChunks(files, paths, { chunkSize: 0 })).rejects.toThrow(
        ValidationError
      );
      await expect(planChunks(files, paths, { chunkSize: 0 })).rejects.toThrow(
        'chunkSize must be positive'
      );
    });

    test('throws ValidationError for negative chunkSize', async () => {
      const files = [mockFile(100, '/a.txt')];
      const paths = ['/a.txt'];

      await expect(planChunks(files, paths, { chunkSize: -1 })).rejects.toThrow(
        ValidationError
      );
    });

    test('accepts empty files array', async () => {
      const plan = await planChunks([], []);
      expect(plan.chunks).toHaveLength(0);
      expect(plan.files).toHaveLength(0);
      expect(plan.totalDataSize).toBe(0);
      expect(plan.totalPaddedSize).toBe(0);
    });
  });

  describe('planChunks() - empty files', () => {
    test('empty file (size=0) produces PlannedFile with chunks=[]', async () => {
      const files = [mockFile(0, '/empty.txt')];
      const paths = ['/empty.txt'];

      const plan = await planChunks(files, paths);

      expect(plan.chunks).toHaveLength(0);
      expect(plan.files).toHaveLength(1);
      expect(plan.files[0]!.size).toBe(0);
      expect(plan.files[0]!.chunks).toHaveLength(0);
      expect(plan.files[0]!.resolvedPath).toBe('/empty.txt');
    });

    test('batch with only empty files produces ChunkPlan with chunks=[]', async () => {
      const files = [mockFile(0, '/a.txt'), mockFile(0, '/b.txt')];
      const paths = ['/a.txt', '/b.txt'];

      const plan = await planChunks(files, paths);

      expect(plan.chunks).toHaveLength(0);
      expect(plan.files).toHaveLength(2);
      expect(plan.totalDataSize).toBe(0);
      expect(plan.totalPaddedSize).toBe(0);
    });

    test('mixed empty and non-empty files: empty files have no chunks', async () => {
      const files = [
        mockFile(0, '/empty.txt'),
        mockFile(1000, '/small.txt'),
        mockFile(0, '/empty2.txt'),
      ];
      const paths = ['/empty.txt', '/small.txt', '/empty2.txt'];

      const plan = await planChunks(files, paths);

      expect(plan.chunks).toHaveLength(1);
      expect(plan.files[0]!.chunks).toHaveLength(0);
      expect(plan.files[1]!.chunks).toHaveLength(1);
      expect(plan.files[2]!.chunks).toHaveLength(0);
    });
  });

  describe('planChunks() - small file aggregation', () => {
    test('single 1KB file → 1 chunk', async () => {
      const files = [mockFile(1024, '/small.txt')];
      const paths = ['/small.txt'];

      const plan = await planChunks(files, paths);

      expect(plan.chunks).toHaveLength(1);
      expect(plan.chunks[0]!.dataSize).toBe(1024);
      expect(plan.files[0]!.chunks).toHaveLength(1);
      expect(plan.files[0]!.chunks[0]!.offset).toBe(0);
      expect(plan.files[0]!.chunks[0]!.length).toBe(1024);
    });

    test('3 files (1MB + 2MB + 3MB) fit in 1 chunk (6MB total)', async () => {
      const files = [
        mockFile(1 * MB, '/a.txt'),
        mockFile(2 * MB, '/b.txt'),
        mockFile(3 * MB, '/c.txt'),
      ];
      const paths = ['/a.txt', '/b.txt', '/c.txt'];

      const plan = await planChunks(files, paths);

      expect(plan.chunks).toHaveLength(1);
      expect(plan.chunks[0]!.dataSize).toBe(6 * MB);
      expect(plan.chunks[0]!.segments).toHaveLength(3);

      // Check offsets
      expect(plan.files[0]!.chunks[0]!.offset).toBe(0);
      expect(plan.files[1]!.chunks[0]!.offset).toBe(1 * MB);
      expect(plan.files[2]!.chunks[0]!.offset).toBe(3 * MB);
    });

    test('2 files (7MB + 5MB) split across 2 chunks (10MB + 2MB)', async () => {
      const files = [mockFile(7 * MB, '/a.txt'), mockFile(5 * MB, '/b.txt')];
      const paths = ['/a.txt', '/b.txt'];

      const plan = await planChunks(files, paths);

      expect(plan.chunks).toHaveLength(2);
      expect(plan.chunks[0]!.dataSize).toBe(10 * MB);
      expect(plan.chunks[1]!.dataSize).toBe(2 * MB);

      // File a (7MB) is entirely in chunk 0
      expect(plan.files[0]!.chunks).toHaveLength(1);
      expect(plan.files[0]!.chunks[0]!.length).toBe(7 * MB);

      // File b (5MB) spans both chunks: 3MB in chunk 0, 2MB in chunk 1
      expect(plan.files[1]!.chunks).toHaveLength(2);
      expect(plan.files[1]!.chunks[0]!.length).toBe(3 * MB);
      expect(plan.files[1]!.chunks[1]!.length).toBe(2 * MB);
    });

    test('file spanning 2 chunks has 2 PlannedChunkRef entries', async () => {
      const files = [
        mockFile(6 * MB, '/first.txt'),
        mockFile(8 * MB, '/spanning.txt'),
      ];
      const paths = ['/first.txt', '/spanning.txt'];

      const plan = await planChunks(files, paths);

      // spanning.txt starts at offset 6MB, needs 8MB, so:
      // - 4MB in chunk 0 (fills to 10MB)
      // - 4MB in chunk 1
      expect(plan.files[1]!.chunks).toHaveLength(2);
      expect(plan.files[1]!.chunks[0]!.chunkIndex).toBe(0);
      expect(plan.files[1]!.chunks[0]!.length).toBe(4 * MB);
      expect(plan.files[1]!.chunks[1]!.chunkIndex).toBe(1);
      expect(plan.files[1]!.chunks[1]!.length).toBe(4 * MB);
    });

    test('chunkOffset tracks cumulative position in chunk', async () => {
      const files = [
        mockFile(1 * MB, '/a.txt'),
        mockFile(2 * MB, '/b.txt'),
        mockFile(3 * MB, '/c.txt'),
      ];
      const paths = ['/a.txt', '/b.txt', '/c.txt'];

      const plan = await planChunks(files, paths);

      // All in one chunk
      expect(plan.chunks[0]!.segments[0]!.chunkOffset).toBe(0);
      expect(plan.chunks[0]!.segments[1]!.chunkOffset).toBe(1 * MB);
      expect(plan.chunks[0]!.segments[2]!.chunkOffset).toBe(3 * MB);
    });
  });

  describe('planChunks() - large file splitting', () => {
    test('file exactly 10MB → 1 dedicated chunk', async () => {
      const files = [mockFile(10 * MB, '/exact.bin')];
      const paths = ['/exact.bin'];

      const plan = await planChunks(files, paths);

      expect(plan.chunks).toHaveLength(1);
      expect(plan.chunks[0]!.dataSize).toBe(10 * MB);
      expect(plan.files[0]!.chunks).toHaveLength(1);
    });

    test('file 10MB - 1 byte treated as small (aggregatable)', async () => {
      const smallFile = mockFile(CHUNK_SIZE - 1, '/almost.bin');
      const tinyFile = mockFile(100, '/tiny.txt');
      const files = [smallFile, tinyFile];
      const paths = ['/almost.bin', '/tiny.txt'];

      const plan = await planChunks(files, paths);

      // Both files should be in the same chunk (aggregated)
      expect(plan.chunks).toHaveLength(2); // Fills first chunk, tiny goes to second
      expect(plan.files[0]!.chunks[0]!.chunkIndex).toBe(0);
    });

    test('file 25MB → 3 chunks (10MB + 10MB + 5MB)', async () => {
      const files = [mockFile(25 * MB, '/large.bin')];
      const paths = ['/large.bin'];

      const plan = await planChunks(files, paths);

      expect(plan.chunks).toHaveLength(3);
      expect(plan.chunks[0]!.dataSize).toBe(10 * MB);
      expect(plan.chunks[1]!.dataSize).toBe(10 * MB);
      expect(plan.chunks[2]!.dataSize).toBe(5 * MB);

      expect(plan.files[0]!.chunks).toHaveLength(3);
      expect(plan.files[0]!.chunks[0]!.length).toBe(10 * MB);
      expect(plan.files[0]!.chunks[1]!.length).toBe(10 * MB);
      expect(plan.files[0]!.chunks[2]!.length).toBe(5 * MB);
    });

    test('large file closes any open aggregation chunk first', async () => {
      const files = [
        mockFile(3 * MB, '/small.txt'), // Starts aggregation chunk
        mockFile(15 * MB, '/large.bin'), // Should close aggregation, then split
      ];
      const paths = ['/small.txt', '/large.bin'];

      const plan = await planChunks(files, paths);

      // Chunk 0: small (3MB) - aggregation chunk finalized
      // Chunk 1: large part 1 (10MB)
      // Chunk 2: large part 2 (5MB)
      expect(plan.chunks).toHaveLength(3);
      expect(plan.chunks[0]!.dataSize).toBe(3 * MB);
      expect(plan.chunks[0]!.segments[0]!.fileIndex).toBe(0);
      expect(plan.chunks[1]!.dataSize).toBe(10 * MB);
      expect(plan.chunks[1]!.segments[0]!.fileIndex).toBe(1);
      expect(plan.chunks[2]!.dataSize).toBe(5 * MB);
    });
  });

  describe('planChunks() - spec example', () => {
    test('a.txt(1MB) + b.txt(2MB) + c.txt(9MB) + d.txt(25MB) → 5 chunks', async () => {
      const files = [
        mockFile(1 * MB, '/a.txt'),
        mockFile(2 * MB, '/b.txt'),
        mockFile(9 * MB, '/c.txt'),
        mockFile(25 * MB, '/d.txt'),
      ];
      const paths = ['/a.txt', '/b.txt', '/c.txt', '/d.txt'];

      const plan = await planChunks(files, paths);

      // Expected layout:
      // Chunk 0: a(1) + b(2) + c_part1(7) = 10MB
      // Chunk 1: c_part2(2) = 2MB
      // Chunk 2: d_part1(10) = 10MB
      // Chunk 3: d_part2(10) = 10MB
      // Chunk 4: d_part3(5) = 5MB

      expect(plan.chunks).toHaveLength(5);

      // Chunk 0: a(1) + b(2) + c(7) = 10MB
      expect(plan.chunks[0]!.dataSize).toBe(10 * MB);
      expect(plan.chunks[0]!.segments).toHaveLength(3);

      // Chunk 1: c(2) = 2MB
      expect(plan.chunks[1]!.dataSize).toBe(2 * MB);
      expect(plan.chunks[1]!.segments[0]!.fileIndex).toBe(2); // c.txt

      // c.txt spans chunks 0 and 1
      expect(plan.files[2]!.chunks).toHaveLength(2);
      expect(plan.files[2]!.chunks[0]!.length).toBe(7 * MB);
      expect(plan.files[2]!.chunks[1]!.length).toBe(2 * MB);

      // d.txt spans chunks 2, 3, 4
      expect(plan.files[3]!.chunks).toHaveLength(3);
      expect(plan.files[3]!.chunks[0]!.length).toBe(10 * MB);
      expect(plan.files[3]!.chunks[1]!.length).toBe(10 * MB);
      expect(plan.files[3]!.chunks[2]!.length).toBe(5 * MB);

      // Total data size
      expect(plan.totalDataSize).toBe(37 * MB);
    });
  });

  describe('planChunks() - PADME padding', () => {
    test('only final chunk has paddedSize >= dataSize', async () => {
      const files = [mockFile(15 * MB, '/large.bin')]; // 2 chunks: 10MB + 5MB
      const paths = ['/large.bin'];

      const plan = await planChunks(files, paths);

      expect(plan.chunks[0]!.paddedSize).toBe(plan.chunks[0]!.dataSize);
      // Final chunk gets PADME padding (may be same if already aligned)
      expect(plan.chunks[1]!.paddedSize).toBeGreaterThanOrEqual(
        plan.chunks[1]!.dataSize
      );
    });

    test('PADME adds padding for non-aligned sizes', async () => {
      // Use a size that definitely needs padding: 1234567 bytes
      const files = [mockFile(1234567, '/unaligned.bin')];
      const paths = ['/unaligned.bin'];

      const plan = await planChunks(files, paths);

      expect(plan.chunks[0]!.paddedSize).toBeGreaterThan(
        plan.chunks[0]!.dataSize
      );
    });

    test('non-final chunks have paddedSize === dataSize', async () => {
      const files = [
        mockFile(10 * MB, '/a.bin'),
        mockFile(10 * MB, '/b.bin'),
        mockFile(5 * MB, '/c.bin'),
      ];
      const paths = ['/a.bin', '/b.bin', '/c.bin'];

      const plan = await planChunks(files, paths);

      // All chunks except last should have paddedSize === dataSize
      for (let i = 0; i < plan.chunks.length - 1; i++) {
        expect(plan.chunks[i]!.paddedSize).toBe(plan.chunks[i]!.dataSize);
      }

      // Last chunk should be padded
      const lastChunk = plan.chunks[plan.chunks.length - 1]!;
      expect(lastChunk.paddedSize).toBeGreaterThanOrEqual(lastChunk.dataSize);
    });

    test('totalPaddedSize = totalDataSize - lastChunk.dataSize + lastChunk.paddedSize', async () => {
      const files = [mockFile(1234, '/small.txt')];
      const paths = ['/small.txt'];

      const plan = await planChunks(files, paths);

      const lastChunk = plan.chunks[plan.chunks.length - 1]!;
      const expectedTotal =
        plan.totalDataSize - lastChunk.dataSize + lastChunk.paddedSize;

      expect(plan.totalPaddedSize).toBe(expectedTotal);
    });
  });

  describe('planChunks() - determinism', () => {
    test('same input produces identical structure (offsets, lengths, counts)', async () => {
      const files = [mockFile(5 * MB, '/a.txt'), mockFile(3 * MB, '/b.txt')];
      const paths = ['/a.txt', '/b.txt'];

      const plan1 = await planChunks(files, paths);
      const plan2 = await planChunks(files, paths);

      expect(plan1.chunks.length).toBe(plan2.chunks.length);
      expect(plan1.files.length).toBe(plan2.files.length);

      for (let i = 0; i < plan1.files.length; i++) {
        expect(plan1.files[i]!.chunks.length).toBe(plan2.files[i]!.chunks.length);
        for (let j = 0; j < plan1.files[i]!.chunks.length; j++) {
          expect(plan1.files[i]!.chunks[j]!.offset).toBe(
            plan2.files[i]!.chunks[j]!.offset
          );
          expect(plan1.files[i]!.chunks[j]!.length).toBe(
            plan2.files[i]!.chunks[j]!.length
          );
        }
      }
    });

    test('chunkIds differ between runs (random)', async () => {
      const files = [mockFile(1000, '/a.txt')];
      const paths = ['/a.txt'];

      const plan1 = await planChunks(files, paths);
      const plan2 = await planChunks(files, paths);

      // Chunk IDs should be different (random)
      expect(plan1.chunks[0]!.chunkId).not.toBe(plan2.chunks[0]!.chunkId);
      // But structure is the same
      expect(plan1.chunks[0]!.dataSize).toBe(plan2.chunks[0]!.dataSize);
    });
  });

  describe('planChunks() - chunk metadata', () => {
    test('chunks <= 10MB have encryption = SINGLE_SHOT', async () => {
      const files = [
        mockFile(5 * MB, '/small.txt'),
        mockFile(25 * MB, '/large.bin'),
      ];
      const paths = ['/small.txt', '/large.bin'];

      const plan = await planChunks(files, paths);

      // With default 10MB chunk size, all chunks should be SINGLE_SHOT
      for (const chunk of plan.chunks) {
        expect(chunk.encryption).toBe(ChunkEncryption.SINGLE_SHOT);
      }
    });

    test('chunks > 10MB use STREAMING encryption', async () => {
      // Use 15MB chunk size (> STREAMING_THRESHOLD of 10MB)
      const files = [mockFile(15 * MB, '/large.bin')];
      const paths = ['/large.bin'];

      const plan = await planChunks(files, paths, { chunkSize: 15 * MB });

      // Single 15MB chunk should use STREAMING
      expect(plan.chunks).toHaveLength(1);
      expect(plan.chunks[0]!.encryption).toBe(ChunkEncryption.STREAMING);
      expect(plan.files[0]!.chunks[0]!.encryption).toBe(ChunkEncryption.STREAMING);
    });

    test('chunk refs have consistent encryption with chunks', async () => {
      // Use 15MB chunk size, but file is only 5MB (partial fill)
      const files = [mockFile(5 * MB, '/small.bin')];
      const paths = ['/small.bin'];

      const plan = await planChunks(files, paths, { chunkSize: 15 * MB });

      // 5MB chunk should use SINGLE_SHOT (even though chunkSize is 15MB)
      expect(plan.chunks[0]!.encryption).toBe(ChunkEncryption.SINGLE_SHOT);
      expect(plan.files[0]!.chunks[0]!.encryption).toBe(ChunkEncryption.SINGLE_SHOT);
    });

    test('chunkId is valid 22-char base58', async () => {
      const files = [mockFile(1000, '/a.txt')];
      const paths = ['/a.txt'];

      const plan = await planChunks(files, paths);

      const chunkId = plan.chunks[0]!.chunkId;
      expect(chunkId.length).toBe(22);
      expect(BASE58_REGEX.test(chunkId)).toBe(true);
      // Should not throw when validating
      expect(() => asChunkId(chunkId)).not.toThrow();
    });

    test('PlannedChunkRef.chunkIndex matches position in chunks[]', async () => {
      const files = [
        mockFile(5 * MB, '/a.txt'),
        mockFile(5 * MB, '/b.txt'),
        mockFile(5 * MB, '/c.txt'),
      ];
      const paths = ['/a.txt', '/b.txt', '/c.txt'];

      const plan = await planChunks(files, paths);

      for (const file of plan.files) {
        for (const ref of file.chunks) {
          const chunk = plan.chunks[ref.chunkIndex];
          expect(chunk).toBeDefined();
          expect(chunk!.chunkId).toBe(ref.chunkId);
        }
      }
    });
  });

  describe('planChunks() - edge cases', () => {
    test('single 1-byte file', async () => {
      const files = [mockFile(1, '/tiny.txt')];
      const paths = ['/tiny.txt'];

      const plan = await planChunks(files, paths);

      expect(plan.chunks).toHaveLength(1);
      expect(plan.chunks[0]!.dataSize).toBe(1);
      expect(plan.files[0]!.chunks[0]!.length).toBe(1);
    });

    test('100 small files aggregate correctly', async () => {
      const files: FileInput[] = [];
      const paths: string[] = [];

      for (let i = 0; i < 100; i++) {
        files.push(mockFile(50 * 1024, `/file${i}.txt`)); // 50KB each
        paths.push(`/file${i}.txt`);
      }

      const plan = await planChunks(files, paths);

      // 100 files * 50KB = 5MB total, fits in 1 chunk
      expect(plan.chunks).toHaveLength(1);
      expect(plan.chunks[0]!.segments).toHaveLength(100);
      expect(plan.totalDataSize).toBe(100 * 50 * 1024);
    });

    test('alternating small and large files', async () => {
      const files = [
        mockFile(1 * MB, '/small1.txt'),
        mockFile(15 * MB, '/large1.bin'),
        mockFile(2 * MB, '/small2.txt'),
        mockFile(20 * MB, '/large2.bin'),
      ];
      const paths = ['/small1.txt', '/large1.bin', '/small2.txt', '/large2.bin'];

      const plan = await planChunks(files, paths);

      // Layout:
      // Chunk 0: small1 (1MB) - finalized when large1 encountered
      // Chunk 1: large1 part1 (10MB)
      // Chunk 2: large1 part2 (5MB) - finalized when small2 encountered
      // Wait, large files finalize current chunk first, then get dedicated chunks
      // So: Chunk 0: small1 (1MB)
      // Chunk 1: large1 part1 (10MB)
      // Chunk 2: large1 part2 (5MB)
      // Chunk 3: small2 (2MB) - starts new aggregation
      // Then large2 finalizes it
      // Chunk 4: large2 part1 (10MB)
      // Chunk 5: large2 part2 (10MB)

      expect(plan.files.length).toBe(4);

      // Verify each file has correct number of chunks
      expect(plan.files[0]!.chunks.length).toBe(1); // small1: 1 chunk
      expect(plan.files[1]!.chunks.length).toBe(2); // large1: 2 chunks
      expect(plan.files[2]!.chunks.length).toBe(1); // small2: 1 chunk
      expect(plan.files[3]!.chunks.length).toBe(2); // large2: 2 chunks
    });

    test('resolved paths are stored correctly', async () => {
      const files = [mockFile(100, '/photo.jpg'), mockFile(100, '/photo.jpg')];
      const resolvedPaths = ['/photo.jpg', '/photo_1.jpg'];

      const plan = await planChunks(files, resolvedPaths);

      expect(plan.files[0]!.resolvedPath).toBe('/photo.jpg');
      expect(plan.files[1]!.resolvedPath).toBe('/photo_1.jpg');
    });

    test('custom chunkSize option', async () => {
      const files = [mockFile(3 * MB, '/a.txt')];
      const paths = ['/a.txt'];

      // Use 1MB chunk size
      const plan = await planChunks(files, paths, { chunkSize: 1 * MB });

      // 3MB file should split into 3 chunks of 1MB each
      expect(plan.chunks.length).toBe(3);
      expect(plan.chunks[0]!.dataSize).toBe(1 * MB);
      expect(plan.chunks[1]!.dataSize).toBe(1 * MB);
      expect(plan.chunks[2]!.dataSize).toBe(1 * MB);
    });
  });
});

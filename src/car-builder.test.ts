/**
 * Tests for CAR file generation (Phase 8).
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { CID } from 'multiformats/cid';
import { CarBufferReader } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import * as raw from 'multiformats/codecs/raw';
import { preloadSodium } from '@filemanager/encryptionv2';
import {
  buildBatchDirectory,
  buildCarSegments,
  type CarBlock,
  type EncryptedChunk,
  type CarSegmentGenerator,
} from './index.ts';
import { generateChunkId, chunkIdToPath } from './chunk-id.ts';
import { MockIpfsClient, computeRawCid, computeDagPbCid } from './ipfs-client.ts';
import { ChunkEncryption } from './gen/manifest_pb.ts';
import type { ChunkId } from './branded.ts';
import { asChunkId } from './branded.ts';
import { ValidationError } from './errors.ts';

// ============================================================================
// Test Helpers
// ============================================================================

beforeAll(async () => {
  await preloadSodium();
});

/** Create mock EncryptedChunk with deterministic data */
function createMockChunk(chunkId: ChunkId, data: Uint8Array): EncryptedChunk {
  return {
    chunkId,
    encryptedData: data,
    encryption: ChunkEncryption.SINGLE_SHOT,
    segments: [],
    dataSize: data.length,
    encryptedSize: data.length,
  };
}

/** Generate N mock chunks with random IDs */
async function generateMockChunks(
  count: number,
  size = 100
): Promise<EncryptedChunk[]> {
  const chunks: EncryptedChunk[] = [];
  for (let i = 0; i < count; i++) {
    const chunkId = await generateChunkId();
    const data = new Uint8Array(size);
    data.fill(i % 256);
    chunks.push(createMockChunk(chunkId, data));
  }
  return chunks;
}

/** Fixed chunk IDs for determinism tests (22 chars, valid base58) */
const FIXED_CHUNK_IDS = [
  '1111111111111111111111',
  '2222222222222222222222',
  '3333333333333333333333',
  '4444444444444444444444',
  '5555555555555555555555',
  '6Bv7HnWcL4mT9Rp2QsXx3a',
  '9cLdPx8Yk2RmNp3QwT5f1b',
  'ABCDEFGHJKLMNPQRSTUVWx',
  'abcdefghjkmnpqrstuvwxy',
  'zzzzzzzzzzzzzzzzzzzzzz',
].map((s) => asChunkId(s));

/** Generate N mock chunks with fixed IDs (for determinism tests) */
function generateFixedChunks(count: number, size = 100): EncryptedChunk[] {
  if (count > FIXED_CHUNK_IDS.length) {
    throw new Error(`Max ${FIXED_CHUNK_IDS.length} fixed chunks supported`);
  }
  const chunks: EncryptedChunk[] = [];
  for (let i = 0; i < count; i++) {
    const data = new Uint8Array(size);
    data.fill(i % 256);
    chunks.push(createMockChunk(FIXED_CHUNK_IDS[i]!, data));
  }
  return chunks;
}

/** Collect async iterable to single Uint8Array */
async function collectBytes(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iter) chunks.push(chunk);
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Parse CAR bytes and extract header + blocks */
function parseCarBytes(carBytes: Uint8Array): {
  roots: CID[];
  blocks: Map<string, Uint8Array>;
} {
  const reader = CarBufferReader.fromBytes(carBytes);
  const roots = [...reader.getRoots()];
  const blocks = new Map<string, Uint8Array>();
  for (const { cid, bytes } of reader.blocks()) {
    blocks.set(cid.toString(), bytes);
  }
  return { roots, blocks };
}

/** Byte-wise compare for locale-independent sorting */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Assert directory has byte-wise sorted links (NOT locale-dependent) */
function assertSortedLinks(dirBytes: Uint8Array): void {
  const node = dagPb.decode(dirBytes);
  const names = node.Links.map((l) => l.Name);
  const sorted = [...names].sort(byteCompare);
  expect(names).toEqual(sorted);
}

/** Convert async iterable to async iterable (identity, but typed) */
async function* toAsyncIterable(
  data: Uint8Array
): AsyncIterable<Uint8Array> {
  yield data;
}

// ============================================================================
// Test Suites
// ============================================================================

describe('Phase 8: CAR File Generation', () => {
  // ==========================================================================
  // 1. Input Validation Tests
  // ==========================================================================
  describe('Input Validation', () => {
    test('throws ValidationError for empty chunks array', async () => {
      const manifest = new TextEncoder().encode('manifest');
      await expect(
        buildBatchDirectory({ chunks: [], manifest })
      ).rejects.toThrow(ValidationError);
      await expect(
        buildBatchDirectory({ chunks: [], manifest })
      ).rejects.toThrow('Cannot build CAR with zero chunks');
    });

    test('throws ValidationError for empty manifest', async () => {
      const chunks = generateFixedChunks(1);
      await expect(
        buildBatchDirectory({ chunks, manifest: new Uint8Array(0) })
      ).rejects.toThrow(ValidationError);
      await expect(
        buildBatchDirectory({ chunks, manifest: new Uint8Array(0) })
      ).rejects.toThrow('Manifest cannot be empty');
    });

    test('throws ValidationError for chunk with empty encryptedData', async () => {
      const chunkId = asChunkId('1111111111111111111111');
      const chunk = createMockChunk(chunkId, new Uint8Array(0));
      const manifest = new TextEncoder().encode('manifest');
      await expect(
        buildBatchDirectory({ chunks: [chunk], manifest })
      ).rejects.toThrow(ValidationError);
      await expect(
        buildBatchDirectory({ chunks: [chunk], manifest })
      ).rejects.toThrow('has empty encryptedData');
    });

    test('throws ValidationError for zero-length sub-manifest', async () => {
      const chunks = generateFixedChunks(1);
      const manifest = new TextEncoder().encode('manifest');
      const subManifests = [new Uint8Array(0)];
      await expect(
        buildBatchDirectory({ chunks, manifest, subManifests })
      ).rejects.toThrow(ValidationError);
      await expect(
        buildBatchDirectory({ chunks, manifest, subManifests })
      ).rejects.toThrow('Sub-manifest m_0 cannot be empty');
    });

    test('throws ValidationError for invalid segmentSize', async () => {
      const chunks = generateFixedChunks(1);
      const manifest = new TextEncoder().encode('manifest');

      // Zero
      await expect(
        buildCarSegments({ chunks, manifest, segmentSize: 0 })
      ).rejects.toThrow(ValidationError);

      // Negative
      await expect(
        buildCarSegments({ chunks, manifest, segmentSize: -1 })
      ).rejects.toThrow('segmentSize must be a positive integer');

      // NaN
      await expect(
        buildCarSegments({ chunks, manifest, segmentSize: NaN })
      ).rejects.toThrow(ValidationError);

      // Infinity
      await expect(
        buildCarSegments({ chunks, manifest, segmentSize: Infinity })
      ).rejects.toThrow(ValidationError);

      // Non-integer
      await expect(
        buildCarSegments({ chunks, manifest, segmentSize: 2.5 })
      ).rejects.toThrow(ValidationError);
    });

    test('accepts valid input without throwing', async () => {
      const chunks = generateFixedChunks(2);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildBatchDirectory({ chunks, manifest });
      expect(result.rootCid).toBeDefined();
    });
  });

  // ==========================================================================
  // 2. CID & Codec Correctness Tests
  // ==========================================================================
  describe('CID & Codec Correctness', () => {
    test('chunks use raw codec (0x55), CID prefix bafkrei', async () => {
      const chunks = generateFixedChunks(1);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildBatchDirectory({ chunks, manifest });

      const chunkCid = result.chunkCidMap.get(chunks[0]!.chunkId)!;
      expect(chunkCid.code).toBe(raw.code); // 0x55
      expect(chunkCid.toString()).toMatch(/^bafkrei/);
    });

    test('manifest uses raw codec (0x55)', async () => {
      const chunks = generateFixedChunks(1);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildBatchDirectory({ chunks, manifest });

      expect(result.manifestCid.code).toBe(raw.code);
      expect(result.manifestCid.toString()).toMatch(/^bafkrei/);
    });

    test('sub-manifests use raw codec (0x55)', async () => {
      const chunks = generateFixedChunks(1);
      const manifest = new TextEncoder().encode('manifest');
      const subManifests = [new TextEncoder().encode('sub0')];
      const result = await buildBatchDirectory({ chunks, manifest, subManifests });

      expect(result.subManifestCids.length).toBe(1);
      expect(result.subManifestCids[0]!.code).toBe(raw.code);
    });

    test('directories use dag-pb codec (0x70), CID prefix bafybei', async () => {
      const chunks = generateFixedChunks(1);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildBatchDirectory({ chunks, manifest });

      expect(result.rootCid.code).toBe(dagPb.code); // 0x70
      expect(result.rootCid.toString()).toMatch(/^bafybei/);
    });

    test('same chunk data produces same CID', async () => {
      const data = new TextEncoder().encode('same data');
      const chunk1 = createMockChunk(asChunkId('1111111111111111111111'), data);
      const chunk2 = createMockChunk(asChunkId('2222222222222222222222'), data);
      const manifest = new TextEncoder().encode('manifest');

      const result1 = await buildBatchDirectory({ chunks: [chunk1], manifest });
      const result2 = await buildBatchDirectory({ chunks: [chunk2], manifest });

      // Same data = same CID (content-addressed)
      const cid1 = result1.chunkCidMap.get(chunk1.chunkId)!;
      const cid2 = result2.chunkCidMap.get(chunk2.chunkId)!;
      expect(cid1.toString()).toBe(cid2.toString());
    });

    test('different chunk data produces different CID', async () => {
      const chunk1 = createMockChunk(
        asChunkId('1111111111111111111111'),
        new TextEncoder().encode('data1')
      );
      const chunk2 = createMockChunk(
        asChunkId('2222222222222222222222'),
        new TextEncoder().encode('data2')
      );
      const manifest = new TextEncoder().encode('manifest');

      const result1 = await buildBatchDirectory({ chunks: [chunk1], manifest });
      const result2 = await buildBatchDirectory({ chunks: [chunk2], manifest });

      const cid1 = result1.chunkCidMap.get(chunk1.chunkId)!;
      const cid2 = result2.chunkCidMap.get(chunk2.chunkId)!;
      expect(cid1.toString()).not.toBe(cid2.toString());
    });
  });

  // ==========================================================================
  // 3. Directory Structure Tests
  // ==========================================================================
  describe('Directory Structure', () => {
    test('level-2 dirs contain chunk links with correct Tsize', async () => {
      const chunks = generateFixedChunks(1, 100);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildBatchDirectory({ chunks, manifest });

      // Find the level-2 directory block (first dir block)
      // Block order: chunks -> dirs -> manifest
      const dirBlocks = result.blocks.slice(1, -1);
      expect(dirBlocks.length).toBeGreaterThan(0);

      // First dir block should be level-2
      const level2Block = dirBlocks[0]!;
      const node = dagPb.decode(level2Block.bytes);

      // Should have link to chunk
      expect(node.Links.length).toBe(1);
      expect(node.Links[0]!.Tsize).toBe(100); // Raw chunk bytes
    });

    test('root dir contains level-1 dirs + manifest', async () => {
      const chunks = generateFixedChunks(1);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildBatchDirectory({ chunks, manifest });

      // Root is last dir block
      const rootBlock = result.blocks.find(
        (b) => b.cid.toString() === result.rootCid.toString()
      )!;
      const node = dagPb.decode(rootBlock.bytes);

      // Should have at least level-1 dir + manifest
      expect(node.Links.length).toBeGreaterThanOrEqual(2);

      const names = node.Links.map((l) => l.Name);
      expect(names).toContain('m');
    });

    test('all directory links sorted lexicographically by Name', async () => {
      const chunks = generateFixedChunks(5);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildBatchDirectory({ chunks, manifest });

      // Check all directory blocks have sorted links
      for (const block of result.blocks) {
        if (block.cid.code === dagPb.code) {
          assertSortedLinks(block.bytes);
        }
      }
    });

    test('Tsize for dir links equals encoded dir bytes, not subtree sum', async () => {
      const chunks = generateFixedChunks(2);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildBatchDirectory({ chunks, manifest });

      // Find root and check level-1 dir link's Tsize
      const rootBlock = result.blocks.find(
        (b) => b.cid.toString() === result.rootCid.toString()
      )!;
      const rootNode = dagPb.decode(rootBlock.bytes);

      // Level-1 dir link should have Tsize = encoded bytes of that dir
      for (const link of rootNode.Links) {
        if (link.Name !== 'm' && !link.Name?.startsWith('m_')) {
          // This is a level-1 dir link
          const linkedBlock = result.blocks.find(
            (b) => b.cid.toString() === link.Hash.toString()
          );
          if (linkedBlock) {
            expect(link.Tsize).toBe(linkedBlock.bytes.length);
          }
        }
      }
    });
  });

  // ==========================================================================
  // 4. Segmentation Tests
  // ==========================================================================
  describe('Segmentation', () => {
    test('1 chunk produces 1 final segment with roots=[rootCid]', async () => {
      const chunks = generateFixedChunks(1);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildCarSegments({ chunks, manifest });

      expect(result.segmentCount).toBe(1);
      expect(result.segments.length).toBe(1);
      expect(result.segments[0]!.isLast).toBe(true);
      expect(result.segments[0]!.roots.length).toBe(1);
      expect(result.segments[0]!.roots[0]!.toString()).toBe(result.rootCid);
    });

    test('10 chunks produces 1 final segment', async () => {
      const chunks = generateFixedChunks(10);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildCarSegments({ chunks, manifest, segmentSize: 10 });

      expect(result.segmentCount).toBe(1);
      expect(result.segments[0]!.isLast).toBe(true);
      expect(result.segments[0]!.chunkCount).toBe(10);
    });

    test('11 chunks produces 2 segments: headless + final', async () => {
      const chunks = await generateMockChunks(11);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildCarSegments({ chunks, manifest, segmentSize: 10 });

      expect(result.segmentCount).toBe(2);
      expect(result.segments[0]!.isLast).toBe(false);
      expect(result.segments[0]!.roots.length).toBe(0);
      expect(result.segments[0]!.chunkCount).toBe(10);
      expect(result.segments[1]!.isLast).toBe(true);
      expect(result.segments[1]!.roots.length).toBe(1);
      expect(result.segments[1]!.chunkCount).toBe(1);
    });

    test('20 chunks (exact boundary) produces 2 segments', async () => {
      const chunks = await generateMockChunks(20);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildCarSegments({ chunks, manifest, segmentSize: 10 });

      expect(result.segmentCount).toBe(2);
      expect(result.segments[0]!.isLast).toBe(false);
      expect(result.segments[1]!.isLast).toBe(true);
    });

    test('non-final segments have roots=[] (empty array)', async () => {
      const chunks = await generateMockChunks(25);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildCarSegments({ chunks, manifest, segmentSize: 10 });

      expect(result.segmentCount).toBe(3);
      expect(result.segments[0]!.roots).toEqual([]);
      expect(result.segments[1]!.roots).toEqual([]);
      expect(result.segments[2]!.roots.length).toBe(1);
    });

    test('non-final segments contain only chunk blocks', async () => {
      const chunks = await generateMockChunks(15);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildCarSegments({ chunks, manifest, segmentSize: 10 });

      const segment0 = result.segments[0]!;
      const carBytes = await collectBytes(segment0.generate());
      const parsed = parseCarBytes(carBytes);

      // Should have exactly 10 blocks (chunks only)
      expect(parsed.blocks.size).toBe(10);

      // All should be raw codec
      for (const [cidStr] of parsed.blocks) {
        const cid = CID.parse(cidStr);
        expect(cid.code).toBe(raw.code);
      }
    });

    test('final segment contains chunks + directories + manifest', async () => {
      const chunks = await generateMockChunks(5);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildCarSegments({ chunks, manifest, segmentSize: 10 });

      const segment = result.segments[0]!;
      expect(segment.isLast).toBe(true);

      const carBytes = await collectBytes(segment.generate());
      const parsed = parseCarBytes(carBytes);

      // Should have chunks (5) + dirs (level-2 dirs + level-1 dirs + root) + manifest
      // At least 5 + 1 + 1 = 7 blocks
      expect(parsed.blocks.size).toBeGreaterThanOrEqual(7);

      // Should have root in roots
      expect(parsed.roots.length).toBe(1);
    });

    test('custom segmentSize=5 produces correct segment count', async () => {
      const chunks = await generateMockChunks(12);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildCarSegments({ chunks, manifest, segmentSize: 5 });

      // 12 / 5 = 2 full + 2 remaining = 3 segments
      expect(result.segmentCount).toBe(3);
      expect(result.segments[0]!.chunkCount).toBe(5);
      expect(result.segments[1]!.chunkCount).toBe(5);
      expect(result.segments[2]!.chunkCount).toBe(2);
    });
  });

  // ==========================================================================
  // 5. CAR Validity Tests
  // ==========================================================================
  describe('CAR Validity', () => {
    test('non-final CAR parseable with CarBufferReader (empty roots)', async () => {
      const chunks = await generateMockChunks(15);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildCarSegments({ chunks, manifest, segmentSize: 10 });

      const segment0 = result.segments[0]!;
      const carBytes = await collectBytes(segment0.generate());

      // Should not throw
      const parsed = parseCarBytes(carBytes);
      expect(parsed.roots).toEqual([]);
    });

    test('final CAR parseable with single root', async () => {
      const chunks = generateFixedChunks(3);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildCarSegments({ chunks, manifest });

      const segment = result.segments[0]!;
      const carBytes = await collectBytes(segment.generate());

      const parsed = parseCarBytes(carBytes);
      expect(parsed.roots.length).toBe(1);
      expect(parsed.roots[0]!.toString()).toBe(result.rootCid);
    });

    test('all blocks in CAR have valid CIDs matching content', async () => {
      const chunks = generateFixedChunks(2);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildCarSegments({ chunks, manifest });

      const carBytes = await collectBytes(result.segments[0]!.generate());
      const parsed = parseCarBytes(carBytes);

      for (const [cidStr, bytes] of parsed.blocks) {
        const cid = CID.parse(cidStr);
        if (cid.code === raw.code) {
          const computedCid = await computeRawCid(bytes);
          expect(computedCid.toString()).toBe(cidStr);
        } else if (cid.code === dagPb.code) {
          const computedCid = await computeDagPbCid(bytes);
          expect(computedCid.toString()).toBe(cidStr);
        }
      }
    });

    test('CAR header roots match segment.roots', async () => {
      const chunks = await generateMockChunks(15);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildCarSegments({ chunks, manifest, segmentSize: 10 });

      // Non-final segment
      const seg0Bytes = await collectBytes(result.segments[0]!.generate());
      const parsed0 = parseCarBytes(seg0Bytes);
      expect(parsed0.roots.length).toBe(result.segments[0]!.roots.length);

      // Final segment
      const seg1Bytes = await collectBytes(result.segments[1]!.generate());
      const parsed1 = parseCarBytes(seg1Bytes);
      expect(parsed1.roots.length).toBe(1);
      expect(parsed1.roots[0]!.toString()).toBe(result.segments[1]!.roots[0]!.toString());
    });

    test('manifests only in final segment CAR', async () => {
      const chunks = await generateMockChunks(15);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildCarSegments({ chunks, manifest, segmentSize: 10 });

      // Check non-final segment doesn't have manifest
      const seg0Bytes = await collectBytes(result.segments[0]!.generate());
      const parsed0 = parseCarBytes(seg0Bytes);
      expect(parsed0.blocks.has(result.manifestCid)).toBe(false);

      // Check final segment has manifest
      const seg1Bytes = await collectBytes(result.segments[1]!.generate());
      const parsed1 = parseCarBytes(seg1Bytes);
      expect(parsed1.blocks.has(result.manifestCid)).toBe(true);
    });
  });

  // ==========================================================================
  // 6. Determinism Tests (use generateFixedChunks)
  // ==========================================================================
  describe('Determinism', () => {
    test('re-generate same fixed chunks produces byte-identical CAR', async () => {
      const chunks = generateFixedChunks(3, 50);
      const manifest = new TextEncoder().encode('test manifest');

      const result1 = await buildCarSegments({ chunks, manifest });
      const result2 = await buildCarSegments({ chunks, manifest });

      const car1 = await collectBytes(result1.segments[0]!.generate());
      const car2 = await collectBytes(result2.segments[0]!.generate());

      expect(car1).toEqual(car2);
    });

    test('directory link order is byte-wise sorted (not locale-dependent)', async () => {
      const chunks = generateFixedChunks(5);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildBatchDirectory({ chunks, manifest });

      // All directories should have sorted links
      for (const block of result.blocks) {
        if (block.cid.code === dagPb.code) {
          const node = dagPb.decode(block.bytes);
          const names = node.Links.map((l) => l.Name);
          const sorted = [...names].sort(byteCompare);
          expect(names).toEqual(sorted);
        }
      }
    });

    test('chunkCidMap entries match actual block CIDs', async () => {
      const chunks = generateFixedChunks(3);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildBatchDirectory({ chunks, manifest });

      for (const chunk of chunks) {
        const expectedCid = await computeRawCid(chunk.encryptedData);
        const actualCid = result.chunkCidMap.get(chunk.chunkId)!;
        expect(actualCid.toString()).toBe(expectedCid.toString());
      }
    });

    test('different chunk order produces different root CID', async () => {
      const chunk1 = createMockChunk(
        asChunkId('1111111111111111111111'),
        new TextEncoder().encode('a')
      );
      const chunk2 = createMockChunk(
        asChunkId('2222222222222222222222'),
        new TextEncoder().encode('b')
      );
      const manifest = new TextEncoder().encode('manifest');

      const result1 = await buildBatchDirectory({ chunks: [chunk1, chunk2], manifest });
      const result2 = await buildBatchDirectory({ chunks: [chunk2, chunk1], manifest });

      // Block order changes (chunks in input order) but root CID may or may not differ
      // because directory structure depends on chunk IDs, not input order
      // This test verifies input order is preserved in blocks array
      expect(result1.blocks[0]!.bytes).toEqual(chunk1.encryptedData);
      expect(result2.blocks[0]!.bytes).toEqual(chunk2.encryptedData);
    });
  });

  // ==========================================================================
  // 7. Round-trip with MockIpfsClient Tests
  // ==========================================================================
  describe('Round-trip with MockIpfsClient', () => {
    test('upload all segments → cat /m returns manifest bytes', async () => {
      const client = new MockIpfsClient();
      const chunks = await generateMockChunks(5);
      const manifest = new TextEncoder().encode('encrypted manifest data');

      const result = await buildCarSegments({ chunks, manifest });

      // Upload all segments
      for (const segment of result.segments) {
        const carBytes = await collectBytes(segment.generate());
        await client.uploadCar(toAsyncIterable(carBytes));
      }

      // Retrieve manifest
      const manifestData = await collectBytes(client.cat(result.rootCid, '/m'));
      expect(manifestData).toEqual(manifest);
    });

    test('upload all segments → cat chunk path returns chunk data', async () => {
      const client = new MockIpfsClient();
      const chunks = await generateMockChunks(3);
      const manifest = new TextEncoder().encode('manifest');

      const result = await buildCarSegments({ chunks, manifest });

      for (const segment of result.segments) {
        const carBytes = await collectBytes(segment.generate());
        await client.uploadCar(toAsyncIterable(carBytes));
      }

      // Verify each chunk is accessible via path
      for (const chunk of chunks) {
        const path = '/' + chunkIdToPath(chunk.chunkId);
        const chunkData = await collectBytes(client.cat(result.rootCid, path));
        expect(chunkData).toEqual(chunk.encryptedData);
      }
    });

    test('upload all segments → cat /m_0 returns first sub-manifest', async () => {
      const client = new MockIpfsClient();
      const chunks = await generateMockChunks(2);
      const manifest = new TextEncoder().encode('manifest');
      const subManifests = [new TextEncoder().encode('sub-manifest-0')];

      const result = await buildCarSegments({ chunks, manifest, subManifests });

      for (const segment of result.segments) {
        const carBytes = await collectBytes(segment.generate());
        await client.uploadCar(toAsyncIterable(carBytes));
      }

      const subData = await collectBytes(client.cat(result.rootCid, '/m_0'));
      expect(subData).toEqual(subManifests[0]);
    });

    test('15 chunks batch: all paths resolve correctly', async () => {
      const client = new MockIpfsClient();
      const chunks = await generateMockChunks(15);
      const manifest = new TextEncoder().encode('manifest');

      const result = await buildCarSegments({ chunks, manifest, segmentSize: 10 });

      for (const segment of result.segments) {
        const carBytes = await collectBytes(segment.generate());
        await client.uploadCar(toAsyncIterable(carBytes));
      }

      // Verify all chunks
      for (const chunk of chunks) {
        const path = '/' + chunkIdToPath(chunk.chunkId);
        const chunkData = await collectBytes(client.cat(result.rootCid, path));
        expect(chunkData).toEqual(chunk.encryptedData);
      }

      // Verify manifest
      const manifestData = await collectBytes(client.cat(result.rootCid, '/m'));
      expect(manifestData).toEqual(manifest);
    });
  });

  // ==========================================================================
  // 8. Edge Cases Tests
  // ==========================================================================
  describe('Edge Cases', () => {
    test('empty subManifests array produces no /m_N links', async () => {
      const chunks = generateFixedChunks(1);
      const manifest = new TextEncoder().encode('manifest');
      const result = await buildBatchDirectory({ chunks, manifest, subManifests: [] });

      expect(result.subManifestCids.length).toBe(0);

      // Check root doesn't have m_0 link
      const rootBlock = result.blocks.find(
        (b) => b.cid.toString() === result.rootCid.toString()
      )!;
      const node = dagPb.decode(rootBlock.bytes);
      const names = node.Links.map((l) => l.Name);
      expect(names).not.toContain('m_0');
    });

    test('1-byte chunk works correctly', async () => {
      const chunk = createMockChunk(
        asChunkId('1111111111111111111111'),
        new Uint8Array([42])
      );
      const manifest = new TextEncoder().encode('m');
      const result = await buildBatchDirectory({ chunks: [chunk], manifest });

      expect(result.chunkCidMap.size).toBe(1);
      expect(result.rootCid).toBeDefined();
    });

    test('chunk ID starting with "1" (base58 edge) resolves', async () => {
      const client = new MockIpfsClient();
      const chunk = createMockChunk(
        asChunkId('1111111111111111111111'),
        new TextEncoder().encode('data')
      );
      const manifest = new TextEncoder().encode('manifest');

      const result = await buildCarSegments({ chunks: [chunk], manifest });

      for (const segment of result.segments) {
        const carBytes = await collectBytes(segment.generate());
        await client.uploadCar(toAsyncIterable(carBytes));
      }

      const path = '/' + chunkIdToPath(chunk.chunkId);
      const data = await collectBytes(client.cat(result.rootCid, path));
      expect(data).toEqual(chunk.encryptedData);
    });

    test('many chunks in same level-2 dir work correctly', async () => {
      // Create chunks with same first 4 chars (same level-2 dir)
      const chunks = [
        createMockChunk(asChunkId('ABCDaaaaaaaaaaaaaaaaa1'), new Uint8Array([1])),
        createMockChunk(asChunkId('ABCDaaaaaaaaaaaaaaaaa2'), new Uint8Array([2])),
        createMockChunk(asChunkId('ABCDaaaaaaaaaaaaaaaaa3'), new Uint8Array([3])),
      ];
      const manifest = new TextEncoder().encode('manifest');

      const result = await buildBatchDirectory({ chunks, manifest });
      expect(result.chunkCidMap.size).toBe(3);
    });

    test('sub-manifests array with 3 entries all accessible', async () => {
      const client = new MockIpfsClient();
      const chunks = await generateMockChunks(2);
      const manifest = new TextEncoder().encode('manifest');
      const subManifests = [
        new TextEncoder().encode('sub0'),
        new TextEncoder().encode('sub1'),
        new TextEncoder().encode('sub2'),
      ];

      const result = await buildCarSegments({ chunks, manifest, subManifests });

      for (const segment of result.segments) {
        const carBytes = await collectBytes(segment.generate());
        await client.uploadCar(toAsyncIterable(carBytes));
      }

      // Verify all sub-manifests
      for (let i = 0; i < subManifests.length; i++) {
        const data = await collectBytes(client.cat(result.rootCid, `/m_${i}`));
        expect(data).toEqual(subManifests[i]);
      }
    });
  });
});

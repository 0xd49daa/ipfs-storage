/**
 * CAR file generation for IPFS batch uploads.
 *
 * This module builds UnixFS directory structures and generates CAR files
 * from encrypted chunks. It supports segmented uploads for large batches.
 */

import { CID } from 'multiformats/cid';
import { CarBufferWriter } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import type { ChunkId } from './branded.ts';
import type { EncryptedChunk } from './chunk-encrypt.ts';
import { chunkIdToPath } from './chunk-id.ts';
import { computeRawCid, computeDagPbCid } from './ipfs-client.ts';
import { ValidationError } from './errors.ts';

// ============================================================================
// Constants
// ============================================================================

/** Default number of chunks per non-final segment */
const DEFAULT_SEGMENT_SIZE = 10;

/** Maximum CID size (CIDv1 with sha256) + varint length prefix */
const MAX_CID_OVERHEAD = 50;

/** CAR header size estimate */
const CAR_HEADER_SIZE = 1024;

// ============================================================================
// Public Types
// ============================================================================

/**
 * A single block in the CAR file.
 */
export interface CarBlock {
  cid: CID;
  bytes: Uint8Array;
}

/**
 * Options for building batch directory.
 */
export interface BuildBatchDirectoryOptions {
  /** Encrypted chunks from Phase 7 (must have non-empty encryptedData) */
  chunks: EncryptedChunk[];
  /** Encrypted manifest bytes (required, non-empty) */
  manifest: Uint8Array;
  /** Encrypted sub-manifest bytes (optional) */
  subManifests?: Uint8Array[];
}

/**
 * Result of building the batch directory structure.
 */
export interface BatchDirectoryResult {
  /** Root directory CID (dag-pb codec) */
  rootCid: CID;
  /** All blocks in deterministic write order */
  blocks: CarBlock[];
  /** ChunkId → CID mapping */
  chunkCidMap: Map<ChunkId, CID>;
  /** Manifest /m CID (raw codec) */
  manifestCid: CID;
  /** Sub-manifest /m_N CIDs in order (raw codec) */
  subManifestCids: CID[];
}

/**
 * Options for building CAR segments.
 */
export interface BuildCarSegmentsOptions {
  /** Encrypted chunks from Phase 7 */
  chunks: EncryptedChunk[];
  /** Encrypted manifest bytes */
  manifest: Uint8Array;
  /** Encrypted sub-manifest bytes (optional) */
  subManifests?: Uint8Array[];
  /** Chunks per non-final segment (default: 10, must be > 0) */
  segmentSize?: number;
}

/**
 * Generator for a single CAR segment.
 */
export interface CarSegmentGenerator {
  /** 0-based segment index */
  segmentIndex: number;
  /** Chunk count in this segment */
  chunkCount: number;
  /** ChunkIds included in this segment */
  chunkIds: ChunkId[];
  /** True only for final segment */
  isLast: boolean;
  /** CAR roots: [] for non-final, [rootCid] for final */
  roots: CID[];
  /** Generate CAR bytes (single yield, buffer-based) */
  generate(): AsyncIterable<Uint8Array>;
}

/**
 * Result of building CAR segments.
 */
export interface CarSegmentsResult {
  /** Segment generators in order */
  segments: CarSegmentGenerator[];
  /** Root CID as string (for external APIs) */
  rootCid: string;
  /** ChunkId → CID string mapping (for manifest building) */
  chunkCidMap: Map<ChunkId, string>;
  /** Manifest CID string (for UploadState) */
  manifestCid: string;
  /** Sub-manifest CID strings in order */
  subManifestCids: string[];
  /** Total segment count */
  segmentCount: number;
}

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Internal directory tree node.
 */
interface DirNode {
  /** Child directories by name */
  children: Map<string, DirNode>;
  /** Chunks at this directory level */
  chunks: Array<{ name: string; cid: CID; size: number }>;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Byte-wise string comparator for locale-independent sorting.
 */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build directory tree from chunks grouped by path prefix.
 */
function buildDirectoryTree(
  chunks: Array<{ chunkId: ChunkId; cid: CID; size: number }>
): DirNode {
  const root: DirNode = { children: new Map(), chunks: [] };

  for (const chunk of chunks) {
    // chunkIdToPath: "6Bv7..." -> "6B/v7/6Bv7..."
    const path = chunkIdToPath(chunk.chunkId);
    const parts = path.split('/'); // ["6B", "v7", "6Bv7..."]

    // Navigate/create to level-1 directory
    const level1Name = parts[0]!;
    if (!root.children.has(level1Name)) {
      root.children.set(level1Name, { children: new Map(), chunks: [] });
    }
    const level1 = root.children.get(level1Name)!;

    // Navigate/create to level-2 directory
    const level2Name = parts[1]!;
    if (!level1.children.has(level2Name)) {
      level1.children.set(level2Name, { children: new Map(), chunks: [] });
    }
    const level2 = level1.children.get(level2Name)!;

    // Add chunk to level-2
    level2.chunks.push({
      name: parts[2]!, // Full chunk ID
      cid: chunk.cid,
      size: chunk.size,
    });
  }

  return root;
}

/**
 * Create a dag-pb directory node with sorted links.
 */
async function createDirectoryNode(
  links: Array<{ name: string; cid: CID; tsize: number }>
): Promise<{ bytes: Uint8Array; cid: CID }> {
  // Sort links by name using byte-wise comparison (determinism)
  const sortedLinks = [...links].sort((a, b) => byteCompare(a.name, b.name));

  // Create PBLink array
  const pbLinks = sortedLinks.map((link) => ({
    Name: link.name,
    Hash: link.cid,
    Tsize: link.tsize,
  }));

  // Create dag-pb node with empty Data field
  const node = dagPb.createNode(new Uint8Array(0), pbLinks);
  const bytes = dagPb.encode(node);
  const cid = await computeDagPbCid(bytes);

  return { bytes, cid };
}

/**
 * Build all directory blocks bottom-up.
 * Returns blocks in write order: level-2 dirs -> level-1 dirs -> root
 */
async function buildDirectoryBlocks(
  tree: DirNode,
  manifestCid: CID,
  manifestSize: number,
  subManifestCids: CID[],
  subManifestSizes: number[]
): Promise<{ blocks: CarBlock[]; rootCid: CID }> {
  const blocks: CarBlock[] = [];

  // Collect level-1 names and sort for deterministic processing
  const level1Names = [...tree.children.keys()].sort(byteCompare);
  const level1Links: Array<{ name: string; cid: CID; tsize: number }> = [];

  for (const level1Name of level1Names) {
    const level1Node = tree.children.get(level1Name)!;
    const level2Names = [...level1Node.children.keys()].sort(byteCompare);
    const level2Links: Array<{ name: string; cid: CID; tsize: number }> = [];

    for (const level2Name of level2Names) {
      const level2Node = level1Node.children.get(level2Name)!;

      // Create links for chunks in this level-2 directory
      // Chunks are sorted by name for determinism
      const chunkLinks = level2Node.chunks.map((c) => ({
        name: c.name,
        cid: c.cid,
        tsize: c.size, // Tsize = raw block bytes
      }));

      // Create level-2 directory block
      const { bytes, cid } = await createDirectoryNode(chunkLinks);
      blocks.push({ cid, bytes });

      // Add link for level-1 directory
      level2Links.push({
        name: level2Name,
        cid,
        tsize: bytes.length, // Tsize = directory block bytes
      });
    }

    // Build level-1 directory
    const { bytes: l1Bytes, cid: l1Cid } = await createDirectoryNode(level2Links);
    blocks.push({ cid: l1Cid, bytes: l1Bytes });

    level1Links.push({
      name: level1Name,
      cid: l1Cid,
      tsize: l1Bytes.length,
    });
  }

  // Build root directory (level-1 dirs + manifest + sub-manifests)
  const rootLinks = [...level1Links];

  // Add manifest link
  rootLinks.push({
    name: 'm',
    cid: manifestCid,
    tsize: manifestSize,
  });

  // Add sub-manifest links
  for (let i = 0; i < subManifestCids.length; i++) {
    rootLinks.push({
      name: `m_${i}`,
      cid: subManifestCids[i]!,
      tsize: subManifestSizes[i]!,
    });
  }

  const { bytes: rootBytes, cid: rootCid } = await createDirectoryNode(rootLinks);
  blocks.push({ cid: rootCid, bytes: rootBytes });

  return { blocks, rootCid };
}

/**
 * Create async generator for CAR bytes from blocks.
 */
function createCarGenerator(
  blocks: CarBlock[],
  roots: CID[]
): () => AsyncIterable<Uint8Array> {
  return async function* () {
    // Calculate buffer size with safe margins
    const dataSize = blocks.reduce((sum, b) => sum + b.bytes.length, 0);
    const cidOverhead = blocks.length * MAX_CID_OVERHEAD;
    const bufferSize = dataSize + cidOverhead + CAR_HEADER_SIZE;

    // ArrayBuffer as per existing test pattern
    const buffer = new ArrayBuffer(bufferSize);
    const writer = CarBufferWriter.createWriter(buffer, { roots });

    for (const block of blocks) {
      writer.write(block);
    }

    yield writer.close();
  };
}

// ============================================================================
// Input Validation
// ============================================================================

/**
 * Validate BuildBatchDirectoryOptions.
 */
function validateBuildBatchDirectoryOptions(
  options: BuildBatchDirectoryOptions
): void {
  if (options.chunks.length === 0) {
    throw new ValidationError('Cannot build CAR with zero chunks');
  }
  if (options.manifest.length === 0) {
    throw new ValidationError('Manifest cannot be empty');
  }
  for (const chunk of options.chunks) {
    if (chunk.encryptedData.length === 0) {
      throw new ValidationError(`Chunk ${chunk.chunkId} has empty encryptedData`);
    }
  }
  // Validate sub-manifests if present (zero-length is invalid)
  if (options.subManifests) {
    for (let i = 0; i < options.subManifests.length; i++) {
      if (options.subManifests[i]!.length === 0) {
        throw new ValidationError(`Sub-manifest m_${i} cannot be empty`);
      }
    }
  }
}

/**
 * Validate BuildCarSegmentsOptions.
 */
function validateBuildCarSegmentsOptions(
  options: BuildCarSegmentsOptions
): void {
  validateBuildBatchDirectoryOptions(options);
  if (options.segmentSize !== undefined) {
    if (!Number.isFinite(options.segmentSize) || options.segmentSize <= 0 || !Number.isInteger(options.segmentSize)) {
      throw new ValidationError(
        `segmentSize must be a positive integer, got: ${options.segmentSize}`
      );
    }
  }
}

// ============================================================================
// Public Functions
// ============================================================================

/**
 * Build complete batch directory structure from encrypted chunks.
 *
 * @param options - Chunks, manifest, and optional sub-manifests
 * @returns BatchDirectoryResult with all blocks and metadata
 * @throws {ValidationError} If chunks empty, manifest empty, or chunk has empty encryptedData
 */
export async function buildBatchDirectory(
  options: BuildBatchDirectoryOptions
): Promise<BatchDirectoryResult> {
  validateBuildBatchDirectoryOptions(options);

  const { chunks, manifest, subManifests = [] } = options;

  // 1. Compute CIDs for all chunk blocks (raw codec)
  const chunkCidMap = new Map<ChunkId, CID>();
  const chunkBlocks: CarBlock[] = [];

  for (const chunk of chunks) {
    const cid = await computeRawCid(chunk.encryptedData);
    chunkCidMap.set(chunk.chunkId, cid);
    chunkBlocks.push({ cid, bytes: chunk.encryptedData });
  }

  // 2. Compute CID for manifest (raw codec)
  const manifestCid = await computeRawCid(manifest);

  // 3. Compute CIDs for sub-manifests (raw codec)
  const subManifestCids: CID[] = [];
  for (const subManifest of subManifests) {
    const cid = await computeRawCid(subManifest);
    subManifestCids.push(cid);
  }

  // 4. Build directory tree from chunks
  const tree = buildDirectoryTree(
    chunks.map((c) => ({
      chunkId: c.chunkId,
      cid: chunkCidMap.get(c.chunkId)!,
      size: c.encryptedData.length,
    }))
  );

  // 5. Build directory blocks
  const { blocks: dirBlocks, rootCid } = await buildDirectoryBlocks(
    tree,
    manifestCid,
    manifest.length,
    subManifestCids,
    subManifests.map((s) => s.length)
  );

  // 6. Assemble all blocks in write order:
  //    chunks (input order) -> level-2 dirs -> level-1 dirs -> root -> manifest -> sub-manifests
  const allBlocks: CarBlock[] = [
    ...chunkBlocks,
    ...dirBlocks,
    { cid: manifestCid, bytes: manifest },
    ...subManifests.map((bytes, i) => ({
      cid: subManifestCids[i]!,
      bytes,
    })),
  ];

  return {
    rootCid,
    blocks: allBlocks,
    chunkCidMap,
    manifestCid,
    subManifestCids,
  };
}

/**
 * Build CAR file segments for streaming upload.
 *
 * Segment layout:
 * - Segments 0..N-2: chunks only, roots: []
 * - Segment N-1: remaining chunks + directories + manifest, roots: [rootCid]
 *
 * @param options - Chunks, manifest, sub-manifests, and segment size
 * @returns CarSegmentsResult with generators and metadata
 * @throws {ValidationError} If validation fails or segmentSize is not a positive integer
 */
export async function buildCarSegments(
  options: BuildCarSegmentsOptions
): Promise<CarSegmentsResult> {
  validateBuildCarSegmentsOptions(options);

  const { chunks, manifest, subManifests = [], segmentSize = DEFAULT_SEGMENT_SIZE } = options;

  // Build the full directory structure first
  const dirResult = await buildBatchDirectory({ chunks, manifest, subManifests });

  // Partition chunks into segments
  const chunkCount = chunks.length;
  const fullSegments = Math.floor(chunkCount / segmentSize);
  const remainingChunks = chunkCount % segmentSize;

  // Determine segment count
  // If remainingChunks > 0, we have fullSegments + 1 segments
  // If remainingChunks == 0, the last full segment becomes the final segment
  const segmentCount = remainingChunks > 0 ? fullSegments + 1 : Math.max(1, fullSegments);

  // Find where directory blocks start in the full block list
  // Block order: chunks -> dir blocks -> manifest -> sub-manifests
  const dirBlockStart = chunkCount;
  const dirBlockEnd = dirResult.blocks.length - 1 - subManifests.length; // Exclude manifest and sub-manifests

  const segments: CarSegmentGenerator[] = [];

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
    const isLast = segmentIndex === segmentCount - 1;
    const startIdx = segmentIndex * segmentSize;
    const endIdx = isLast ? chunkCount : Math.min(startIdx + segmentSize, chunkCount);

    const segmentChunks = chunks.slice(startIdx, endIdx);
    const segmentChunkIds = segmentChunks.map((c) => c.chunkId);

    // Get chunk blocks for this segment
    const segmentBlocks: CarBlock[] = dirResult.blocks.slice(startIdx, endIdx);

    // For final segment, add directories and manifest
    if (isLast) {
      // Add directory blocks
      const dirBlocks = dirResult.blocks.slice(dirBlockStart, dirBlockEnd);
      segmentBlocks.push(...dirBlocks);

      // Add manifest
      segmentBlocks.push({
        cid: dirResult.manifestCid,
        bytes: manifest,
      });

      // Add sub-manifests
      for (let i = 0; i < subManifests.length; i++) {
        segmentBlocks.push({
          cid: dirResult.subManifestCids[i]!,
          bytes: subManifests[i]!,
        });
      }
    }

    const roots = isLast ? [dirResult.rootCid] : [];

    segments.push({
      segmentIndex,
      chunkCount: segmentChunks.length,
      chunkIds: segmentChunkIds,
      isLast,
      roots,
      generate: createCarGenerator(segmentBlocks, roots),
    });
  }

  return {
    segments,
    rootCid: dirResult.rootCid.toString(),
    chunkCidMap: new Map(
      [...dirResult.chunkCidMap.entries()].map(([k, v]) => [k, v.toString()])
    ),
    manifestCid: dirResult.manifestCid.toString(),
    subManifestCids: dirResult.subManifestCids.map((c) => c.toString()),
    segmentCount,
  };
}

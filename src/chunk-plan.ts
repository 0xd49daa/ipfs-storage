/**
 * Chunk aggregation engine for IPFS storage.
 *
 * This module implements the core chunking logic that:
 * - Combines small files into shared ~10MB chunks
 * - Splits large files into dedicated 10MB chunks
 * - Tracks offset/length for each file segment within chunks
 * - Applies PADME padding to the final chunk
 */

import type { ChunkId } from './branded.ts';
import type { FileInput } from './types.ts';
import { ChunkEncryption } from './gen/manifest_pb.ts';
import { generateChunkId } from './chunk-id.ts';
import { isValidPath } from './path-utils.ts';
import { ValidationError } from './errors.ts';
import { CHUNK_SIZE, STREAMING_THRESHOLD } from './constants.ts';
import { padme } from './padme.ts';

/**
 * Determine encryption mode based on chunk size.
 * Chunks <= STREAMING_THRESHOLD use single-shot, larger use streaming.
 */
function getEncryptionMode(dataSize: number): ChunkEncryption {
  return dataSize <= STREAMING_THRESHOLD
    ? ChunkEncryption.SINGLE_SHOT
    : ChunkEncryption.STREAMING;
}

/**
 * A segment of a file placed in a chunk.
 * One file may have multiple segments across different chunks.
 */
export interface FileSegment {
  /** Index into original files[] array */
  fileIndex: number;
  /** Byte offset within source file (where to slice) */
  fileOffset: number;
  /** Bytes from source file */
  length: number;
  /** Position within chunk data buffer */
  chunkOffset: number;
}

/**
 * A planned chunk with file segments.
 */
export interface PlannedChunk {
  /** Unique chunk identifier */
  chunkId: ChunkId;
  /** Ordered segments in this chunk */
  segments: FileSegment[];
  /** Unpadded data size (sum of segment lengths) */
  dataSize: number;
  /** PADME-padded (equals dataSize except final chunk) */
  paddedSize: number;
  /** Encryption method (SINGLE_SHOT for all chunks ≤10MB) */
  encryption: ChunkEncryption;
}

/**
 * Reference from file to chunk (without CID - computed in Phase 8).
 */
export interface PlannedChunkRef {
  /** Index into ChunkPlan.chunks[] */
  chunkIndex: number;
  /** Same as PlannedChunk.chunkId */
  chunkId: ChunkId;
  /** Byte offset within decrypted chunk */
  offset: number;
  /** Bytes of this file in this chunk */
  length: number;
  /** Same as PlannedChunk.encryption */
  encryption: ChunkEncryption;
}

/**
 * File entry with chunk references.
 */
export interface PlannedFile {
  /** Index into original files[] array */
  fileIndex: number;
  /** Path after duplicate resolution */
  resolvedPath: string;
  /** file.file.size */
  size: number;
  /** Empty array for size=0 files */
  chunks: PlannedChunkRef[];
}

/**
 * Complete chunk plan for a batch.
 */
export interface ChunkPlan {
  /** All chunks in order */
  chunks: PlannedChunk[];
  /** Aligned with input files[] array */
  files: PlannedFile[];
  /** Sum of all chunk.dataSize */
  totalDataSize: number;
  /** totalDataSize - lastChunk.dataSize + lastChunk.paddedSize */
  totalPaddedSize: number;
}

/**
 * Options for planChunks().
 */
export interface PlanChunksOptions {
  /** Chunk size in bytes (default: CHUNK_SIZE from constants.ts) */
  chunkSize?: number;
}

/**
 * Internal state for building a chunk.
 */
interface ChunkBuilder {
  chunkId: ChunkId;
  segments: FileSegment[];
  dataSize: number;
}

/**
 * Plan how files will be distributed across chunks.
 *
 * Small files (< chunkSize) are aggregated into shared chunks.
 * Large files (>= chunkSize) get dedicated chunks of exactly chunkSize.
 * PADME padding is applied to the final chunk only.
 *
 * **Ordering:** Files are processed in input array order. This ensures:
 * - Same input array produces identical chunk structure
 * - Caller controls ordering (sort before calling if needed)
 * - No hidden sorting that could change behavior
 *
 * If you need deterministic ordering regardless of input order,
 * sort the files array (e.g., by path) before calling this function.
 *
 * @param files - Input files array
 * @param resolvedPaths - Resolved paths (from resolveConflicts), aligned with files
 * @param options - Optional configuration
 * @returns Chunk plan describing file-to-chunk mappings
 *
 * @throws {ValidationError} If files.length !== resolvedPaths.length
 * @throws {ValidationError} If any resolvedPath is invalid
 * @throws {ValidationError} If chunkSize is <= 0
 */
export async function planChunks(
  files: FileInput[],
  resolvedPaths: string[],
  options?: PlanChunksOptions
): Promise<ChunkPlan> {
  // Validate inputs
  if (files.length !== resolvedPaths.length) {
    throw new ValidationError(
      `files.length (${files.length}) !== resolvedPaths.length (${resolvedPaths.length})`
    );
  }

  for (let i = 0; i < resolvedPaths.length; i++) {
    const path = resolvedPaths[i]!;
    if (!isValidPath(path)) {
      throw new ValidationError(`Invalid path at index ${i}: "${path}"`);
    }
  }

  const chunkSize = options?.chunkSize ?? CHUNK_SIZE;

  // Validate chunkSize
  if (chunkSize <= 0) {
    throw new ValidationError(`chunkSize must be positive, got ${chunkSize}`);
  }

  // Track all planned chunks
  const plannedChunks: PlannedChunk[] = [];

  // Track planned files (aligned with input)
  const plannedFiles: PlannedFile[] = [];

  // Current aggregation chunk (for small files)
  let currentChunk: ChunkBuilder | null = null;

  // Helper to finalize current aggregation chunk
  const finalizeCurrentChunk = () => {
    if (currentChunk !== null) {
      const encryption = getEncryptionMode(currentChunk.dataSize);
      plannedChunks.push({
        chunkId: currentChunk.chunkId,
        segments: currentChunk.segments,
        dataSize: currentChunk.dataSize,
        paddedSize: currentChunk.dataSize, // Will be updated for final chunk
        encryption,
      });
      currentChunk = null;
    }
  };

  // Process each file
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const resolvedPath = resolvedPaths[i]!;
    const fileSize = file.file.size;

    // Initialize planned file
    const plannedFile: PlannedFile = {
      fileIndex: i,
      resolvedPath,
      size: fileSize,
      chunks: [],
    };

    if (fileSize === 0) {
      // Empty file: no chunks, just manifest entry
      plannedFiles.push(plannedFile);
      continue;
    }

    if (fileSize >= chunkSize) {
      // Large file: close any open aggregation chunk, then split into dedicated chunks
      finalizeCurrentChunk();

      let fileOffset = 0;
      while (fileOffset < fileSize) {
        const remainingInFile = fileSize - fileOffset;
        const segmentSize = Math.min(chunkSize, remainingInFile);

        const chunkId = await generateChunkId();
        const chunkIndex = plannedChunks.length;
        const encryption = getEncryptionMode(segmentSize);

        // Create dedicated chunk with single segment
        plannedChunks.push({
          chunkId,
          segments: [
            {
              fileIndex: i,
              fileOffset,
              length: segmentSize,
              chunkOffset: 0,
            },
          ],
          dataSize: segmentSize,
          paddedSize: segmentSize, // Will be updated for final chunk
          encryption,
        });

        // Add chunk reference to file
        plannedFile.chunks.push({
          chunkIndex,
          chunkId,
          offset: 0,
          length: segmentSize,
          encryption,
        });

        fileOffset += segmentSize;
      }
    } else {
      // Small file: aggregate into shared chunks
      let fileOffset = 0;

      while (fileOffset < fileSize) {
        // Create new aggregation chunk if needed
        if (currentChunk === null) {
          currentChunk = {
            chunkId: await generateChunkId(),
            segments: [],
            dataSize: 0,
          };
        }

        const remainingInFile = fileSize - fileOffset;
        const spaceInChunk = chunkSize - currentChunk.dataSize;
        const segmentSize = Math.min(spaceInChunk, remainingInFile);

        // Add segment to current chunk
        const segment: FileSegment = {
          fileIndex: i,
          fileOffset,
          length: segmentSize,
          chunkOffset: currentChunk.dataSize,
        };
        currentChunk.segments.push(segment);

        // Add chunk reference to file
        // Note: chunkIndex is plannedChunks.length (index when this chunk gets pushed)
        // Use chunkSize for encryption mode since that's the max possible aggregation chunk size
        plannedFile.chunks.push({
          chunkIndex: plannedChunks.length,
          chunkId: currentChunk.chunkId,
          offset: currentChunk.dataSize,
          length: segmentSize,
          encryption: getEncryptionMode(chunkSize),
        });

        currentChunk.dataSize += segmentSize;
        fileOffset += segmentSize;

        // If chunk is full, finalize it
        if (currentChunk.dataSize >= chunkSize) {
          finalizeCurrentChunk();
        }
      }
    }

    plannedFiles.push(plannedFile);
  }

  // Finalize any remaining open chunk
  finalizeCurrentChunk();

  // Post-process: ensure chunk ref encryption matches chunk encryption
  // This handles cases where aggregation chunks don't fill completely
  for (const file of plannedFiles) {
    for (const ref of file.chunks) {
      const chunk = plannedChunks[ref.chunkIndex];
      if (chunk) {
        ref.encryption = chunk.encryption;
      }
    }
  }

  // Calculate totals
  let totalDataSize = 0;
  for (const chunk of plannedChunks) {
    totalDataSize += chunk.dataSize;
  }

  // Apply PADME to final chunk only
  let totalPaddedSize = totalDataSize;
  if (plannedChunks.length > 0) {
    const lastChunk = plannedChunks[plannedChunks.length - 1]!;
    lastChunk.paddedSize = padme(lastChunk.dataSize);
    totalPaddedSize = totalDataSize - lastChunk.dataSize + lastChunk.paddedSize;
  }

  return {
    chunks: plannedChunks,
    files: plannedFiles,
    totalDataSize,
    totalPaddedSize,
  };
}

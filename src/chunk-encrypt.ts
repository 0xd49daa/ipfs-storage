/**
 * Chunk encryption pipeline for IPFS storage.
 *
 * This module implements per-segment encryption:
 * - Each file segment within a chunk is encrypted with its file-derived key
 * - Chunk = concatenation of encrypted segments
 * - Manifest offsets refer to ciphertext positions within chunk
 */

import type { SymmetricKey, ContentHash, Nonce } from '@0xd49daa/safecrypt';
import {
  encrypt,
  decrypt,
  createEncryptStream,
  createDecryptStream,
} from '@0xd49daa/safecrypt';
import type { ChunkId } from './branded.ts';
import type { PlannedChunk, FileSegment, ChunkPlan } from './chunk-plan.ts';
import type { FileInput } from './types.ts';
import { ChunkEncryption } from './gen/manifest_pb.ts';
import { deriveFileKey } from './crypto.ts';
import { ValidationError } from './errors.ts';
import {
  NONCE_SIZE,
  SINGLE_SHOT_OVERHEAD,
  STREAM_HEADER_SIZE,
  STREAM_CHUNK_OVERHEAD,
  STREAM_CHUNK_SIZE,
} from './constants.ts';

// ============================================================================
// Types
// ============================================================================

/**
 * Encrypted segment metadata for manifest generation.
 */
export interface EncryptedSegmentInfo {
  /** Index of source file in files[] array */
  fileIndex: number;
  /** Byte offset of encrypted data within chunk (ciphertext position) */
  encryptedOffset: number;
  /** Original plaintext length (stored in manifest ChunkRef.length) */
  plaintextLength: number;
  /** Actual encrypted length in bytes (includes any PADME padding overhead) */
  encryptedLength: number;
}

/**
 * Result of encrypting a single chunk.
 */
export interface EncryptedChunk {
  /** Chunk identifier */
  chunkId: ChunkId;
  /** Concatenated encrypted segments */
  encryptedData: Uint8Array;
  /** Encryption mode (from chunk.encryption) */
  encryption: ChunkEncryption;
  /** Segment metadata for manifest ChunkRef generation */
  segments: EncryptedSegmentInfo[];
  /** Original total plaintext size (sum of segment plaintextLengths) */
  dataSize: number;
  /** Total encrypted size (encryptedData.length) */
  encryptedSize: number;
}

/**
 * Options for chunk encryption.
 */
export interface EncryptChunkOptions {
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  // NOTE: streamChunkSize is intentionally NOT configurable.
  // It's locked to STREAM_CHUNK_SIZE (64KB) so download can compute encrypted lengths.
}

/**
 * Provider for reading file data during encryption.
 */
export interface FileDataProvider {
  /**
   * Read bytes from file at given index.
   * @throws ValidationError if fileIndex out of bounds
   * @throws ValidationError if offset+length exceeds file size
   */
  readSegment(fileIndex: number, offset: number, length: number): Promise<Uint8Array>;
  /** Get content hash for file at index (for key derivation) */
  getContentHash(fileIndex: number): ContentHash;
  /** Get file size for bounds checking */
  getFileSize(fileIndex: number): number;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if abort signal is triggered and throw if so.
 */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Encryption aborted', 'AbortError');
  }
}

/**
 * Compute encrypted length from plaintext length.
 *
 * @deprecated For segment extraction, use `segment.encryptedLength` instead.
 * This function computes the expected encrypted size for UNPADDED plaintext.
 * For PADME-padded segments (last segment of final chunk), this returns
 * the wrong value - it doesn't account for padding bytes.
 *
 * Safe to use for:
 * - Sanity checks on non-final segments
 * - Estimating encrypted sizes before encryption
 *
 * NOT safe for:
 * - Extracting segment data from encrypted chunks (use encryptedLength field)
 * - Final chunk's last segment (has PADME padding)
 */
export function computeEncryptedLength(
  plaintextLength: number,
  encryption: ChunkEncryption
): number {
  if (encryption === ChunkEncryption.SINGLE_SHOT) {
    return plaintextLength + SINGLE_SHOT_OVERHEAD;
  } else {
    // STREAMING: header + (numChunks * overhead)
    // Uses locked STREAM_CHUNK_SIZE constant - not configurable
    const numChunks = Math.ceil(plaintextLength / STREAM_CHUNK_SIZE);
    return plaintextLength + STREAM_HEADER_SIZE + numChunks * STREAM_CHUNK_OVERHEAD;
  }
}

// ============================================================================
// File Data Provider
// ============================================================================

/**
 * Create FileDataProvider from FileInput array with bounds checking.
 */
export function createFileDataProvider(files: FileInput[]): FileDataProvider {
  return {
    async readSegment(
      fileIndex: number,
      offset: number,
      length: number
    ): Promise<Uint8Array> {
      if (fileIndex < 0 || fileIndex >= files.length) {
        throw new ValidationError(
          `Invalid file index: ${fileIndex}, valid range: 0-${files.length - 1}`
        );
      }

      const file = files[fileIndex]!;
      const fileSize = file.file.size;

      if (offset < 0 || length < 0) {
        throw new ValidationError(
          `Invalid offset/length: offset=${offset}, length=${length}`
        );
      }

      if (offset + length > fileSize) {
        throw new ValidationError(
          `Read exceeds file bounds: offset=${offset}, length=${length}, fileSize=${fileSize}`
        );
      }

      const blob = file.file.slice(offset, offset + length);
      const buffer = await blob.arrayBuffer();
      return new Uint8Array(buffer);
    },

    getContentHash(fileIndex: number): ContentHash {
      if (fileIndex < 0 || fileIndex >= files.length) {
        throw new ValidationError(`Invalid file index: ${fileIndex}`);
      }
      return files[fileIndex]!.contentHash;
    },

    getFileSize(fileIndex: number): number {
      if (fileIndex < 0 || fileIndex >= files.length) {
        throw new ValidationError(`Invalid file index: ${fileIndex}`);
      }
      return files[fileIndex]!.file.size;
    },
  };
}

// ============================================================================
// Encryption Functions
// ============================================================================

/**
 * Encrypt segment using single-shot mode.
 * Returns wire format: [24-byte nonce][ciphertext with 16-byte tag]
 */
async function encryptSingleShot(
  plaintext: Uint8Array,
  key: SymmetricKey
): Promise<Uint8Array> {
  const { nonce, ciphertext } = await encrypt(plaintext, key);

  // Wire format: [nonce][ciphertext]
  const result = new Uint8Array(NONCE_SIZE + ciphertext.length);
  result.set(nonce, 0);
  result.set(ciphertext, NONCE_SIZE);

  return result;
}

/**
 * Decrypt segment using single-shot mode.
 * Expects wire format: [24-byte nonce][ciphertext with 16-byte tag]
 */
export async function decryptSingleShot(
  encryptedData: Uint8Array,
  key: SymmetricKey
): Promise<Uint8Array> {
  const nonce = encryptedData.subarray(0, NONCE_SIZE) as Nonce;
  const ciphertext = encryptedData.subarray(NONCE_SIZE);
  return decrypt(ciphertext, nonce, key);
}

/**
 * Encrypt segment using streaming mode.
 * Returns wire format: [24-byte header][encrypted_chunks...]
 */
async function encryptStreaming(
  plaintext: Uint8Array,
  key: SymmetricKey,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const stream = await createEncryptStream(key);

  try {
    // Calculate output size
    const numChunks = Math.ceil(plaintext.length / STREAM_CHUNK_SIZE);
    const outputSize =
      STREAM_HEADER_SIZE + plaintext.length + numChunks * STREAM_CHUNK_OVERHEAD;

    const result = new Uint8Array(outputSize);
    let writeOffset = 0;

    // Write header
    result.set(stream.header, 0);
    writeOffset = STREAM_HEADER_SIZE;

    // Process in chunks
    let readOffset = 0;
    while (readOffset < plaintext.length) {
      // Check abort inside loop for large segments
      checkAbort(signal);

      const remaining = plaintext.length - readOffset;
      const chunkLen = Math.min(STREAM_CHUNK_SIZE, remaining);
      const isFinal = readOffset + chunkLen >= plaintext.length;

      const chunk = plaintext.subarray(readOffset, readOffset + chunkLen);
      const encrypted = stream.push(chunk, isFinal);

      result.set(encrypted, writeOffset);
      writeOffset += encrypted.length;
      readOffset += chunkLen;
    }

    return result.subarray(0, writeOffset);
  } finally {
    stream.dispose();
  }
}

/**
 * Decrypt segment using streaming mode.
 * Expects wire format: [24-byte header][encrypted_chunks...]
 *
 * IMPORTANT: This function assumes encrypted chunks were created with
 * STREAM_CHUNK_SIZE (64KB) as the plaintext chunk size. This is safe because:
 * 1. STREAM_CHUNK_SIZE is a locked constant (not configurable)
 * 2. encryptStreaming() always uses STREAM_CHUNK_SIZE
 * 3. Both encrypt and decrypt use the same constant
 *
 * The secretstream format requires feeding exact encrypted chunk boundaries
 * to pull(), so we must know the chunk size used during encryption.
 */
export async function decryptStreaming(
  encryptedData: Uint8Array,
  key: SymmetricKey
): Promise<Uint8Array> {
  const header = encryptedData.subarray(0, STREAM_HEADER_SIZE);
  const stream = await createDecryptStream(
    key,
    header as unknown as import('@0xd49daa/safecrypt').SecretstreamHeader
  );

  try {
    const encryptedBody = encryptedData.subarray(STREAM_HEADER_SIZE);
    const chunks: Uint8Array[] = [];

    let readOffset = 0;
    while (readOffset < encryptedBody.length) {
      // Each encrypted chunk = STREAM_CHUNK_SIZE plaintext + 17 bytes overhead
      // (except final chunk which may be smaller)
      const chunkSize = STREAM_CHUNK_SIZE + STREAM_CHUNK_OVERHEAD;
      const remaining = encryptedBody.length - readOffset;
      const encChunkLen = Math.min(chunkSize, remaining);

      const encChunk = encryptedBody.subarray(readOffset, readOffset + encChunkLen);
      const { plaintext, isFinal } = stream.pull(encChunk);
      chunks.push(plaintext);

      readOffset += encChunkLen;
      if (isFinal) break;
    }

    stream.finalize();

    // Concatenate plaintext chunks
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  } finally {
    stream.dispose();
  }
}

/**
 * Encrypt a single file segment with its derived key.
 */
async function encryptSegmentData(
  plaintext: Uint8Array,
  manifestKey: SymmetricKey,
  contentHash: ContentHash,
  encryption: ChunkEncryption,
  signal?: AbortSignal
): Promise<Uint8Array> {
  // Derive file key from manifest key and content hash
  const fileKey = await deriveFileKey(manifestKey, contentHash);

  if (encryption === ChunkEncryption.SINGLE_SHOT) {
    return encryptSingleShot(plaintext, fileKey);
  } else {
    return encryptStreaming(plaintext, fileKey, signal);
  }
}

// ============================================================================
// Main Encryption Functions
// ============================================================================

/**
 * Encrypt a single planned chunk using per-segment encryption.
 * Each segment is encrypted with deriveFileKey(manifestKey, contentHash).
 * All segments use chunk.encryption mode.
 *
 * @param chunk - Planned chunk from planChunks()
 * @param fileProvider - Provider for reading file segment data
 * @param manifestKey - Encryption key for the batch
 * @param isFinalChunk - Whether this is the final chunk (applies PADME padding)
 * @param options - Optional configuration (AbortSignal)
 * @returns Encrypted chunk with metadata
 */
export async function encryptChunk(
  chunk: PlannedChunk,
  fileProvider: FileDataProvider,
  manifestKey: SymmetricKey,
  isFinalChunk: boolean,
  options?: EncryptChunkOptions
): Promise<EncryptedChunk> {
  // Checkpoint 1: Before starting chunk processing
  checkAbort(options?.signal);

  // Validate invariant: paddedSize >= dataSize
  if (chunk.paddedSize < chunk.dataSize) {
    throw new ValidationError(
      `paddedSize (${chunk.paddedSize}) < dataSize (${chunk.dataSize}): bad plan`
    );
  }

  // Calculate padding for final chunk
  const paddingNeeded = isFinalChunk ? chunk.paddedSize - chunk.dataSize : 0;

  // Track encrypted segments
  const encryptedParts: Uint8Array[] = [];
  const segmentInfos: EncryptedSegmentInfo[] = [];
  let encryptedOffset = 0;
  let totalPlaintextSize = 0;

  // Process each segment
  for (let segmentIndex = 0; segmentIndex < chunk.segments.length; segmentIndex++) {
    const segment = chunk.segments[segmentIndex]!;

    // Checkpoint 2: Before each segment file read
    checkAbort(options?.signal);

    // Read plaintext from file
    let plaintext = await fileProvider.readSegment(
      segment.fileIndex,
      segment.fileOffset,
      segment.length
    );

    // Original plaintext length (before any padding)
    const originalPlaintextLength = plaintext.length;
    totalPlaintextSize += originalPlaintextLength;

    // Apply PADME padding with explicit guard
    const isLastSegment = segmentIndex === chunk.segments.length - 1;
    if (isFinalChunk && isLastSegment && paddingNeeded > 0) {
      // Expand plaintext with zero padding
      const padded = new Uint8Array(plaintext.length + paddingNeeded);
      padded.set(plaintext, 0);
      // Rest is already zeros
      plaintext = padded;
    }

    // Checkpoint 3: Before each segment encryption
    checkAbort(options?.signal);

    // Get content hash for key derivation
    const contentHash = fileProvider.getContentHash(segment.fileIndex);

    // Encrypt segment with file-derived key
    const encryptedSegment = await encryptSegmentData(
      plaintext,
      manifestKey,
      contentHash,
      chunk.encryption,
      options?.signal
    );

    // Record segment info (encryptedLength is actual size, which may include PADME padding)
    segmentInfos.push({
      fileIndex: segment.fileIndex,
      encryptedOffset,
      plaintextLength: originalPlaintextLength,
      encryptedLength: encryptedSegment.length,
    });

    encryptedParts.push(encryptedSegment);
    encryptedOffset += encryptedSegment.length;
  }

  // Checkpoint 4: Before final assembly
  checkAbort(options?.signal);

  // Concatenate all encrypted segments
  const totalEncryptedSize = encryptedParts.reduce((sum, p) => sum + p.length, 0);
  const encryptedData = new Uint8Array(totalEncryptedSize);
  let writeOffset = 0;
  for (const part of encryptedParts) {
    encryptedData.set(part, writeOffset);
    writeOffset += part.length;
  }

  return {
    chunkId: chunk.chunkId,
    encryptedData,
    encryption: chunk.encryption,
    segments: segmentInfos,
    dataSize: totalPlaintextSize,
    encryptedSize: totalEncryptedSize,
  };
}

/**
 * Encrypt all chunks in a plan.
 * Processes sequentially for memory efficiency.
 *
 * @param plan - Complete chunk plan from planChunks()
 * @param files - Original file inputs (for reading data)
 * @param manifestKey - Encryption key for the batch
 * @param options - Optional configuration (AbortSignal)
 * @yields Encrypted chunks in order
 */
export async function* encryptChunks(
  plan: ChunkPlan,
  files: FileInput[],
  manifestKey: SymmetricKey,
  options?: EncryptChunkOptions
): AsyncGenerator<EncryptedChunk> {
  const fileProvider = createFileDataProvider(files);
  const lastIndex = plan.chunks.length - 1;

  for (let i = 0; i < plan.chunks.length; i++) {
    const chunk = plan.chunks[i]!;
    const isFinalChunk = i === lastIndex;

    const encrypted = await encryptChunk(
      chunk,
      fileProvider,
      manifestKey,
      isFinalChunk,
      options
    );

    yield encrypted;
  }
}

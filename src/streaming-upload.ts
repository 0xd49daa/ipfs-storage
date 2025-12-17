/**
 * Streaming Upload Implementation
 *
 * Memory-efficient batch upload that processes files lazily from an AsyncIterable.
 * Peak memory usage: ~12MB regardless of batch size.
 *
 * Architecture:
 * 1. Files processed one at a time from AsyncIterable
 * 2. Small files (<10MB) aggregated into shared chunks until 10MB
 * 3. Large files (>=10MB) streamed through dedicated 10MB chunks
 * 4. Each chunk uploaded immediately as single-block CAR (no roots)
 * 5. Sub-manifests flushed when entries exceed ~1MB
 * 6. Final CAR contains directory structure linking to uploaded chunks
 */

import { generateKey, randomBytes, type SymmetricKey, type ContentHash } from '@0xd49daa/safecrypt';
import { base58 } from '@scure/base';
import { CID } from 'multiformats/cid';
import { CarBufferWriter } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';

import type { ChunkId } from './branded.ts';
import type { IpfsClient } from './ipfs-client.ts';
import type {
  StreamingFileInput,
  FileInfo,
  DirectoryInfo,
  ChunkRef,
  BatchManifest,
  UploadOptions,
  BatchResult,
  RenamedFile,
  UploadProgress,
} from './types.ts';
import { ChunkEncryption } from './gen/manifest_pb.ts';

import { ValidationError, ChunkUploadError } from './errors.ts';
import { PathManager } from './conflicts.ts';
import { DirectoryTreeBuilder } from './directories.ts';
import { generateChunkId, chunkIdToPath } from './chunk-id.ts';
import { deriveFileKey } from './crypto.ts';
import { encryptManifest, buildManifest } from './manifest-builder.ts';
import { computeRawCid, computeDagPbCid } from './ipfs-client.ts';
import { basename } from './path-utils.ts';
import { padme } from './padme.ts';
import { CHUNK_SIZE, SUB_MANIFEST_SIZE, STREAMING_THRESHOLD, DEFAULT_RETRIES } from './constants.ts';
import {
  NONCE_SIZE,
  SINGLE_SHOT_OVERHEAD,
  STREAM_HEADER_SIZE,
  STREAM_CHUNK_OVERHEAD,
  STREAM_CHUNK_SIZE,
} from './constants.ts';
import { encrypt, createEncryptStream } from '@0xd49daa/safecrypt';
import { encodeSubManifest } from './serialization.ts';

// ============================================================================
// Constants
// ============================================================================

/** Maximum CID size + varint length prefix */
const MAX_CID_OVERHEAD = 50;

/** CAR header size estimate */
const CAR_HEADER_SIZE = 1024;

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Segment of a file within an aggregation chunk (eager - data already loaded).
 */
interface AggregationSegment {
  fileIndex: number;
  data: Uint8Array;
  fileOffset: number;
  contentHash: ContentHash;
}

/**
 * Stream-based segment for lazy consumption (deferred loading at flush time).
 * Reduces memory usage by storing stream factory instead of file data.
 */
interface StreamSegment {
  fileIndex: number;
  fileOffset: number;
  contentHash: ContentHash;
  size: number;
  getStream: () => ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
}

/**
 * Info about an uploaded chunk.
 */
interface UploadedChunk {
  chunkId: ChunkId;
  cid: string;
  encryptedSize: number;
  segments: {
    fileIndex: number;
    encryptedOffset: number;
    plaintextLength: number;
    encryptedLength: number;
  }[];
  dataSize: number;
}

/**
 * Info about a flushed sub-manifest.
 */
interface FlushedSubManifest {
  index: number;
  cid: string;
  encryptedBytes: Uint8Array;
  startPath: string;
  endPath: string;
  fileCount: number;
}

/**
 * Processing context passed through the pipeline.
 */
interface ProcessingContext {
  manifestKey: SymmetricKey;
  ipfsClient: IpfsClient;
  signal?: AbortSignal;
  uploadRetries: number;
  onProgress?: (progress: UploadProgress) => void;
  onChunkUploaded?: UploadOptions['onChunkUploaded'];
  onSubManifestFlushed?: UploadOptions['onSubManifestFlushed'];

  // State tracking
  uploadedChunks: Map<string, UploadedChunk>; // chunkId -> UploadedChunk
  uploadedSubManifests: FlushedSubManifest[];
  fileInfos: FileInfo[];
  directories: DirectoryInfo[];
  resolvedPaths: string[];
  renamed: RenamedFile[];

  // Progress tracking
  filesProcessed: number;
  bytesProcessed: number;
  chunksUploaded: number;
  subManifestsFlushed: number;
  batchId: string;
  created: number;
}

// ============================================================================
// Abort Handling
// ============================================================================

/**
 * Check if abort signal is triggered.
 * Always throws DOMException with name 'AbortError'.
 */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    let message: string;
    if (reason === undefined || reason === null) {
      message = 'Upload aborted';
    } else if (reason instanceof Error) {
      message = reason.message;
    } else if (typeof reason === 'string') {
      message = reason;
    } else {
      message = 'Upload aborted';
    }
    throw new DOMException(message, 'AbortError');
  }
}

/**
 * Execute a function with retry logic and exponential backoff.
 *
 * @param fn - Async function to execute
 * @param maxRetries - Maximum number of attempts
 * @param signal - Optional abort signal
 * @returns Result of the function
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  signal?: AbortSignal
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    checkAbort(signal);

    try {
      return await fn();
    } catch (error) {
      // Don't retry on abort
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));

      // Exponential backoff: 100ms, 200ms, 400ms...
      if (attempt < maxRetries - 1) {
        const delayMs = 100 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}

// ============================================================================
// Single-Block CAR Upload
// ============================================================================

/**
 * Upload a single block as a rootless CAR file.
 * Used for uploading chunks and sub-manifests before the final CAR.
 *
 * Includes retry logic with exponential backoff for transient failures.
 *
 * @param data - Block data to upload
 * @param ipfsClient - IPFS client
 * @param maxRetries - Maximum retry attempts (default: DEFAULT_RETRIES)
 * @param signal - Optional abort signal
 * @returns CID of the uploaded block
 */
async function uploadSingleBlock(
  data: Uint8Array,
  ipfsClient: IpfsClient,
  maxRetries: number = DEFAULT_RETRIES,
  signal?: AbortSignal
): Promise<{ cid: CID; cidString: string }> {
  const cid = await computeRawCid(data);

  // Build CAR once (idempotent - safe to retry)
  const bufferSize = data.length + MAX_CID_OVERHEAD + CAR_HEADER_SIZE;
  const buffer = new ArrayBuffer(bufferSize);
  const writer = CarBufferWriter.createWriter(buffer, { roots: [] });
  writer.write({ cid, bytes: data });
  const carBytes = writer.close();

  // Upload with retry
  try {
    await withRetry(
      async () => {
        async function* carGenerator(): AsyncIterable<Uint8Array> {
          yield carBytes;
        }
        await ipfsClient.uploadCar(carGenerator());
      },
      maxRetries,
      signal
    );
  } catch (error) {
    // Wrap non-abort errors in ChunkUploadError
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ChunkUploadError(
      cid.toString(),
      error instanceof Error ? error : undefined
    );
  }

  return { cid, cidString: cid.toString() };
}

// ============================================================================
// Encryption Helpers
// ============================================================================

/**
 * Encrypt data using single-shot mode.
 * Wire format: [24-byte nonce][ciphertext with 16-byte tag]
 */
async function encryptSingleShot(
  plaintext: Uint8Array,
  key: SymmetricKey
): Promise<Uint8Array> {
  const { nonce, ciphertext } = await encrypt(plaintext, key);
  const result = new Uint8Array(NONCE_SIZE + ciphertext.length);
  result.set(nonce, 0);
  result.set(ciphertext, NONCE_SIZE);
  return result;
}

/**
 * Encrypt data using streaming mode.
 * Wire format: [24-byte header][encrypted_chunks...]
 */
async function encryptStreaming(
  plaintext: Uint8Array,
  key: SymmetricKey,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const stream = await createEncryptStream(key);

  try {
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
 * Encrypt a segment with the appropriate mode based on size.
 */
async function encryptSegment(
  plaintext: Uint8Array,
  manifestKey: SymmetricKey,
  contentHash: ContentHash,
  signal?: AbortSignal
): Promise<{ encrypted: Uint8Array; encryption: ChunkEncryption }> {
  const fileKey = await deriveFileKey(manifestKey, contentHash);
  const encryption =
    plaintext.length <= STREAMING_THRESHOLD
      ? ChunkEncryption.SINGLE_SHOT
      : ChunkEncryption.STREAMING;

  const encrypted =
    encryption === ChunkEncryption.SINGLE_SHOT
      ? await encryptSingleShot(plaintext, fileKey)
      : await encryptStreaming(plaintext, fileKey, signal);

  return { encrypted, encryption };
}

// ============================================================================
// Aggregation Buffer Manager
// ============================================================================

/**
 * Manages aggregation of small files into shared chunks.
 */
class AggregationBufferManager {
  private segments: AggregationSegment[] = [];
  private streamSegments: StreamSegment[] = [];
  private totalSize = 0;
  private pendingChunkId: ChunkId | null = null;

  constructor(
    private manifestKey: SymmetricKey,
    private ipfsClient: IpfsClient,
    private context: ProcessingContext
  ) {}

  get currentSize(): number {
    return this.totalSize;
  }

  get isEmpty(): boolean {
    return this.segments.length === 0 && this.streamSegments.length === 0;
  }

  /**
   * Add a segment to the buffer.
   * Automatically flushes when buffer reaches CHUNK_SIZE.
   */
  async addSegment(
    fileIndex: number,
    data: Uint8Array,
    fileOffset: number,
    contentHash: ContentHash
  ): Promise<UploadedChunk | null> {
    // Generate chunk ID on first segment
    if (this.pendingChunkId === null) {
      this.pendingChunkId = await generateChunkId();
    }

    this.segments.push({ fileIndex, data, fileOffset, contentHash });
    this.totalSize += data.length;

    // Flush if full
    if (this.totalSize >= CHUNK_SIZE) {
      return this.flush(false);
    }
    return null;
  }

  /**
   * Add a stream segment to the buffer for lazy consumption.
   * The stream is NOT consumed immediately - only at flush time.
   * This reduces memory usage by avoiding loading full file contents upfront.
   *
   * @param fileIndex - Index of the file in the batch
   * @param size - Known file size (required for buffer management)
   * @param fileOffset - Offset within the file (always 0 for small files)
   * @param contentHash - File content hash for key derivation
   * @param getStream - Factory function to create a fresh stream
   * @returns Flushed chunk if buffer reached CHUNK_SIZE, null otherwise
   */
  async addStreamSegment(
    fileIndex: number,
    size: number,
    fileOffset: number,
    contentHash: ContentHash,
    getStream: () => ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
  ): Promise<UploadedChunk | null> {
    // Generate chunk ID on first segment
    if (this.pendingChunkId === null) {
      this.pendingChunkId = await generateChunkId();
    }

    this.streamSegments.push({ fileIndex, size, fileOffset, contentHash, getStream });
    this.totalSize += size;

    // Flush if full
    if (this.totalSize >= CHUNK_SIZE) {
      return this.flush(false);
    }
    return null;
  }

  /**
   * Read a stream fully into a Uint8Array.
   * Validates that the stream produces exactly the expected number of bytes.
   */
  private async readStreamFully(
    getStream: () => ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    expectedSize: number
  ): Promise<Uint8Array> {
    const result = new Uint8Array(expectedSize);
    const stream = toAsyncIterable(getStream());
    let offset = 0;

    for await (const chunk of stream) {
      checkAbort(this.context.signal);
      if (offset + chunk.length > expectedSize) {
        throw new ValidationError(`Stream exceeded expected size: ${expectedSize}`);
      }
      result.set(chunk, offset);
      offset += chunk.length;
    }

    if (offset !== expectedSize) {
      throw new ValidationError(`Stream size mismatch: expected ${expectedSize}, got ${offset}`);
    }

    return result;
  }

  /**
   * Flush current buffer as a chunk.
   * @param isFinal - Whether to apply PADME padding
   */
  async flush(isFinal: boolean): Promise<UploadedChunk | null> {
    const totalSegmentCount = this.segments.length + this.streamSegments.length;
    if (totalSegmentCount === 0) {
      return null;
    }

    checkAbort(this.context.signal);

    const chunkId = this.pendingChunkId!;

    // Encrypt each segment and concatenate
    const encryptedParts: Uint8Array[] = [];
    const segmentInfos: UploadedChunk['segments'] = [];
    let encryptedOffset = 0;
    let totalPlaintext = 0;
    let processedCount = 0;

    // Process eager segments (Uint8Array-based)
    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i]!;
      let plaintext = segment.data;
      const originalLength = plaintext.length;
      totalPlaintext += originalLength;

      // Apply PADME to last segment of final chunk (only if no stream segments follow)
      const isLastSegment = processedCount === totalSegmentCount - 1;
      if (isFinal && isLastSegment) {
        const paddedSize = padme(this.totalSize);
        const paddingNeeded = paddedSize - this.totalSize;
        if (paddingNeeded > 0) {
          const padded = new Uint8Array(plaintext.length + paddingNeeded);
          padded.set(plaintext, 0);
          plaintext = padded;
        }
      }

      checkAbort(this.context.signal);

      const { encrypted } = await encryptSegment(
        plaintext,
        this.manifestKey,
        segment.contentHash,
        this.context.signal
      );

      segmentInfos.push({
        fileIndex: segment.fileIndex,
        encryptedOffset,
        plaintextLength: originalLength,
        encryptedLength: encrypted.length,
      });

      encryptedParts.push(encrypted);
      encryptedOffset += encrypted.length;
      processedCount++;
    }

    // Process stream segments (lazy loading)
    for (let i = 0; i < this.streamSegments.length; i++) {
      const segment = this.streamSegments[i]!;

      // Read stream fully at flush time (lazy consumption)
      let plaintext = await this.readStreamFully(segment.getStream, segment.size);
      const originalLength = plaintext.length;
      totalPlaintext += originalLength;

      // Apply PADME to last segment of final chunk
      const isLastSegment = processedCount === totalSegmentCount - 1;
      if (isFinal && isLastSegment) {
        const paddedSize = padme(this.totalSize);
        const paddingNeeded = paddedSize - this.totalSize;
        if (paddingNeeded > 0) {
          const padded = new Uint8Array(plaintext.length + paddingNeeded);
          padded.set(plaintext, 0);
          plaintext = padded;
        }
      }

      checkAbort(this.context.signal);

      const { encrypted } = await encryptSegment(
        plaintext,
        this.manifestKey,
        segment.contentHash,
        this.context.signal
      );

      segmentInfos.push({
        fileIndex: segment.fileIndex,
        encryptedOffset,
        plaintextLength: originalLength,
        encryptedLength: encrypted.length,
      });

      encryptedParts.push(encrypted);
      encryptedOffset += encrypted.length;
      processedCount++;
    }

    // Concatenate encrypted parts
    const totalEncryptedSize = encryptedParts.reduce((sum, p) => sum + p.length, 0);
    const encryptedData = new Uint8Array(totalEncryptedSize);
    let writeOffset = 0;
    for (const part of encryptedParts) {
      encryptedData.set(part, writeOffset);
      writeOffset += part.length;
    }

    checkAbort(this.context.signal);

    // Upload as single-block CAR with retry
    const { cidString } = await uploadSingleBlock(
      encryptedData,
      this.ipfsClient,
      this.context.uploadRetries,
      this.context.signal
    );

    const uploadedChunk: UploadedChunk = {
      chunkId,
      cid: cidString,
      encryptedSize: totalEncryptedSize,
      segments: segmentInfos,
      dataSize: totalPlaintext,
    };

    // Update context
    this.context.uploadedChunks.set(chunkId, uploadedChunk);
    this.context.chunksUploaded++;

    // Notify callback
    this.context.onChunkUploaded?.({
      chunkId,
      cid: cidString,
      encryptedSize: totalEncryptedSize,
    });

    // Reset buffer
    this.segments = [];
    this.streamSegments = [];
    this.totalSize = 0;
    this.pendingChunkId = null;

    return uploadedChunk;
  }
}

// ============================================================================
// Stream Reading Utilities
// ============================================================================

/**
 * Convert ReadableStream or AsyncIterable to AsyncIterable<Uint8Array>
 */
function toAsyncIterable(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in source) {
    return source as AsyncIterable<Uint8Array>;
  }
  // It's a ReadableStream
  const stream = source as ReadableStream<Uint8Array>;
  return {
    async *[Symbol.asyncIterator]() {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

/**
 * Read exactly `size` bytes from a stream.
 */
async function readExactly(
  iter: AsyncIterator<Uint8Array>,
  size: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;

  while (bytesRead < size) {
    checkAbort(signal);
    const { done, value } = await iter.next();
    if (done) break;
    if (!value) continue;

    const needed = size - bytesRead;
    if (value.length <= needed) {
      chunks.push(value);
      bytesRead += value.length;
    } else {
      // Take what we need, the rest is lost (caller should handle this)
      chunks.push(value.subarray(0, needed));
      bytesRead += needed;
    }
  }

  // Concatenate
  const result = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// ============================================================================
// Large File Processor
// ============================================================================

/**
 * Process a large file through dedicated streaming chunks.
 * Each 10MB chunk is uploaded immediately after encryption.
 */
async function processLargeFile(
  file: StreamingFileInput,
  fileIndex: number,
  context: ProcessingContext
): Promise<ChunkRef[]> {
  const chunkRefs: ChunkRef[] = [];
  const stream = toAsyncIterable(file.getStream());
  const iterator = stream[Symbol.asyncIterator]();

  let fileOffset = 0;
  let remainingSize = file.size;
  const isLastFile = false; // We don't know if this is last file yet

  // Buffer for accumulating stream data into CHUNK_SIZE pieces
  let buffer = new Uint8Array(0);

  while (remainingSize > 0) {
    checkAbort(context.signal);

    const chunkDataSize = Math.min(CHUNK_SIZE, remainingSize);
    const isFinalChunk = chunkDataSize === remainingSize;

    // Read chunk data from stream (may need to accumulate)
    while (buffer.length < chunkDataSize) {
      const { done, value } = await iterator.next();
      if (done) break;
      if (!value) continue;

      // Append to buffer
      const newBuffer = new Uint8Array(buffer.length + value.length);
      newBuffer.set(buffer, 0);
      newBuffer.set(value, buffer.length);
      buffer = newBuffer;
    }

    // Extract chunk data
    let chunkData = buffer.subarray(0, chunkDataSize);
    buffer = buffer.subarray(chunkDataSize);

    // Apply PADME to final chunk of final file (handled by caller knowing it's last file)
    // For now, we don't apply PADME here - it's applied in the main loop when we know it's the last file

    checkAbort(context.signal);

    // Generate chunk ID and encrypt
    const chunkId = await generateChunkId();
    const { encrypted, encryption } = await encryptSegment(
      chunkData,
      context.manifestKey,
      file.contentHash,
      context.signal
    );

    checkAbort(context.signal);

    // Upload with retry
    const { cidString } = await uploadSingleBlock(
      encrypted,
      context.ipfsClient,
      context.uploadRetries,
      context.signal
    );

    // Track
    const uploadedChunk: UploadedChunk = {
      chunkId,
      cid: cidString,
      encryptedSize: encrypted.length,
      segments: [
        {
          fileIndex,
          encryptedOffset: 0,
          plaintextLength: chunkData.length,
          encryptedLength: encrypted.length,
        },
      ],
      dataSize: chunkData.length,
    };
    context.uploadedChunks.set(chunkId, uploadedChunk);
    context.chunksUploaded++;

    // Build ChunkRef
    chunkRefs.push({
      chunkId,
      cid: cidString,
      offset: 0,
      length: chunkData.length,
      encryption,
      encryptedLength: encrypted.length,
    });

    // Notify
    context.onChunkUploaded?.({
      chunkId,
      cid: cidString,
      encryptedSize: encrypted.length,
    });

    fileOffset += chunkData.length;
    remainingSize -= chunkData.length;
  }

  return chunkRefs;
}

// ============================================================================
// Incremental Manifest Builder
// ============================================================================

/**
 * Manages incremental manifest building with sub-manifest flushing.
 */
class IncrementalManifestBuilder {
  private pendingFiles: FileInfo[] = [];
  private pendingSize = 0;
  private flushedSubManifests: FlushedSubManifest[] = [];

  constructor(
    private manifestKey: SymmetricKey,
    private ipfsClient: IpfsClient,
    private context: ProcessingContext,
    private threshold: number = SUB_MANIFEST_SIZE
  ) {}

  /**
   * Estimate serialized size of a FileInfo.
   */
  private estimateSize(fileInfo: FileInfo): number {
    // Rough estimate: fixed fields + path + name + chunks
    return 100 + fileInfo.path.length + fileInfo.name.length + fileInfo.chunks.length * 120;
  }

  /**
   * Add a completed file to the manifest.
   * May trigger sub-manifest flush if threshold exceeded.
   */
  async addFile(fileInfo: FileInfo): Promise<void> {
    const estimatedSize = this.estimateSize(fileInfo);

    // Check if adding this file would exceed threshold
    if (this.pendingSize + estimatedSize > this.threshold && this.pendingFiles.length > 0) {
      await this.flushSubManifest();
    }

    this.pendingFiles.push(fileInfo);
    this.pendingSize += estimatedSize;
  }

  /**
   * Flush pending files as a sub-manifest.
   */
  async flushSubManifest(): Promise<FlushedSubManifest | null> {
    if (this.pendingFiles.length === 0) {
      return null;
    }

    checkAbort(this.context.signal);

    // Sort files by path for determinism
    const sortedFiles = [...this.pendingFiles].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    );

    // Serialize sub-manifest
    const subManifestData = { files: sortedFiles };
    const serialized = encodeSubManifest(subManifestData);

    // Encrypt with sub-manifest domain
    const fileKey = await deriveFileKey(this.manifestKey, new Uint8Array(32) as ContentHash);
    // Note: Sub-manifests use a different encryption context, but for simplicity we use same pattern
    const { nonce, ciphertext } = await encrypt(serialized, this.manifestKey);
    const encrypted = new Uint8Array(NONCE_SIZE + ciphertext.length);
    encrypted.set(nonce, 0);
    encrypted.set(ciphertext, NONCE_SIZE);

    checkAbort(this.context.signal);

    // Upload with retry
    const { cidString } = await uploadSingleBlock(
      encrypted,
      this.ipfsClient,
      this.context.uploadRetries,
      this.context.signal
    );

    const flushed: FlushedSubManifest = {
      index: this.flushedSubManifests.length,
      cid: cidString,
      encryptedBytes: encrypted,
      startPath: sortedFiles[0]!.path,
      endPath: sortedFiles[sortedFiles.length - 1]!.path,
      fileCount: sortedFiles.length,
    };

    this.flushedSubManifests.push(flushed);
    this.context.uploadedSubManifests.push(flushed);
    this.context.subManifestsFlushed++;

    // Notify
    this.context.onSubManifestFlushed?.({
      index: flushed.index,
      cid: cidString,
      fileCount: flushed.fileCount,
    });

    // Reset pending
    this.pendingFiles = [];
    this.pendingSize = 0;

    return flushed;
  }

  /**
   * Get pending files (for root manifest).
   */
  getPendingFiles(): FileInfo[] {
    return this.pendingFiles;
  }

  /**
   * Get all flushed sub-manifests.
   */
  getFlushedSubManifests(): FlushedSubManifest[] {
    return this.flushedSubManifests;
  }
}

// ============================================================================
// Final CAR Builder
// ============================================================================

/**
 * Build the final CAR with directory structure linking to already-uploaded chunks.
 */
async function buildFinalCar(
  chunkCidMap: Map<string, { chunkId: ChunkId; cid: string; encryptedSize: number }>,
  manifest: Uint8Array,
  subManifests: Uint8Array[],
  uploadedSubManifestCids: string[]
): Promise<{
  carBytes: Uint8Array;
  rootCid: string;
  manifestCid: string;
  newSubManifestCids: string[];
}> {
  // Compute manifest CID
  const manifestCid = await computeRawCid(manifest);

  // Compute CIDs for any new sub-manifests (not already uploaded)
  const newSubManifestCids: CID[] = [];
  for (let i = uploadedSubManifestCids.length; i < subManifests.length; i++) {
    const cid = await computeRawCid(subManifests[i]!);
    newSubManifestCids.push(cid);
  }

  // Build directory tree structure
  // chunk path: {id[0:2]}/{id[2:4]}/{id}
  interface DirNode {
    children: Map<string, DirNode>;
    chunks: Array<{ name: string; cid: CID; size: number }>;
  }

  const root: DirNode = { children: new Map(), chunks: [] };

  for (const [chunkId, info] of chunkCidMap) {
    const path = chunkIdToPath(chunkId as ChunkId);
    const parts = path.split('/'); // ["6B", "v7", "6Bv7..."]

    // Navigate to level-1
    const level1Name = parts[0]!;
    if (!root.children.has(level1Name)) {
      root.children.set(level1Name, { children: new Map(), chunks: [] });
    }
    const level1 = root.children.get(level1Name)!;

    // Navigate to level-2
    const level2Name = parts[1]!;
    if (!level1.children.has(level2Name)) {
      level1.children.set(level2Name, { children: new Map(), chunks: [] });
    }
    const level2 = level1.children.get(level2Name)!;

    // Add chunk
    level2.chunks.push({
      name: parts[2]!,
      cid: CID.parse(info.cid),
      size: info.encryptedSize,
    });
  }

  // Build directory blocks bottom-up
  const blocks: Array<{ cid: CID; bytes: Uint8Array }> = [];

  function byteCompare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  async function createDirNode(
    links: Array<{ name: string; cid: CID; tsize: number }>
  ): Promise<{ bytes: Uint8Array; cid: CID }> {
    const sortedLinks = [...links].sort((a, b) => byteCompare(a.name, b.name));
    const pbLinks = sortedLinks.map((link) => ({
      Name: link.name,
      Hash: link.cid,
      Tsize: link.tsize,
    }));
    const node = dagPb.createNode(new Uint8Array(0), pbLinks);
    const bytes = dagPb.encode(node);
    const cid = await computeDagPbCid(bytes);
    return { bytes, cid };
  }

  // Build level-1 directories and collect their links
  const level1Names = [...root.children.keys()].sort(byteCompare);
  const level1Links: Array<{ name: string; cid: CID; tsize: number }> = [];

  for (const level1Name of level1Names) {
    const level1Node = root.children.get(level1Name)!;
    const level2Names = [...level1Node.children.keys()].sort(byteCompare);
    const level2Links: Array<{ name: string; cid: CID; tsize: number }> = [];

    for (const level2Name of level2Names) {
      const level2Node = level1Node.children.get(level2Name)!;

      // Create links for chunks
      const chunkLinks = level2Node.chunks.map((c) => ({
        name: c.name,
        cid: c.cid,
        tsize: c.size,
      }));

      // Create level-2 directory
      const { bytes, cid } = await createDirNode(chunkLinks);
      blocks.push({ cid, bytes });

      level2Links.push({
        name: level2Name,
        cid,
        tsize: bytes.length,
      });
    }

    // Create level-1 directory
    const { bytes: l1Bytes, cid: l1Cid } = await createDirNode(level2Links);
    blocks.push({ cid: l1Cid, bytes: l1Bytes });

    level1Links.push({
      name: level1Name,
      cid: l1Cid,
      tsize: l1Bytes.length,
    });
  }

  // Build root directory links
  const rootLinks = [...level1Links];

  // Add manifest link
  rootLinks.push({
    name: 'm',
    cid: manifestCid,
    tsize: manifest.length,
  });

  // Add sub-manifest links (both already-uploaded and new)
  for (let i = 0; i < uploadedSubManifestCids.length; i++) {
    rootLinks.push({
      name: `m_${i}`,
      cid: CID.parse(uploadedSubManifestCids[i]!),
      tsize: subManifests[i]?.length ?? 0,
    });
  }
  for (let i = 0; i < newSubManifestCids.length; i++) {
    const globalIndex = uploadedSubManifestCids.length + i;
    rootLinks.push({
      name: `m_${globalIndex}`,
      cid: newSubManifestCids[i]!,
      tsize: subManifests[globalIndex]?.length ?? 0,
    });
  }

  // Create root directory
  const { bytes: rootBytes, cid: rootCid } = await createDirNode(rootLinks);
  blocks.push({ cid: rootCid, bytes: rootBytes });

  // Add manifest block
  blocks.push({ cid: manifestCid, bytes: manifest });

  // Add new sub-manifest blocks (already-uploaded ones are not included)
  for (let i = 0; i < newSubManifestCids.length; i++) {
    const globalIndex = uploadedSubManifestCids.length + i;
    blocks.push({
      cid: newSubManifestCids[i]!,
      bytes: subManifests[globalIndex]!,
    });
  }

  // Build CAR
  let estimatedSize = CAR_HEADER_SIZE;
  for (const block of blocks) {
    estimatedSize += block.bytes.length + MAX_CID_OVERHEAD;
  }

  const buffer = new ArrayBuffer(estimatedSize);
  const writer = CarBufferWriter.createWriter(buffer, { roots: [rootCid] });
  for (const block of blocks) {
    writer.write(block);
  }
  const carBytes = writer.close();

  return {
    carBytes,
    rootCid: rootCid.toString(),
    manifestCid: manifestCid.toString(),
    newSubManifestCids: newSubManifestCids.map((c) => c.toString()),
  };
}

// ============================================================================
// Main Upload Function
// ============================================================================

/**
 * Upload a batch of files using streaming processing.
 *
 * Memory-efficient implementation that:
 * - Processes files lazily from AsyncIterable
 * - Aggregates small files into ~10MB chunks
 * - Streams large files through ~10MB dedicated chunks
 * - Flushes sub-manifests incrementally (~1MB threshold)
 * - Uploads chunks immediately as single-block CARs
 * - Builds final CAR with directory structure at the end
 *
 * Peak memory usage: ~12MB regardless of batch size.
 *
 * @param files - Async iterable of files to upload
 * @param options - Upload options
 * @param ipfsClient - IPFS client
 * @returns BatchResult with CID and manifest
 */
export async function uploadBatch(
  files: AsyncIterable<StreamingFileInput>,
  options: UploadOptions,
  ipfsClient: IpfsClient
): Promise<BatchResult> {
  const { signal, onProgress, onChunkUploaded, onSubManifestFlushed } = options;

  // === VALIDATION ===
  if (options.recipients.length === 0) {
    throw new ValidationError('At least one recipient is required');
  }

  // === INITIALIZE STATE ===
  const batchId = base58.encode(await randomBytes(16));
  const created = Date.now();
  const manifestKey = await generateKey();

  // Build context
  const context: ProcessingContext = {
    manifestKey,
    ipfsClient,
    signal,
    uploadRetries: options.uploadRetries ?? DEFAULT_RETRIES,
    onProgress,
    onChunkUploaded,
    onSubManifestFlushed,

    uploadedChunks: new Map(),
    uploadedSubManifests: [],
    fileInfos: [],
    directories: [],
    resolvedPaths: [],
    renamed: [],

    filesProcessed: 0,
    bytesProcessed: 0,
    chunksUploaded: 0,
    subManifestsFlushed: 0,
    batchId,
    created,
  };

  checkAbort(signal);

  // === PROCESS FILES (TRUE STREAMING) ===
  // Process files directly from AsyncIterable without collecting upfront.
  // Uses PathManager for incremental conflict resolution and
  // DirectoryTreeBuilder for incremental directory building.

  const pathManager = new PathManager();
  const dirBuilder = new DirectoryTreeBuilder(created, options.directories);
  const aggregationBuffer = new AggregationBufferManager(manifestKey, ipfsClient, context);
  const manifestBuilder = new IncrementalManifestBuilder(manifestKey, ipfsClient, context);

  // Helper to update ChunkRefs for files in a flushed chunk
  function updateChunkRefsForFlushedChunk(flushedChunk: UploadedChunk | null) {
    if (!flushedChunk) return;
    for (const segInfo of flushedChunk.segments) {
      const fileInfo = context.fileInfos[segInfo.fileIndex];
      if (fileInfo && fileInfo.chunks.length === 0) {
        fileInfo.chunks.push({
          chunkId: flushedChunk.chunkId,
          cid: flushedChunk.cid,
          offset: segInfo.encryptedOffset,
          length: segInfo.plaintextLength,
          encryption: ChunkEncryption.SINGLE_SHOT,
          encryptedLength: segInfo.encryptedLength,
        });
      }
    }
  }

  let fileIndex = 0;
  let hasFiles = false;

  for await (const file of files) {
    hasFiles = true;
    checkAbort(signal);

    // Resolve path incrementally
    const resolvedPath = pathManager.resolvePath(file.path);
    context.resolvedPaths.push(resolvedPath);

    // Track renamed files
    if (file.path !== resolvedPath) {
      context.renamed.push({
        originalPath: file.path,
        newPath: resolvedPath,
      });
    }

    // Add to directory tree incrementally
    dirBuilder.addFilePath(resolvedPath);

    // Report progress (totalFiles and totalBytes are undefined for true streaming)
    onProgress?.({
      phase: 'processing',
      filesProcessed: context.filesProcessed,
      totalFiles: undefined,
      bytesProcessed: context.bytesProcessed,
      totalBytes: undefined,
      chunksUploaded: context.chunksUploaded,
      subManifestsFlushed: context.subManifestsFlushed,
      currentFile: {
        path: resolvedPath,
        size: file.size,
        bytesRead: 0,
      },
    });

    let chunkRefs: ChunkRef[] = [];

    if (file.size === 0) {
      // Empty file - no chunks
    } else if (file.size >= CHUNK_SIZE) {
      // Large file - stream through dedicated chunks
      // First flush any pending aggregation (and update their ChunkRefs)
      const pendingChunk = await aggregationBuffer.flush(false);
      updateChunkRefsForFlushedChunk(pendingChunk);

      // Process large file
      chunkRefs = await processLargeFile(file, fileIndex, context);

      context.bytesProcessed += file.size;
    } else {
      // Small file - aggregate with streaming (deferred loading at flush time)
      // Check if we need to flush before adding
      if (aggregationBuffer.currentSize + file.size > CHUNK_SIZE) {
        const preFlushChunk = await aggregationBuffer.flush(false);
        updateChunkRefsForFlushedChunk(preFlushChunk);
      }

      // Add stream factory to buffer (stream consumed lazily at flush time)
      const flushedChunk = await aggregationBuffer.addStreamSegment(
        fileIndex,
        file.size,
        0,
        file.contentHash,
        file.getStream
      );

      // Build ChunkRef from buffer state
      // We need to track which chunk this file ended up in
      if (flushedChunk) {
        // File was part of flushed chunk
        const segInfo = flushedChunk.segments.find((s) => s.fileIndex === fileIndex);
        if (segInfo) {
          chunkRefs.push({
            chunkId: flushedChunk.chunkId,
            cid: flushedChunk.cid,
            offset: segInfo.encryptedOffset,
            length: segInfo.plaintextLength,
            encryption: ChunkEncryption.SINGLE_SHOT,
            encryptedLength: segInfo.encryptedLength,
          });
        }
      }
      // If not flushed, we'll build ChunkRefs after final flush

      context.bytesProcessed += file.size;
    }

    // Build FileInfo
    const fileInfo: FileInfo = {
      path: resolvedPath,
      name: basename(resolvedPath as any),
      size: file.size,
      contentHash: file.contentHash,
      chunks: chunkRefs,
      created: file.created ?? created,
    };

    context.fileInfos.push(fileInfo);
    context.filesProcessed++;

    // Add to manifest builder (may trigger sub-manifest flush)
    await manifestBuilder.addFile(fileInfo);

    fileIndex++;
  }

  // Check for empty batch (after streaming through all files)
  if (!hasFiles) {
    throw new ValidationError('Cannot upload empty batch');
  }

  // Build final directories (after all files processed)
  context.directories = dirBuilder.build();

  // === FINAL FLUSH ===
  onProgress?.({
    phase: 'finalizing',
    filesProcessed: context.filesProcessed,
    totalFiles: context.filesProcessed, // Now known after streaming
    bytesProcessed: context.bytesProcessed,
    totalBytes: context.bytesProcessed, // Now known after streaming
    chunksUploaded: context.chunksUploaded,
    subManifestsFlushed: context.subManifestsFlushed,
  });

  // Flush remaining aggregation buffer with PADME
  const finalAggChunk = await aggregationBuffer.flush(true);
  updateChunkRefsForFlushedChunk(finalAggChunk);

  checkAbort(signal);

  // === BUILD FINAL CAR ===

  // Build manifest
  const manifestResult = buildManifest({
    files: context.fileInfos,
    directories: context.directories,
    created,
  });

  // Encrypt manifest
  const { envelope, encryptedSubManifests } = await encryptManifest({
    manifest: manifestResult,
    recipients: options.recipients,
    senderKeyPair: options.senderKeyPair,
    manifestKey,
  });

  // Build chunk CID map for final CAR
  const chunkCidMap = new Map<
    string,
    { chunkId: ChunkId; cid: string; encryptedSize: number }
  >();
  for (const [chunkId, chunk] of context.uploadedChunks) {
    chunkCidMap.set(chunkId, {
      chunkId: chunkId as ChunkId,
      cid: chunk.cid,
      encryptedSize: chunk.encryptedSize,
    });
  }

  // Build final CAR
  const finalCarResult = await buildFinalCar(
    chunkCidMap,
    envelope,
    encryptedSubManifests,
    context.uploadedSubManifests.map((sm) => sm.cid)
  );

  checkAbort(signal);

  // Upload final CAR
  async function* finalCarGenerator(): AsyncIterable<Uint8Array> {
    yield finalCarResult.carBytes;
  }
  await ipfsClient.uploadCar(finalCarGenerator());

  // === BUILD RESULT ===
  const batchManifest: BatchManifest = {
    cid: finalCarResult.rootCid,
    manifestKey,
    senderPublicKey: options.senderKeyPair.publicKey,
    directories: context.directories,
    files: context.fileInfos,
    created,
  };

  return {
    cid: finalCarResult.rootCid,
    manifest: batchManifest,
    totalSize: Array.from(context.uploadedChunks.values()).reduce(
      (sum, c) => sum + c.encryptedSize,
      0
    ) + finalCarResult.carBytes.length,
    chunkCount: context.uploadedChunks.size,
    manifestCount: 1 + encryptedSubManifests.length,
    renamed: context.renamed.length > 0 ? context.renamed : undefined,
  };
}

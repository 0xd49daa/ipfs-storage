/**
 * Single file download implementation for IPFS storage.
 *
 * Implements bounded parallel chunk fetching with ordered emission,
 * streaming integrity verification, and retry logic.
 */

import type { SymmetricKey } from '@0xd49daa/safecrypt';
import { hashBlake2b, constantTimeEqual, createBlake2bHasher } from '@0xd49daa/safecrypt';
import type { IpfsClient } from './ipfs-client.ts';
import type {
  FileDownloadRef,
  DownloadOptions,
  ChunkRef,
} from './types.ts';
import { ChunkEncryption } from './gen/manifest_pb.ts';
import { deriveFileKey } from './crypto.ts';
import { decryptSingleShot, decryptStreaming } from './chunk-encrypt.ts';
import { chunkIdToPath } from './chunk-id.ts';
import { unsafe } from './branded.ts';
import {
  ValidationError,
  IntegrityError,
  ChunkUnavailableError,
} from './errors.ts';
import {
  DEFAULT_RETRIES,
  DEFAULT_CHUNK_CONCURRENCY,
} from './constants.ts';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if abort signal is triggered and throw if so.
 */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException(
      signal.reason instanceof Error
        ? signal.reason.message
        : String(signal.reason ?? 'Download aborted'),
      'AbortError'
    );
  }
}

/**
 * Collect async iterable bytes with abort support.
 */
async function collectBytes(
  iterable: AsyncIterable<Uint8Array>,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    checkAbort(signal);
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

/**
 * Validate FileDownloadRef structure.
 */
function validateDownloadRef(ref: FileDownloadRef): void {
  if (!ref.batchCid || typeof ref.batchCid !== 'string') {
    throw new ValidationError('batchCid must be a non-empty string');
  }
  if (!ref.path || typeof ref.path !== 'string') {
    throw new ValidationError('path must be a non-empty string');
  }
  if (typeof ref.size !== 'number' || ref.size < 0) {
    throw new ValidationError('size must be a non-negative number');
  }
  if (ref.size > 0 && ref.chunks.length === 0) {
    throw new ValidationError('non-empty file must have at least one chunk');
  }
  if (!ref.contentHash || ref.contentHash.length !== 32) {
    throw new ValidationError('contentHash must be a 32-byte Uint8Array');
  }
  if (!ref.manifestKey || ref.manifestKey.length !== 32) {
    throw new ValidationError('manifestKey must be a 32-byte Uint8Array');
  }
}

/**
 * Fetch a single chunk with retry logic.
 */
async function fetchChunk(
  batchCid: string,
  chunkRef: ChunkRef,
  ipfsClient: IpfsClient,
  maxRetries: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const chunkPath = `/${chunkIdToPath(unsafe.asChunkId(chunkRef.chunkId))}`;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    checkAbort(signal);

    try {
      const bytes = await collectBytes(
        ipfsClient.cat(batchCid, chunkPath),
        signal
      );
      return bytes;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      // Retry on transient failures
    }
  }

  throw new ChunkUnavailableError(batchCid, chunkRef.chunkId, lastError);
}

/**
 * Fetch and decrypt a single chunk segment.
 */
async function fetchAndDecryptChunk(
  batchCid: string,
  chunkRef: ChunkRef,
  fileKey: SymmetricKey,
  ipfsClient: IpfsClient,
  maxRetries: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  // Fetch the encrypted chunk
  const encryptedChunk = await fetchChunk(
    batchCid,
    chunkRef,
    ipfsClient,
    maxRetries,
    signal
  );

  // Extract segment using offset and encryptedLength
  const segmentBytes = encryptedChunk.slice(
    chunkRef.offset,
    chunkRef.offset + chunkRef.encryptedLength
  );

  // Decrypt based on encryption mode
  let plaintext: Uint8Array;
  if (chunkRef.encryption === ChunkEncryption.SINGLE_SHOT) {
    plaintext = await decryptSingleShot(segmentBytes, fileKey);
  } else {
    plaintext = await decryptStreaming(segmentBytes, fileKey);
  }

  // Trim PADME padding (return original plaintext length only)
  return plaintext.slice(0, chunkRef.length);
}

// ============================================================================
// Main Download Function
// ============================================================================

/**
 * Result of a chunk fetch with its index for ordering.
 */
interface ChunkResult {
  index: number;
  data: Uint8Array;
}

/**
 * Download and decrypt a single file from IPFS.
 *
 * Follows the same pattern as uploadBatch(files, options, ipfsClient).
 * Phase 17 module factory will bind ipfsClient and expose spec-compliant
 * downloadFile(file, options?) signature.
 *
 * @param ref - File download reference with chunk info
 * @param options - Download options (can be undefined, all fields have defaults)
 * @param ipfsClient - IPFS client for content retrieval
 * @returns AsyncIterable yielding decrypted plaintext chunks
 * @throws ValidationError - Invalid ref (empty batchCid, negative size, etc.)
 * @throws ChunkUnavailableError - Chunk fetch failed after retries
 * @throws IntegrityError - Content hash mismatch (strict mode only)
 */
export async function* downloadFile(
  ref: FileDownloadRef,
  options: DownloadOptions | undefined,
  ipfsClient: IpfsClient
): AsyncIterable<Uint8Array> {
  // Extract options with defaults
  const {
    retries = DEFAULT_RETRIES,
    chunkConcurrency = DEFAULT_CHUNK_CONCURRENCY,
    signal,
    onProgress,
    integrityMode = 'strict',
    onIntegrityError,
  } = options ?? {};

  // Check abort before starting
  checkAbort(signal);

  // Validate inputs
  validateDownloadRef(ref);
  if (chunkConcurrency < 1) {
    throw new ValidationError('chunkConcurrency must be at least 1');
  }

  // Handle empty files (size 0, no chunks)
  if (ref.size === 0) {
    // Verify empty content hash
    const emptyHash = await hashBlake2b(new Uint8Array(0), 32);

    const hashMatches = await constantTimeEqual(emptyHash, ref.contentHash);
    if (!hashMatches) {
      const error = new IntegrityError(
        ref.path,
        ref.contentHash,
        emptyHash as typeof ref.contentHash
      );
      if (integrityMode === 'strict') {
        throw error;
      }
      onIntegrityError?.(error);
    }

    // Report final progress
    onProgress?.({ bytesDownloaded: 0, totalBytes: 0 });
    return; // Yield nothing for empty file
  }

  // Derive file encryption key
  const fileKey = await deriveFileKey(ref.manifestKey, ref.contentHash);

  // Create streaming hasher for incremental integrity verification
  const hasher = await createBlake2bHasher();

  // Progress tracking
  let bytesYielded = 0;
  const totalBytes = ref.size;
  const totalChunks = ref.chunks.length;

  // ========================================================================
  // Bounded Parallel Prefetch with Ordered Emission
  // ========================================================================

  // Track pending fetches and completed chunks waiting to be yielded
  const pendingFetches = new Map<number, Promise<ChunkResult>>();
  const buffer = new Map<number, Uint8Array>();
  let nextToYield = 0;
  let nextToFetch = 0;

  /**
   * Start a fetch for the given chunk index.
   */
  const startFetch = (chunkIndex: number): void => {
    const chunkRef = ref.chunks[chunkIndex]!;
    const promise = fetchAndDecryptChunk(
      ref.batchCid,
      chunkRef,
      fileKey,
      ipfsClient,
      retries,
      signal
    ).then((data): ChunkResult => ({ index: chunkIndex, data }));

    pendingFetches.set(chunkIndex, promise);
  };

  /**
   * Wait for any pending fetch to complete and return its result.
   */
  const waitForAny = async (): Promise<ChunkResult> => {
    const promises = Array.from(pendingFetches.values());
    const result = await Promise.race(promises);
    pendingFetches.delete(result.index);
    return result;
  };

  // Start initial batch of fetches (up to chunkConcurrency)
  const initialBatchSize = Math.min(chunkConcurrency, totalChunks);
  for (let i = 0; i < initialBatchSize; i++) {
    startFetch(nextToFetch++);
  }

  // Main loop: process until all chunks yielded
  // Wrap in try-catch to ensure pending fetches are settled on error/abort
  try {
    while (nextToYield < totalChunks) {
      checkAbort(signal);

      // If we have the next chunk in buffer, yield it immediately
      while (buffer.has(nextToYield)) {
        const data = buffer.get(nextToYield)!;
        buffer.delete(nextToYield);

        // Update streaming hasher for integrity verification
        hasher.update(data);

        // Yield the plaintext
        yield data;

        // Update progress
        bytesYielded += data.length;
        onProgress?.({ bytesDownloaded: bytesYielded, totalBytes });

        nextToYield++;
      }

      // If all chunks have been yielded, we're done
      if (nextToYield >= totalChunks) {
        break;
      }

      // Wait for any pending fetch to complete
      if (pendingFetches.size > 0) {
        const result = await waitForAny();

        // Store in buffer
        buffer.set(result.index, result.data);

        // Start next fetch if more chunks remain
        if (nextToFetch < totalChunks) {
          startFetch(nextToFetch++);
        }
      }
    }
  } catch (error) {
    // On error (abort or otherwise), wait for all pending fetches to settle
    // to prevent unhandled promise rejections
    if (pendingFetches.size > 0) {
      await Promise.allSettled(pendingFetches.values());
    }
    throw error;
  }

  // ========================================================================
  // Integrity Verification
  // ========================================================================

  // Finalize streaming hash and verify
  const actualHash = await hasher.digest();
  const hashMatches = await constantTimeEqual(actualHash, ref.contentHash);

  if (!hashMatches) {
    const error = new IntegrityError(
      ref.path,
      ref.contentHash,
      actualHash as typeof ref.contentHash
    );
    if (integrityMode === 'strict') {
      throw error;
    }
    onIntegrityError?.(error);
  }
}

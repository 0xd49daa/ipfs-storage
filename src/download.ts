/**
 * Single file download implementation for IPFS storage.
 *
 * Implements bounded parallel chunk fetching with ordered emission,
 * streaming integrity verification, and retry logic.
 */

import {
  constantTimeEqual,
  createContentHasher,
  hashContent,
} from "./crypto-primitives.ts";
import type { IpfsClient } from "./ipfs-client.ts";
import type { ChunkRef, DownloadOptions, FileDownloadRef } from "./types.ts";
import { chunkIdToPath } from "./chunk-id.ts";
import { unsafe } from "./branded.ts";
import {
  ChunkUnavailableError,
  IntegrityError,
  ManifestError,
  ValidationError,
} from "./errors.ts";
import { DEFAULT_CHUNK_CONCURRENCY, DEFAULT_RETRIES } from "./constants.ts";
import { getBatchIdFromManifestBlob } from "./manifest-retrieval.ts";
import {
  decryptVaultChunkRecord,
  VAULT_AES_256_KEY_SIZE,
} from "./vault-aead.ts";

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
        : String(signal.reason ?? "Download aborted"),
      "AbortError",
    );
  }
}

/**
 * Collect async iterable bytes with abort support.
 */
async function collectBytes(
  iterable: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
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
  if (!ref.batchCid || typeof ref.batchCid !== "string") {
    throw new ValidationError("batchCid must be a non-empty string");
  }
  if (!ref.path || typeof ref.path !== "string") {
    throw new ValidationError("path must be a non-empty string");
  }
  if (typeof ref.size !== "number" || ref.size < 0) {
    throw new ValidationError("size must be a non-negative number");
  }
  if (ref.size > 0 && ref.chunks.length === 0) {
    throw new ValidationError("non-empty file must have at least one chunk");
  }
  if (!ref.contentHash || ref.contentHash.length !== 32) {
    throw new ValidationError("contentHash must be a 32-byte Uint8Array");
  }
}

/**
 * Validate caller-supplied download options.
 */
function validateDownloadOptions(options: DownloadOptions | undefined): void {
  if (!options || typeof options !== "object") {
    throw new ValidationError("options must be an object");
  }
  if (!options.manifestKey) {
    throw new ValidationError("manifestKey is required");
  }
  if (options.manifestKey.length !== VAULT_AES_256_KEY_SIZE) {
    throw new ValidationError(
      `manifestKey must be ${VAULT_AES_256_KEY_SIZE} bytes, got ${options.manifestKey.length}`,
    );
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
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunkPath = `/${chunkIdToPath(unsafe.asChunkId(chunkRef.chunkId))}`;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    checkAbort(signal);

    try {
      const bytes = await collectBytes(
        ipfsClient.cat(batchCid, chunkPath),
        signal,
      );
      return bytes;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      // Retry on transient failures
    }
  }

  throw new ChunkUnavailableError(batchCid, chunkRef.chunkId, lastError);
}

/**
 * Fetch the root manifest blob and parse its plaintext batch_id locator.
 */
async function fetchBatchId(
  batchCid: string,
  ipfsClient: IpfsClient,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  try {
    const rootManifestBlob = await collectBytes(
      ipfsClient.cat(batchCid, "/m"),
      signal,
    );
    return getBatchIdFromManifestBlob(rootManifestBlob);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to read manifest batch_id prefix: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Fetch and decrypt a single chunk segment.
 */
async function fetchAndDecryptChunk(
  batchCid: string,
  chunkRef: ChunkRef,
  manifestKey: Uint8Array,
  batchId: Uint8Array,
  filePathWithinBatch: string,
  chunkIndex: number,
  ipfsClient: IpfsClient,
  maxRetries: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  // Fetch the encrypted chunk
  const encryptedChunk = await fetchChunk(
    batchCid,
    chunkRef,
    ipfsClient,
    maxRetries,
    signal,
  );

  // Extract segment using offset and encryptedLength
  const segmentBytes = encryptedChunk.slice(
    chunkRef.offset,
    chunkRef.offset + chunkRef.encryptedLength,
  );

  const plaintext = await decryptVaultChunkRecord({
    record: segmentBytes,
    manifestKey,
    batchId,
    filePathWithinBatch,
    chunkIndex,
  });

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
 * Phase 17 module factory binds ipfsClient and exposes the public method.
 *
 * @param ref - File download reference with chunk info
 * @param options - Download options including caller-supplied manifestKey
 * @param ipfsClient - IPFS client for content retrieval
 * @returns AsyncIterable yielding decrypted plaintext chunks
 * @throws ValidationError - Invalid ref (empty batchCid, negative size, etc.)
 * @throws ChunkUnavailableError - Chunk fetch failed after retries
 * @throws IntegrityError - Content hash mismatch (strict mode only)
 */
async function* downloadFileIterable(
  ref: FileDownloadRef,
  options: DownloadOptions,
  ipfsClient: IpfsClient,
): AsyncIterable<Uint8Array> {
  const signal = options?.signal;

  // Check abort before starting
  checkAbort(signal);

  // Validate inputs
  validateDownloadRef(ref);
  validateDownloadOptions(options);

  // Extract options with defaults
  const {
    manifestKey,
    retries = DEFAULT_RETRIES,
    chunkConcurrency = DEFAULT_CHUNK_CONCURRENCY,
    onProgress,
    integrityMode = "strict",
    onIntegrityError,
  } = options;

  if (chunkConcurrency < 1) {
    throw new ValidationError("chunkConcurrency must be at least 1");
  }

  // Handle empty files (size 0, no chunks)
  if (ref.size === 0) {
    // Verify empty content hash
    const emptyHash = await hashContent(new Uint8Array(0));

    const hashMatches = await constantTimeEqual(emptyHash, ref.contentHash);
    if (!hashMatches) {
      const error = new IntegrityError(
        ref.path,
        ref.contentHash,
        emptyHash as typeof ref.contentHash,
      );
      if (integrityMode === "strict") {
        throw error;
      }
      onIntegrityError?.(error);
    }

    // Report final progress
    onProgress?.({ bytesDownloaded: 0, totalBytes: 0 });
    return; // Yield nothing for empty file
  }

  const batchId = await fetchBatchId(ref.batchCid, ipfsClient, signal);

  // Create streaming hasher for incremental integrity verification
  const hasher = createContentHasher();

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
      manifestKey,
      batchId,
      ref.path,
      chunkIndex,
      ipfsClient,
      retries,
      signal,
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
      actualHash,
    );
    if (integrityMode === "strict") {
      throw error;
    }
    onIntegrityError?.(error);
  }
}

async function writeDownloadToStream(
  iterable: AsyncIterable<Uint8Array>,
  output: WritableStream<Uint8Array>,
): Promise<void> {
  const writer = output.getWriter();
  try {
    for await (const chunk of iterable) {
      await writer.write(chunk);
    }
  } finally {
    writer.releaseLock();
  }
}

export function downloadFile(
  ref: FileDownloadRef,
  options: DownloadOptions & { output: WritableStream<Uint8Array> },
  ipfsClient: IpfsClient,
): Promise<void>;
export function downloadFile(
  ref: FileDownloadRef,
  options: DownloadOptions,
  ipfsClient: IpfsClient,
): AsyncIterable<Uint8Array>;
export function downloadFile(
  ref: FileDownloadRef,
  options: DownloadOptions,
  ipfsClient: IpfsClient,
): AsyncIterable<Uint8Array> | Promise<void> {
  const iterable = downloadFileIterable(ref, options, ipfsClient);
  if (options.output) {
    return writeDownloadToStream(iterable, options.output);
  }
  return iterable;
}

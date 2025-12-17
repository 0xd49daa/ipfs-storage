/**
 * Multi-file download implementation for IPFS storage.
 *
 * Implements sequential file downloading with aggregate progress tracking
 * and error handling modes.
 *
 * Files are downloaded one at a time (no parallel file buffering) to keep
 * memory usage bounded. Each file is fully downloaded before yielding to
 * maintain error detection semantics.
 */

import type { IpfsClient } from './ipfs-client.ts';
import type {
  FileDownloadRef,
  DownloadFilesOptions,
  DownloadedFile,
} from './types.ts';
import { downloadFile } from './download.ts';
import { ValidationError } from './errors.ts';
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
 * Collect async iterable bytes into a single Uint8Array.
 */
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

/**
 * Create an async iterable that yields a Uint8Array in chunks.
 */
async function* yieldInChunks(
  content: Uint8Array
): AsyncIterable<Uint8Array> {
  const YIELD_CHUNK_SIZE = 64 * 1024; // 64KB chunks
  for (let offset = 0; offset < content.length; offset += YIELD_CHUNK_SIZE) {
    yield content.subarray(offset, Math.min(offset + YIELD_CHUNK_SIZE, content.length));
  }
}

// ============================================================================
// Main Download Function
// ============================================================================

/**
 * Download multiple files from IPFS with sequential downloading.
 *
 * Files are downloaded one at a time (sequentially) and yielded in request
 * order. Each file is fully downloaded before yielding to maintain error
 * detection semantics. Memory usage is bounded to one file at a time.
 *
 * Note: The `concurrency` option is accepted for API compatibility but
 * downloads are always sequential to bound memory usage.
 *
 * @param refs - Array of file download references
 * @param options - Download options (can be undefined, all fields have defaults)
 * @param ipfsClient - IPFS client for content retrieval
 * @returns AsyncIterable yielding DownloadedFile objects in request order
 * @throws ValidationError - Empty refs array
 * @throws AbortError - If abort signal triggered
 * @throws Error - First file error if no onError callback provided
 */
export async function* downloadFiles(
  refs: FileDownloadRef[],
  options: DownloadFilesOptions | undefined,
  ipfsClient: IpfsClient
): AsyncIterable<DownloadedFile> {
  // Extract options with defaults
  const {
    concurrency = 1, // Accepted for API compatibility, but downloads are sequential
    chunkConcurrency = DEFAULT_CHUNK_CONCURRENCY,
    retries = DEFAULT_RETRIES,
    signal,
    onProgress,
    onError,
    integrityMode = 'strict',
    onIntegrityError,
  } = options ?? {};

  // Check abort before starting
  checkAbort(signal);

  // Validate inputs
  if (refs.length === 0) {
    throw new ValidationError('refs array must not be empty');
  }
  if (concurrency < 1) {
    throw new ValidationError('concurrency must be at least 1');
  }
  if (chunkConcurrency < 1) {
    throw new ValidationError('chunkConcurrency must be at least 1');
  }

  // Calculate total bytes for progress
  const totalFiles = refs.length;
  const totalBytes = refs.reduce((sum, ref) => sum + ref.size, 0);

  // Progress tracking
  let filesCompleted = 0;
  let bytesDownloaded = 0;

  // Report initial progress
  onProgress?.({
    filesCompleted: 0,
    totalFiles,
    bytesDownloaded: 0,
    totalBytes,
    currentFile: refs[0]?.path,
  });

  // Process files sequentially (one at a time to bound memory)
  for (let fileIndex = 0; fileIndex < refs.length; fileIndex++) {
    checkAbort(signal);

    const ref = refs[fileIndex]!;

    try {
      // Track bytes for this file
      let fileBytesDownloaded = 0;

      // Download the file content
      const contentIterable = downloadFile(
        ref,
        {
          retries,
          chunkConcurrency,
          signal,
          integrityMode,
          onIntegrityError,
          onProgress: (progress) => {
            // Update aggregate progress as chunks are downloaded
            const newBytes = progress.bytesDownloaded - fileBytesDownloaded;
            if (newBytes > 0) {
              bytesDownloaded += newBytes;
              fileBytesDownloaded = progress.bytesDownloaded;
              onProgress?.({
                filesCompleted,
                totalFiles,
                bytesDownloaded,
                totalBytes,
                currentFile: ref.path,
              });
            }
          },
        },
        ipfsClient
      );

      // Collect file content (one file at a time to bound memory)
      const content = await collectBytes(contentIterable);

      // File download complete
      filesCompleted++;
      onProgress?.({
        filesCompleted,
        totalFiles,
        bytesDownloaded,
        totalBytes,
        currentFile:
          fileIndex + 1 < totalFiles ? refs[fileIndex + 1]?.path : undefined,
      });

      // Yield the completed file
      yield {
        path: ref.path,
        size: ref.size,
        content: yieldInChunks(content),
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      if (onError) {
        // Report error via callback and continue to next file
        onError(err, ref);
        filesCompleted++;
        onProgress?.({
          filesCompleted,
          totalFiles,
          bytesDownloaded,
          totalBytes,
          currentFile:
            fileIndex + 1 < totalFiles ? refs[fileIndex + 1]?.path : undefined,
        });
      } else {
        // Fail fast - throw immediately
        throw err;
      }
    }
  }

  // Final progress report
  onProgress?.({
    filesCompleted,
    totalFiles,
    bytesDownloaded,
    totalBytes,
  });
}

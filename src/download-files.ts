/**
 * Multi-file download implementation for IPFS storage.
 *
 * Implements bounded parallel file downloading with ordered emission,
 * aggregate progress tracking, and error handling modes.
 */

import type { IpfsClient } from './ipfs-client.ts';
import type {
  FileDownloadRef,
  DownloadFilesOptions,
  DownloadedFile,
  MultiDownloadProgress,
} from './types.ts';
import { downloadFile } from './download.ts';
import { ValidationError } from './errors.ts';
import {
  DEFAULT_RETRIES,
  DEFAULT_CHUNK_CONCURRENCY,
  DEFAULT_FILE_CONCURRENCY,
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
 * Create an async iterable that yields a single Uint8Array in chunks.
 */
async function* yieldBufferedContent(
  content: Uint8Array
): AsyncIterable<Uint8Array> {
  // Yield in reasonable chunks for memory efficiency
  const YIELD_CHUNK_SIZE = 64 * 1024; // 64KB chunks
  for (let offset = 0; offset < content.length; offset += YIELD_CHUNK_SIZE) {
    yield content.subarray(offset, Math.min(offset + YIELD_CHUNK_SIZE, content.length));
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * Result of downloading a file with its index.
 */
interface FileResult {
  index: number;
  file: DownloadedFile;
  bytesDownloaded: number;
}

/**
 * Error result for a failed file download.
 */
interface FileError {
  index: number;
  ref: FileDownloadRef;
  error: Error;
}

// ============================================================================
// Main Download Function
// ============================================================================

/**
 * Download multiple files from IPFS with parallel file downloading.
 *
 * Files are downloaded in parallel (up to `concurrency`) and yielded in
 * request order. Each yielded file has its content fully buffered.
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
    concurrency = DEFAULT_FILE_CONCURRENCY,
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

  // ========================================================================
  // Bounded Parallel Download with Ordered Emission
  // ========================================================================

  // Track pending downloads and completed files waiting to be yielded
  const pendingDownloads = new Map<
    number,
    Promise<FileResult | FileError>
  >();
  const buffer = new Map<number, FileResult | FileError>();
  let nextToYield = 0;
  let nextToStart = 0;

  // Per-file abort controllers for fail-fast cancellation
  // Allows aborting specific downloads without affecting others
  const fileAbortControllers = new Map<number, AbortController>();

  /**
   * Get the effective signal for a file download.
   * Combines user signal with per-file abort controller.
   */
  const getFileSignal = (fileIndex: number): AbortSignal => {
    const fileController = new AbortController();
    fileAbortControllers.set(fileIndex, fileController);

    if (signal) {
      // Combine user signal with per-file signal
      return AbortSignal.any([signal, fileController.signal]);
    }
    return fileController.signal;
  };

  /**
   * Abort downloads for files after a given index.
   * Used when error is first detected to stop scheduling files
   * that won't be yielded anyway.
   */
  const abortFilesAfter = (errorIndex: number): void => {
    for (const [index, controller] of fileAbortControllers) {
      if (index > errorIndex && !controller.signal.aborted) {
        controller.abort(new Error('Cancelled due to earlier file error'));
      }
    }
  };

  /**
   * Abort ALL pending downloads immediately.
   * Used when throwing to ensure no downloads continue consuming bandwidth.
   */
  const abortAllPending = (): void => {
    for (const controller of fileAbortControllers.values()) {
      if (!controller.signal.aborted) {
        controller.abort(new Error('Download cancelled due to error'));
      }
    }
  };

  /**
   * Start downloading a file by index.
   */
  const startDownload = (fileIndex: number): void => {
    const ref = refs[fileIndex]!;
    const fileSignal = getFileSignal(fileIndex);

    const promise = (async (): Promise<FileResult | FileError> => {
      try {
        // Track bytes downloaded for this file
        let fileBytesDownloaded = 0;

        // Download the file
        const contentIterable = downloadFile(
          ref,
          {
            retries,
            chunkConcurrency,
            signal: fileSignal,
            integrityMode,
            onIntegrityError,
            onProgress: (progress) => {
              // Update aggregate progress
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

        // Collect all bytes
        const content = await collectBytes(contentIterable);

        return {
          index: fileIndex,
          file: {
            path: ref.path,
            size: ref.size,
            content: yieldBufferedContent(content),
          },
          bytesDownloaded: content.length,
        };
      } catch (error) {
        return {
          index: fileIndex,
          ref,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    })();

    pendingDownloads.set(fileIndex, promise);
  };

  /**
   * Wait for any pending download to complete.
   */
  const waitForAny = async (): Promise<FileResult | FileError> => {
    const promises = Array.from(pendingDownloads.values());
    const result = await Promise.race(promises);
    pendingDownloads.delete(result.index);
    fileAbortControllers.delete(result.index); // Cleanup
    return result;
  };

  /**
   * Check if result is an error.
   */
  const isError = (
    result: FileResult | FileError
  ): result is FileError => {
    return 'error' in result;
  };

  // Track first error for fail-fast mode
  let firstError: FileError | null = null;

  // Start initial batch of downloads
  const initialBatchSize = Math.min(concurrency, totalFiles);
  for (let i = 0; i < initialBatchSize; i++) {
    startDownload(nextToStart++);
  }

  // Main loop: process until all files yielded
  // Wrap in try-catch to ensure pending downloads are settled on abort
  try {
    while (nextToYield < totalFiles) {
      checkAbort(signal);

      // If we have the next file in buffer, process it
      while (buffer.has(nextToYield)) {
        const result = buffer.get(nextToYield)!;
        buffer.delete(nextToYield);

        if (isError(result)) {
          // Handle error
          if (onError) {
            // Report error and continue
            onError(result.error, result.ref);
          } else {
            // Fail fast - record the first error and abort later files
            if (!firstError) {
              firstError = result;
              // Immediately abort downloads for files after this error
              // to stop wasting bandwidth on files that won't be yielded
              abortFilesAfter(firstError.index);
            }
          }
        } else {
          // If we have a pending error in fail-fast mode, throw it now
          // (we've processed all files before this error's position)
          if (firstError && !onError) {
            // Abort ALL pending downloads immediately and throw
            abortAllPending();
            await Promise.allSettled(pendingDownloads.values());
            throw firstError.error;
          }

          // Yield the completed file
          filesCompleted++;
          onProgress?.({
            filesCompleted,
            totalFiles,
            bytesDownloaded,
            totalBytes,
            currentFile:
              nextToYield + 1 < totalFiles
                ? refs[nextToYield + 1]?.path
                : undefined,
          });

          yield result.file;
        }

        nextToYield++;
      }

      // If all files have been yielded, we're done
      if (nextToYield >= totalFiles) {
        break;
      }

      // In fail-fast mode: check if we can throw now
      if (firstError && !onError) {
        // If we've processed all files up to and including the error,
        // we can throw immediately without waiting for later files
        if (nextToYield >= firstError.index) {
          // Abort ALL pending downloads immediately and throw
          abortAllPending();
          await Promise.allSettled(pendingDownloads.values());
          throw firstError.error;
        }
        // Otherwise continue waiting for earlier files to complete
      }

      // Wait for any pending download to complete
      if (pendingDownloads.size > 0) {
        const result = await waitForAny();

        // Store in buffer
        buffer.set(result.index, result);

        // In fail-fast mode, check if this is an error and abort later files
        if (isError(result) && !onError) {
          if (!firstError) {
            firstError = result;
            // Immediately abort downloads for files after this error
            abortFilesAfter(firstError.index);
          }
          // Don't schedule any more downloads
          continue;
        }

        // Start next download if more files remain (only if no error in fail-fast mode)
        if (nextToStart < totalFiles && !firstError) {
          startDownload(nextToStart++);
        }
      }
    }
  } catch (error) {
    // On abort, cancel all pending downloads and wait for them to settle
    // to prevent unhandled promise rejections
    for (const controller of fileAbortControllers.values()) {
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
    }
    if (pendingDownloads.size > 0) {
      await Promise.allSettled(pendingDownloads.values());
    }
    throw error;
  }

  // If we exited the loop with a pending error in fail-fast mode, throw it
  // (this handles the edge case where firstError.index === totalFiles - 1)
  if (firstError && !onError) {
    throw firstError.error;
  }

  // Final progress report
  onProgress?.({
    filesCompleted,
    totalFiles,
    bytesDownloaded,
    totalBytes,
  });
}

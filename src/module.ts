/**
 * IPFS Storage Module Factory
 *
 * Creates an IpfsStorageModule instance with bound IPFS client.
 * This is the main entry point for the public API.
 */

import { ValidationError } from './errors.ts';
import { uploadBatch as uploadBatchImpl } from './upload.ts';
import { getManifest as getManifestImpl } from './manifest-retrieval.ts';
import { downloadFile as downloadFileImpl } from './download.ts';
import { downloadFiles as downloadFilesImpl } from './download-files.ts';
import { CHUNK_SIZE, STREAMING_THRESHOLD } from './constants.ts';
import type { IpfsClient } from './ipfs-client.ts';
import type {
  IpfsStorageConfig,
  IpfsStorageModule,
  ReadOptions,
  FileInput,
  UploadOptions,
  BatchResult,
  FileDownloadRef,
  DownloadOptions,
  DownloadFilesOptions,
  DownloadedFile,
  BatchManifest,
} from './types.ts';

/**
 * Validates the configuration object.
 * @throws ValidationError if config is invalid
 */
function validateConfig(config: IpfsStorageConfig): void {
  if (!config || typeof config !== 'object') {
    throw new ValidationError('Config must be an object');
  }

  if (!config.ipfsClient) {
    throw new ValidationError('ipfsClient is required');
  }

  if (config.chunkSize !== undefined) {
    if (
      typeof config.chunkSize !== 'number' ||
      !Number.isFinite(config.chunkSize) ||
      config.chunkSize <= 0
    ) {
      throw new ValidationError('chunkSize must be a positive number');
    }
  }

  if (config.streamingThreshold !== undefined) {
    if (
      typeof config.streamingThreshold !== 'number' ||
      !Number.isFinite(config.streamingThreshold) ||
      config.streamingThreshold <= 0
    ) {
      throw new ValidationError('streamingThreshold must be a positive number');
    }
  }
}

/**
 * Creates an IPFS storage module instance with bound configuration.
 *
 * @param config - Module configuration with IPFS client and optional settings
 * @returns IpfsStorageModule instance with uploadBatch, getManifest, downloadFile, downloadFiles methods
 * @throws ValidationError if config is invalid
 *
 * @example
 * ```typescript
 * import { createIpfsStorageModule, MockIpfsClient } from '@filemanager/ipfs-storage'
 *
 * const module = createIpfsStorageModule({
 *   ipfsClient: new MockIpfsClient(),
 * })
 *
 * const result = await module.uploadBatch(files, {
 *   senderKeyPair,
 *   recipients: [{ publicKey: recipientPublicKey }],
 * })
 * ```
 */
export function createIpfsStorageModule(
  config: IpfsStorageConfig
): IpfsStorageModule {
  validateConfig(config);

  const ipfsClient: IpfsClient = config.ipfsClient;
  // Store defaults for future use (chunkSize/streamingThreshold not yet wired through)
  const _chunkSize = config.chunkSize ?? CHUNK_SIZE;
  const _streamingThreshold = config.streamingThreshold ?? STREAMING_THRESHOLD;

  // Suppress unused variable warnings - these will be used when chunk size becomes configurable
  void _chunkSize;
  void _streamingThreshold;

  return {
    uploadBatch(
      files: FileInput[],
      options: UploadOptions
    ): Promise<BatchResult> {
      return uploadBatchImpl(files, options, ipfsClient);
    },

    getManifest(batchCid: string, options: ReadOptions): Promise<BatchManifest> {
      return getManifestImpl(batchCid, {
        ipfsClient,
        recipientKeyPair: options.recipientKeyPair,
        expectedSenderPublicKey: options.expectedSenderPublicKey,
        signal: options.signal,
      });
    },

    downloadFile(
      file: FileDownloadRef,
      options?: DownloadOptions
    ): AsyncIterable<Uint8Array> {
      return downloadFileImpl(file, options, ipfsClient);
    },

    downloadFiles(
      files: FileDownloadRef[],
      options?: DownloadFilesOptions
    ): AsyncIterable<DownloadedFile> {
      return downloadFilesImpl(files, options, ipfsClient);
    },
  };
}

/**
 * IPFS Storage Module Factory
 *
 * Creates an IpfsStorageModule instance with bound IPFS client.
 * This is the main entry point for the public API.
 */

import { ValidationError } from './errors.ts';
import { uploadBatch as uploadBatchImpl } from './streaming-upload.ts';
import { getManifest as getManifestImpl } from './manifest-retrieval.ts';
import { downloadFile as downloadFileImpl } from './download.ts';
import { downloadFiles as downloadFilesImpl } from './download-files.ts';
import type { IpfsClient } from './ipfs-client.ts';
import type {
  IpfsStorageConfig,
  IpfsStorageModule,
  ReadOptions,
  StreamingFileInput,
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
 * import { createIpfsStorageModule, MockIpfsClient } from '@0xd49daa/ipfs-storage'
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

  return {
    uploadBatch(
      files: AsyncIterable<StreamingFileInput>,
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

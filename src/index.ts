/**
 * @0xd49daa/ipfs-storage
 *
 * IPFS-based encrypted batch storage module.
 * Provides upload, manifest retrieval, and download functionality.
 */

// =============================================================================
// Module Factory (Primary Entry Point)
// =============================================================================

export { createIpfsStorageModule } from './module.ts';

// =============================================================================
// IPFS Client Abstraction
// =============================================================================

export type { IpfsClient } from './ipfs-client.ts';
export { MockIpfsClient } from './ipfs-client.ts';
export type { MockIpfsClientOptions } from './ipfs-client.ts';

// =============================================================================
// Configuration & Module Types
// =============================================================================

export type {
  IpfsStorageConfig,
  IpfsStorageModule,
  ReadOptions,
} from './types.ts';

// =============================================================================
// Upload Types
// =============================================================================

export type {
  StreamingFileInput,
  DirectoryInput,
  RecipientInfo,
  UploadOptions,
  BatchResult,
  RenamedFile,
  UploadProgress,
  UploadProgressCallback,
  ChunkUploadedCallback,
  ChunkUploadedInfo,
  SubManifestFlushedCallback,
  SubManifestFlushedInfo,
} from './types.ts';

// =============================================================================
// Standalone Upload Function
// =============================================================================

export { uploadBatch } from './streaming-upload.ts';

// =============================================================================
// Utility for Array to AsyncIterable Conversion
// =============================================================================

export { asAsyncIterable } from './async-iterable.ts';

// =============================================================================
// Manifest Types
// =============================================================================

export type {
  BatchManifest,
  FileInfo,
  DirectoryInfo,
  ChunkRef,
} from './types.ts';

export { ChunkEncryption } from './types.ts';

// =============================================================================
// Download Types
// =============================================================================

export type {
  FileDownloadRef,
  DownloadOptions,
  DownloadProgress,
  DownloadProgressCallback,
  DownloadFilesOptions,
  DownloadedFile,
  MultiDownloadProgress,
  MultiDownloadProgressCallback,
  DownloadErrorCallback,
} from './types.ts';

// =============================================================================
// Error Classes
// =============================================================================

export {
  IpfsStorageError,
  ValidationError,
  IntegrityError,
  ManifestError,
  ChunkUnavailableError,
  ChunkUploadError,
  CidMismatchError,
} from './errors.ts';

// =============================================================================
// Re-exported Encryption Types (for convenience)
// =============================================================================

export type {
  SymmetricKey,
  ContentHash,
  X25519PublicKey,
  X25519PrivateKey,
  X25519KeyPair,
} from '@0xd49daa/safecrypt';

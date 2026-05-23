/**
 * @0xd49daa/ipfs-storage
 *
 * IPFS-based encrypted batch storage module.
 * Provides upload, manifest retrieval, and download functionality.
 */

// =============================================================================
// Module Factory (Primary Entry Point)
// =============================================================================

export { createIpfsStorageModule } from "./module.ts";

// =============================================================================
// IPFS Client Abstraction
// =============================================================================

export type { IpfsClient } from "./ipfs-client.ts";
export { MockIpfsClient } from "./ipfs-client.ts";
export type { MockIpfsClientOptions } from "./ipfs-client.ts";

// =============================================================================
// Configuration & Module Types
// =============================================================================

export type {
  IpfsStorageConfig,
  IpfsStorageModule,
  ReadOptions,
} from "./types.ts";

// =============================================================================
// Upload Types
// =============================================================================

export type {
  BatchResult,
  ChunkUploadedCallback,
  ChunkUploadedInfo,
  DirectoryInput,
  RenamedFile,
  StreamingFileInput,
  SubManifestFlushedCallback,
  SubManifestFlushedInfo,
  UploadOptions,
  UploadProgress,
  UploadProgressCallback,
} from "./types.ts";

// =============================================================================
// Standalone Upload Function
// =============================================================================

export { uploadBatch } from "./streaming-upload.ts";
export { getBatchIdFromManifestBlob } from "./manifest-retrieval.ts";

// =============================================================================
// Utility for Array to AsyncIterable Conversion
// =============================================================================

export { asAsyncIterable } from "./async-iterable.ts";

// =============================================================================
// Manifest Types
// =============================================================================

export type {
  BatchManifest,
  ChunkRef,
  DirectoryInfo,
  FileInfo,
} from "./types.ts";

export { ChunkEncryption } from "./types.ts";
export { MANIFEST_VERSION_SUPPORTED } from "./constants.ts";

// =============================================================================
// Download Types
// =============================================================================

export type {
  DownloadedFile,
  DownloadErrorCallback,
  DownloadFilesOptions,
  DownloadOptions,
  DownloadProgress,
  DownloadProgressCallback,
  FileDownloadRef,
  MultiDownloadProgress,
  MultiDownloadProgressCallback,
} from "./types.ts";

// =============================================================================
// Error Classes
// =============================================================================

export {
  ChunkUnavailableError,
  ChunkUploadError,
  CidMismatchError,
  IntegrityError,
  IpfsStorageError,
  ManifestError,
  ValidationError,
} from "./errors.ts";

// =============================================================================
// Re-exported Encryption Types (for convenience)
// =============================================================================

export type { ContentHash, SymmetricKey } from "@0xd49daa/safecrypt";

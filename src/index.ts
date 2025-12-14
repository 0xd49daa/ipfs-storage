// @filemanager/ipfs-storage
// IPFS-based encrypted batch storage module

// Constants
export { DOMAIN, CHUNK_SIZE, STREAMING_THRESHOLD } from './constants.ts';

// Branded types
export type { ChunkId, BatchCid, ChunkCid, FilePath } from './branded.ts';
export { asChunkId, asBatchCid, asChunkCid, asFilePath } from './branded.ts';

// Errors
export {
  IpfsStorageError,
  ValidationError,
  IntegrityError,
  ManifestError,
  ChunkUnavailableError,
  SegmentUploadError,
  CidMismatchError,
  ResumeValidationError,
  AbortUploadError,
} from './errors.ts';

// Re-export encryption types for convenience
export type {
  SymmetricKey,
  ContentHash,
  X25519PublicKey,
  X25519PrivateKey,
} from '@filemanager/encryptionv2';

export type { X25519KeyPair } from '@filemanager/encryptionv2';

// Crypto utilities
export { deriveFileKey } from './crypto.ts';

// Types (Phase 1)
export type {
  ChunkRef,
  FileInfo,
  DirectoryInfo,
  SubManifestIndexEntry,
  RecipientKeyInfo,
  BatchManifest,
  RootManifestData,
  SubManifestData,
  ManifestEnvelopeData,
} from './types.ts';

export { ChunkEncryption } from './types.ts';

// Serialization (Phase 1)
export {
  encodeManifestEnvelope,
  decodeManifestEnvelope,
  encodeRootManifest,
  decodeRootManifest,
  encodeSubManifest,
  decodeSubManifest,
} from './serialization.ts';

// IpfsClient (Phase 2)
export type { IpfsClient, MockIpfsClientOptions } from './ipfs-client.ts';
export {
  MockIpfsClient,
  IpfsUploadError,
  IpfsFetchError,
  computeRawCid,
  computeDagPbCid,
  parseCid,
  formatCid,
} from './ipfs-client.ts';

// Chunk ID utilities (Phase 3)
export { generateChunkId, chunkIdToPath } from './chunk-id.ts';

// Path utilities (Phase 3)
export {
  dirname,
  basename,
  extname,
  isValidPath,
  normalizePath,
} from './path-utils.ts';

// Types (Phase 4)
export type { FileInput } from './types.ts';

// Conflict resolution (Phase 4)
export { resolveConflicts } from './conflicts.ts';

// Types (Phase 5)
export type { DirectoryInput } from './types.ts';

// Directory utilities (Phase 5)
export {
  buildDirectoryTree,
  type BuildDirectoryTreeOptions,
} from './directories.ts';

// PADME padding (Phase 6)
export { padme, padmeWithDetails } from './padme.ts';
export type { PadmeResult } from './padme.ts';

// Chunk planning (Phase 6)
export { planChunks } from './chunk-plan.ts';
export type {
  FileSegment,
  PlannedChunk,
  PlannedChunkRef,
  PlannedFile,
  ChunkPlan,
  PlanChunksOptions,
} from './chunk-plan.ts';

// Encryption constants (Phase 7)
export {
  NONCE_SIZE,
  AUTH_TAG_SIZE,
  SINGLE_SHOT_OVERHEAD,
  STREAM_HEADER_SIZE,
  STREAM_CHUNK_OVERHEAD,
  STREAM_CHUNK_SIZE,
} from './constants.ts';

// Chunk encryption (Phase 7)
export {
  encryptChunk,
  encryptChunks,
  createFileDataProvider,
  computeEncryptedLength,
  decryptSingleShot,
  decryptStreaming,
} from './chunk-encrypt.ts';
export type {
  EncryptedChunk,
  EncryptedSegmentInfo,
  EncryptChunkOptions,
  FileDataProvider,
} from './chunk-encrypt.ts';

// CAR builder (Phase 8)
export { buildBatchDirectory, buildCarSegments } from './car-builder.ts';
export type {
  CarBlock,
  BuildBatchDirectoryOptions,
  BatchDirectoryResult,
  BuildCarSegmentsOptions,
  CarSegmentGenerator,
  CarSegmentsResult,
} from './car-builder.ts';

// Manifest builder (Phase 9)
export type { RecipientInfo } from './types.ts';
export { MANIFEST_DOMAIN } from './constants.ts';
export {
  sortFilesByPath,
  buildManifest,
  encryptManifest,
  buildAndEncryptManifest,
} from './manifest-builder.ts';
export type {
  BuildManifestOptions,
  BuildManifestInput,
  ManifestBuildResult,
  EncryptManifestInput,
  EncryptedManifestResult,
  BuildAndEncryptManifestInput,
} from './manifest-builder.ts';

// Upload orchestration (Phase 10)
export { uploadBatch } from './upload.ts';
export type {
  UploadOptions,
  BatchResult,
  RenamedFile,
  UploadProgressCallback,
  UploadProgress,
  UploadState,
  SegmentState,
  SegmentCompleteCallback,
  SegmentResult,
} from './types.ts';

// Manifest retrieval (Phase 13)
export { getManifest } from './manifest-retrieval.ts';
export type { GetManifestOptions } from './types.ts';

// Download (Phase 14)
export { downloadFile } from './download.ts';
export type {
  FileDownloadRef,
  DownloadOptions,
  DownloadProgressCallback,
  DownloadProgress,
} from './types.ts';

// Multi-file download (Phase 15)
export { downloadFiles } from './download-files.ts';
export type {
  DownloadFilesOptions,
  DownloadedFile,
  MultiDownloadProgressCallback,
  MultiDownloadProgress,
  DownloadErrorCallback,
} from './types.ts';

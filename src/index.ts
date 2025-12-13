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

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

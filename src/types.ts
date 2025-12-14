import type {
  SymmetricKey,
  ContentHash,
  X25519PublicKey,
  X25519KeyPair,
} from '@filemanager/encryptionv2';

// Re-export types from errors.ts for upload state tracking
export type {
  UploadStateForError as UploadState,
  SegmentStateForError as SegmentState,
} from './errors.ts';

// Re-export ChunkEncryption from generated protobuf
export { ChunkEncryption } from './gen/manifest_pb.ts';

/**
 * Input for a file to be uploaded in a batch.
 * The `File` type is the standard Web API File interface.
 */
export interface FileInput {
  /** File object containing the binary data */
  file: File;
  /** Full path in batch (e.g., "/photos/2024/img.jpg") */
  path: string;
  /** BLAKE2b content hash computed by caller */
  contentHash: ContentHash;
  /** Creation timestamp (Unix ms), defaults to Date.now() if not provided */
  created?: number;
}

/**
 * Input for an explicit directory declaration.
 * Used to declare empty directories or override inferred timestamps.
 */
export interface DirectoryInput {
  /** Full path in batch (e.g., "/photos/2024") */
  path: string;
  /** Creation timestamp (Unix ms), uses default if not provided */
  created?: number;
}

/**
 * Reference to a chunk within a file.
 */
export interface ChunkRef {
  /** Unique chunk identifier (base58, 22 chars) */
  chunkId: string;
  /** IPFS CID of the encrypted chunk */
  cid: string;
  /** Byte offset of encrypted segment within chunk (ciphertext position) */
  offset: number;
  /** Original plaintext length (for file size/assembly) */
  length: number;
  /** Encryption method used */
  encryption: import('./gen/manifest_pb.ts').ChunkEncryption;
  /** Actual encrypted segment length in bytes (includes any PADME padding overhead) */
  encryptedLength: number;
}

/**
 * File information in a batch manifest.
 */
export interface FileInfo {
  /** Full path (e.g., "/photos/2024/img.jpg") */
  path: string;
  /** Filename (e.g., "img.jpg") */
  name: string;
  /** Original file size in bytes */
  size: number;
  /** BLAKE2b content hash */
  contentHash: ContentHash;
  /** Chunk references for this file */
  chunks: ChunkRef[];
  /** Creation timestamp (Unix ms) */
  created: number;
}

/**
 * Directory information in a batch manifest.
 */
export interface DirectoryInfo {
  /** Full path (e.g., "/photos/2024") */
  path: string;
  /** Directory name (e.g., "2024") */
  name: string;
  /** Creation timestamp (Unix ms) */
  created: number;
}

/**
 * Sub-manifest index entry for large batches.
 */
export interface SubManifestIndexEntry {
  /** Sub-manifest filename (e.g., "m_0") */
  manifestId: string;
  /** First file path in this sub-manifest */
  startPath: string;
  /** Last file path in this sub-manifest */
  endPath: string;
  /** Number of files in this sub-manifest */
  fileCount: number;
}

/**
 * Recipient key wrapping information.
 */
export interface RecipientKeyInfo {
  /** Recipient's X25519 public key */
  recipientPublicKey: X25519PublicKey;
  /** Nonce used for crypto_box (24 bytes) */
  nonce: Uint8Array;
  /** Encrypted manifest key (48 bytes) */
  ciphertext: Uint8Array;
  /** Sender's X25519 public key */
  senderPublicKey: X25519PublicKey;
  /** Optional device/user label */
  label?: string;
}

/**
 * Decrypted batch manifest.
 */
export interface BatchManifest {
  /** Batch root CID */
  cid: string;
  /** Manifest encryption key */
  manifestKey: SymmetricKey;
  /** Sender's X25519 public key */
  senderPublicKey: X25519PublicKey;
  /** All directories in the batch */
  directories: DirectoryInfo[];
  /** All files in the batch */
  files: FileInfo[];
  /** Batch creation timestamp (Unix ms) */
  created: number;
}

/**
 * Root manifest structure (before encryption).
 */
export interface RootManifestData {
  /** All directories in the batch */
  directories: DirectoryInfo[];
  /** Files in root manifest */
  files: FileInfo[];
  /** Sub-manifest index for large batches */
  subManifests: SubManifestIndexEntry[];
  /** Batch creation timestamp (Unix ms) */
  created: number;
}

/**
 * Sub-manifest structure (before encryption).
 */
export interface SubManifestData {
  /** Files in this sub-manifest */
  files: FileInfo[];
}

/**
 * Manifest envelope (encrypted manifest + recipient keys).
 */
export interface ManifestEnvelopeData {
  /** Encrypted manifest bytes */
  encryptedManifest: Uint8Array;
  /** Recipient key wrapping records */
  recipients: RecipientKeyInfo[];
}

/**
 * Recipient information for upload operations.
 * Used to specify who can decrypt the manifest.
 */
export interface RecipientInfo {
  /** Recipient's X25519 public key */
  publicKey: X25519PublicKey;
  /** Optional device/user label (e.g., "MacBook Pro", "iPhone") */
  label?: string;
}

// ============================================================================
// Upload Types (Phase 10)
// ============================================================================

/**
 * Options for uploadBatch operation.
 */
export interface UploadOptions {
  /** Sender's key pair for authenticated wrapping */
  senderKeyPair: X25519KeyPair;
  /** Recipients who can decrypt the manifest */
  recipients: RecipientInfo[];
  /** Explicit directory declarations (for empty dirs or timestamp overrides) */
  directories?: DirectoryInput[];
  /** Chunks per CAR segment (default: 10) */
  segmentSize?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Resume state from previous upload attempt (Phase 11) */
  resumeState?: import('./errors.ts').UploadStateForError;
  /** Progress callback */
  onProgress?: UploadProgressCallback;
  /** Segment completion callback */
  onSegmentComplete?: SegmentCompleteCallback;
}

/**
 * Result of a successful batch upload.
 */
export interface BatchResult {
  /** Root CID of the uploaded batch */
  cid: string;
  /** Decrypted manifest (for caller storage) */
  manifest: BatchManifest;
  /** Total encrypted size in bytes */
  totalSize: number;
  /** Number of chunks in the batch */
  chunkCount: number;
  /** Number of manifests (1 root + N sub-manifests) */
  manifestCount: number;
  /** Number of CAR segments uploaded */
  segmentsUploaded: number;
  /** Files that were renamed due to conflicts */
  renamed?: RenamedFile[];
}

/**
 * Record of a file that was renamed due to path conflict.
 */
export interface RenamedFile {
  /** Original path from FileInput */
  originalPath: string;
  /** Resolved path after conflict resolution */
  newPath: string;
}

/**
 * Upload progress callback type.
 */
export type UploadProgressCallback = (progress: UploadProgress) => void;

/**
 * Upload progress information.
 */
export interface UploadProgress {
  /** Current phase of upload */
  phase: 'planning' | 'encrypting' | 'building' | 'uploading' | 'finalizing';
  /** Files processed so far */
  filesProcessed: number;
  /** Total files in batch */
  totalFiles: number;
  /** Bytes processed so far (ciphertext bytes) */
  bytesProcessed: number;
  /** Total bytes to process (plaintext size) */
  totalBytes: number;
  /** Current segment being uploaded (1-indexed, during 'uploading' phase) */
  currentSegment?: number;
  /** Total segments to upload */
  totalSegments?: number;
  /** Chunks skipped due to resume (Phase 11, always 0 in Phase 10) */
  chunksSkipped?: number;
}

/**
 * Segment completion callback type.
 */
export type SegmentCompleteCallback = (result: SegmentResult) => void;

/**
 * Result of a segment upload completion.
 */
export interface SegmentResult {
  /** Segment index that completed (0-based) */
  index: number;
  /** Chunks uploaded in this segment */
  chunksUploaded: number;
  /** Chunks skipped (Phase 11, always 0 in Phase 10) */
  chunksSkipped: number;
  /** Total segments in batch */
  totalSegments: number;
  /** Current upload state for persistence */
  state: import('./errors.ts').UploadStateForError;
}

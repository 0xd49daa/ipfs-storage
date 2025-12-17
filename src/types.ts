import type {
  SymmetricKey,
  ContentHash,
  X25519PublicKey,
  X25519KeyPair,
} from '@0xd49daa/safecrypt';

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
  /**
   * AbortSignal for cancellation.
   *
   * Abort behavior by phase:
   * - **Before upload state exists** (planning, encryption): throws `DOMException` with name `'AbortError'`
   * - **After upload state exists** (during upload): throws `AbortUploadError` with `state` for resume
   * - Current segment always completes before abort takes effect
   *
   * If the signal has a custom `reason`, it is preserved in the error message and
   * (for `AbortUploadError`) in the `reason` property.
   */
  signal?: AbortSignal;
  /**
   * Resume state from previous upload attempt.
   * When provided, the manifestKey is reused to ensure consistent file key derivation.
   *
   * **Important**: All segments are always re-uploaded because encryption uses random
   * nonces, making CIDs non-deterministic. The resume state ensures the same manifestKey
   * is used, so file keys remain consistent and previously-downloaded files can still
   * be decrypted with keys derived from the new upload's manifest.
   *
   * Segment count must match (throws ResumeValidationError if files changed).
   */
  resumeState?: import('./errors.ts').UploadStateForError;
  /**
   * @deprecated This option has no effect. Previously intended to verify segments
   * exist via ipfsClient.has(), but since all segments are always re-uploaded
   * (due to non-deterministic encryption), verification is unnecessary.
   */
  verifyResumeState?: boolean;
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
  /** Total encrypted bytes uploaded */
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
  /**
   * @deprecated Always 0. Previously indicated chunks skipped due to resume,
   * but all segments are now always re-uploaded.
   */
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
  /**
   * @deprecated Always 0. Previously indicated chunks skipped due to resume,
   * but all segments are now always re-uploaded.
   */
  chunksSkipped: number;
  /** Total segments in batch */
  totalSegments: number;
  /** Current upload state for persistence */
  state: import('./errors.ts').UploadStateForError;
}

// ============================================================================
// Manifest Retrieval Types (Phase 13)
// ============================================================================

/**
 * Options for manifest retrieval.
 */
export interface GetManifestOptions {
  /** IPFS client for content retrieval */
  ipfsClient: import('./ipfs-client.ts').IpfsClient;
  /** Recipient's key pair for unwrapping the manifest key */
  recipientKeyPair: X25519KeyPair;
  /**
   * Expected sender's public key for authenticated unwrapping.
   * Required per spec - must match the senderPublicKey in the recipient record.
   * Prevents swapped-sender attacks where an attacker replaces the sender key in the envelope.
   */
  expectedSenderPublicKey: X25519PublicKey;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

// ============================================================================
// Download Types (Phase 14)
// ============================================================================

/**
 * Reference for downloading a single file.
 * Construct from BatchManifest fields after calling getManifest().
 */
export interface FileDownloadRef {
  /** Batch root CID */
  batchCid: string;
  /** File path (for error messages) */
  path: string;
  /** Original file size in bytes */
  size: number;
  /** BLAKE2b content hash for key derivation and verification */
  contentHash: ContentHash;
  /** Manifest key for deriving file encryption key */
  manifestKey: SymmetricKey;
  /** Chunk references for this file */
  chunks: ChunkRef[];
}

/**
 * Options for single file download.
 * Matches spec exactly - ipfsClient is passed as separate param to downloadFile().
 */
export interface DownloadOptions {
  /** Retry attempts per chunk (default: 3) */
  retries?: number;
  /** Parallel chunk fetch concurrency (default: 3) */
  chunkConcurrency?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Progress callback */
  onProgress?: DownloadProgressCallback;
  /** Integrity verification mode (default: 'strict') */
  integrityMode?: 'strict' | 'warn';
  /** Callback for integrity errors in 'warn' mode */
  onIntegrityError?: (error: import('./errors.ts').IntegrityError) => void;
}

/**
 * Download progress callback type.
 */
export type DownloadProgressCallback = (progress: DownloadProgress) => void;

/**
 * Download progress information.
 */
export interface DownloadProgress {
  /** Decrypted bytes yielded so far */
  bytesDownloaded: number;
  /** Total file size */
  totalBytes: number;
}

// ============================================================================
// Multi-File Download Types (Phase 15)
// ============================================================================

/**
 * Options for multi-file download.
 */
export interface DownloadFilesOptions {
  /**
   * @deprecated Ignored. Downloads are sequential to bound memory usage.
   * Chunk-level parallelism (chunkConcurrency) is still supported.
   */
  concurrency?: number;
  /** Parallel chunk fetch per file (default: 3) */
  chunkConcurrency?: number;
  /** Retry attempts per chunk (default: 3) */
  retries?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Progress callback for aggregate progress */
  onProgress?: MultiDownloadProgressCallback;
  /**
   * Error callback for handling per-file errors.
   * If provided, errors are reported but download continues.
   * If not provided, first error throws and aborts remaining downloads.
   */
  onError?: DownloadErrorCallback;
  /** Integrity verification mode (default: 'strict') */
  integrityMode?: 'strict' | 'warn';
  /** Callback for integrity errors in 'warn' mode */
  onIntegrityError?: (error: import('./errors.ts').IntegrityError) => void;
}

/**
 * Result of downloading a single file from a batch.
 */
export interface DownloadedFile {
  /** File path */
  path: string;
  /** Original file size in bytes */
  size: number;
  /** Decrypted file content as async iterable */
  content: AsyncIterable<Uint8Array>;
}

/**
 * Multi-file download progress callback type.
 */
export type MultiDownloadProgressCallback = (
  progress: MultiDownloadProgress
) => void;

/**
 * Multi-file download progress information.
 */
export interface MultiDownloadProgress {
  /** Number of files completely downloaded */
  filesCompleted: number;
  /** Total number of files to download */
  totalFiles: number;
  /** Total bytes downloaded across all files */
  bytesDownloaded: number;
  /** Total bytes to download across all files */
  totalBytes: number;
  /** Path of file currently being downloaded (if any) */
  currentFile?: string;
}

/**
 * Error callback type for multi-file download.
 * Called when a file fails; download continues if provided.
 */
export type DownloadErrorCallback = (
  error: Error,
  file: FileDownloadRef
) => void;

// ============================================================================
// Module Factory Types (Phase 17)
// ============================================================================

/**
 * Configuration for creating an IPFS storage module instance.
 */
export interface IpfsStorageConfig {
  /** IPFS client for upload/download operations */
  ipfsClient: import('./ipfs-client.ts').IpfsClient;
}

/**
 * Options for manifest retrieval via module.getManifest().
 * Unlike GetManifestOptions, ipfsClient is bound to the module.
 */
export interface ReadOptions {
  /** Recipient's key pair for unwrapping the manifest key */
  recipientKeyPair: X25519KeyPair;
  /**
   * Expected sender's public key for authenticated unwrapping.
   * Must match the senderPublicKey in the manifest envelope.
   */
  expectedSenderPublicKey: X25519PublicKey;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

/**
 * IPFS storage module with bound IPFS client.
 * Created via createIpfsStorageModule().
 */
export interface IpfsStorageModule {
  /**
   * Upload a batch of files to IPFS with encryption.
   * @param files - Files to upload
   * @param options - Upload options (sender key, recipients, etc.)
   * @returns Batch result with CID and manifest
   */
  uploadBatch(files: FileInput[], options: UploadOptions): Promise<BatchResult>;

  /**
   * Retrieve and decrypt a batch manifest from IPFS.
   * @param batchCid - Root CID of the batch
   * @param options - Read options (recipient key pair, expected sender)
   * @returns Decrypted batch manifest
   */
  getManifest(batchCid: string, options: ReadOptions): Promise<BatchManifest>;

  /**
   * Download and decrypt a single file from a batch.
   * @param file - File download reference (from manifest)
   * @param options - Download options (retries, concurrency, etc.)
   * @returns Async iterable of decrypted file chunks
   */
  downloadFile(
    file: FileDownloadRef,
    options?: DownloadOptions
  ): AsyncIterable<Uint8Array>;

  /**
   * Download and decrypt multiple files from a batch.
   * @param files - File download references (from manifest)
   * @param options - Download options (concurrency, error handling, etc.)
   * @returns Async iterable of downloaded files
   */
  downloadFiles(
    files: FileDownloadRef[],
    options?: DownloadFilesOptions
  ): AsyncIterable<DownloadedFile>;
}

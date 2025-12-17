import type {
  SymmetricKey,
  ContentHash,
  X25519PublicKey,
  X25519KeyPair,
} from '@0xd49daa/safecrypt';

// Re-export ChunkEncryption from generated protobuf
export { ChunkEncryption } from './gen/manifest_pb.ts';

/**
 * Input for a file to be uploaded in a batch.
 *
 * Uses a lazy getStream() callback that is only called when
 * the file's turn comes to be processed.
 *
 * This enables:
 * - Processing files from lazy AsyncIterables
 * - Minimal memory usage (~12MB peak regardless of batch size)
 * - Efficient handling of both many small files and large files
 */
export interface StreamingFileInput {
  /** Full path in batch (e.g., "/photos/2024/img.jpg") */
  path: string;
  /** BLAKE2b content hash computed by caller */
  contentHash: ContentHash;
  /** File size in bytes (required for chunk planning) */
  size: number;
  /** Creation timestamp (Unix ms), defaults to Date.now() if not provided */
  created?: number;
  /**
   * Returns a fresh stream of file content.
   * Called when the file's turn comes to be processed.
   * May be called multiple times (e.g., on retry).
   *
   * @returns ReadableStream for browser environments, AsyncIterable for Node/Bun
   */
  getStream: () => ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
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
  /**
   * AbortSignal for cancellation.
   *
   * Abort behavior:
   * - Before any chunks uploaded: throws `DOMException` with name `'AbortError'`
   * - During upload: throws `DOMException` with name `'AbortError'`
   * - Current chunk upload completes before abort takes effect
   */
  signal?: AbortSignal;
  /** Retry attempts per chunk upload (default: 3) */
  uploadRetries?: number;
  /** Progress callback - called during file processing and finalization */
  onProgress?: UploadProgressCallback;
  /**
   * Called when a chunk is uploaded.
   * Useful for progress tracking.
   */
  onChunkUploaded?: ChunkUploadedCallback;
  /**
   * Called when a sub-manifest is flushed and uploaded.
   * This happens incrementally when accumulated file entries exceed ~1MB.
   */
  onSubManifestFlushed?: SubManifestFlushedCallback;
}

/**
 * Callback type for chunk upload completion.
 */
export type ChunkUploadedCallback = (info: ChunkUploadedInfo) => void;

/**
 * Information about an uploaded chunk.
 */
export interface ChunkUploadedInfo {
  /** Unique chunk identifier */
  chunkId: string;
  /** CID of the uploaded chunk */
  cid: string;
  /** Encrypted size in bytes */
  encryptedSize: number;
}

/**
 * Callback type for sub-manifest flush completion.
 */
export type SubManifestFlushedCallback = (info: SubManifestFlushedInfo) => void;

/**
 * Information about a flushed sub-manifest.
 */
export interface SubManifestFlushedInfo {
  /** Sub-manifest index (0-based) */
  index: number;
  /** CID of the uploaded sub-manifest */
  cid: string;
  /** Number of files in this sub-manifest */
  fileCount: number;
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
 *
 * For streaming uploads, totalFiles and totalBytes may be undefined
 * if the input is a true lazy AsyncIterable where totals are unknown.
 */
export interface UploadProgress {
  /** Current phase of upload */
  phase: 'processing' | 'finalizing';
  /** Files processed so far */
  filesProcessed: number;
  /** Total files in batch (undefined for true streaming where unknown) */
  totalFiles?: number;
  /** Bytes processed so far (plaintext bytes) */
  bytesProcessed: number;
  /** Total bytes to process (undefined for true streaming) */
  totalBytes?: number;
  /** Chunks uploaded so far */
  chunksUploaded: number;
  /** Sub-manifests flushed so far */
  subManifestsFlushed: number;
  /** Current file being processed (if any) */
  currentFile?: {
    path: string;
    size: number;
    bytesRead: number;
  };
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
   *
   * Uses streaming processing for memory efficiency:
   * - Files are processed lazily from the AsyncIterable
   * - Small files are aggregated into ~10MB chunks
   * - Large files stream through ~10MB dedicated chunks
   * - Sub-manifests are flushed incrementally (~1MB threshold)
   * - Peak memory usage: ~12MB regardless of batch size
   *
   * @param files - Async iterable of files to upload
   * @param options - Upload options (sender key, recipients, etc.)
   * @returns Batch result with CID and manifest
   */
  uploadBatch(
    files: AsyncIterable<StreamingFileInput>,
    options: UploadOptions
  ): Promise<BatchResult>;

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

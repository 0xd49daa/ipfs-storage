# API Reference

Complete API documentation for `@0xd49daa/ipfs-storage`.

## Table of Contents

- [Module Factory](#module-factory)
- [Upload API](#upload-api)
- [Manifest API](#manifest-api)
- [Download API](#download-api)
- [Error Classes](#error-classes)
- [Types Reference](#types-reference)
- [Re-exported Types](#re-exported-types)

---

## Module Factory

### createIpfsStorageModule(config)

Creates an IPFS storage module instance with bound configuration.

```typescript
function createIpfsStorageModule(config: IpfsStorageConfig): IpfsStorageModule
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `config` | `IpfsStorageConfig` | Module configuration |

**Returns:** `IpfsStorageModule` — Module instance with bound methods

**Throws:** `ValidationError` if config is invalid

**Example:**

```typescript
import { createIpfsStorageModule, MockIpfsClient } from '@0xd49daa/ipfs-storage';

const module = createIpfsStorageModule({
  ipfsClient: new MockIpfsClient(),
});
```

### IpfsStorageConfig

Configuration for creating a module instance.

```typescript
interface IpfsStorageConfig {
  ipfsClient: IpfsClient;     // Required: IPFS client for upload/download
}
```

### IpfsStorageModule

Module interface with bound IPFS client.

```typescript
interface IpfsStorageModule {
  uploadBatch(files: FileInput[], options: UploadOptions): Promise<BatchResult>;
  getManifest(batchCid: string, options: ReadOptions): Promise<BatchManifest>;
  downloadFile(file: FileDownloadRef, options?: DownloadOptions): AsyncIterable<Uint8Array>;
  downloadFiles(files: FileDownloadRef[], options?: DownloadFilesOptions): AsyncIterable<DownloadedFile>;
}
```

---

## Upload API

### uploadBatch(files, options)

Upload a batch of files to IPFS with encryption.

```typescript
uploadBatch(files: FileInput[], options: UploadOptions): Promise<BatchResult>
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `files` | `FileInput[]` | Files to upload (non-empty) |
| `options` | `UploadOptions` | Upload configuration |

**Returns:** `Promise<BatchResult>` — Upload result with CID and manifest

**Throws:**
- `ValidationError` — Empty batch, invalid paths, no recipients
- `SegmentUploadError` — Segment upload failed (includes resume state)
- `AbortUploadError` — Upload aborted via signal (includes resume state)

### FileInput

Input for a file to be uploaded.

```typescript
interface FileInput {
  file: File;           // File object containing binary data
  path: string;         // Full path in batch (e.g., "/photos/2024/img.jpg")
  contentHash: ContentHash; // BLAKE2b content hash computed by caller
  created?: number;     // Creation timestamp (Unix ms), defaults to Date.now()
}
```

### DirectoryInput

Input for explicit directory declaration.

```typescript
interface DirectoryInput {
  path: string;     // Full path in batch (e.g., "/photos/2024")
  created?: number; // Creation timestamp (Unix ms)
}
```

### UploadOptions

Options for upload operation.

```typescript
interface UploadOptions {
  senderKeyPair: X25519KeyPair;      // Sender's key pair for authenticated wrapping
  recipients: RecipientInfo[];        // Recipients who can decrypt (non-empty)
  directories?: DirectoryInput[];     // Explicit directory declarations
  segmentSize?: number;               // Chunks per CAR segment (default: 10)
  signal?: AbortSignal;               // Cancellation signal
  resumeState?: UploadState;          // Resume from previous attempt
  onProgress?: UploadProgressCallback;     // Progress callback
  onSegmentComplete?: SegmentCompleteCallback; // Segment completion callback
}
```

**Abort Behavior:**
- Before upload state exists: throws `DOMException` with name `'AbortError'`
- After upload state exists: throws `AbortUploadError` with `state` for resume
- Current segment always completes before abort takes effect

### RecipientInfo

Recipient information for upload.

```typescript
interface RecipientInfo {
  publicKey: X25519PublicKey; // Recipient's X25519 public key
  label?: string;             // Optional device/user label (e.g., "MacBook Pro")
}
```

### BatchResult

Result of successful upload.

```typescript
interface BatchResult {
  cid: string;                // Root CID of uploaded batch
  manifest: BatchManifest;    // Decrypted manifest (for caller storage)
  totalSize: number;          // Total encrypted bytes uploaded
  chunkCount: number;         // Number of chunks in batch
  manifestCount: number;      // Number of manifests (1 root + N sub-manifests)
  segmentsUploaded: number;   // Number of CAR segments uploaded
  renamed?: RenamedFile[];    // Files renamed due to conflicts
}
```

### UploadProgress

Progress information during upload.

```typescript
interface UploadProgress {
  phase: 'planning' | 'encrypting' | 'building' | 'uploading' | 'finalizing';
  filesProcessed: number;     // Files processed so far
  totalFiles: number;         // Total files in batch
  bytesProcessed: number;     // Ciphertext bytes processed
  totalBytes: number;         // Total plaintext size
  currentSegment?: number;    // Current segment (1-indexed, during 'uploading')
  totalSegments?: number;     // Total segments
}
```

### UploadState

State for resuming uploads (from `SegmentUploadError` or `AbortUploadError`).

```typescript
interface UploadState {
  batchId: string;                // Unique batch identifier
  segments: SegmentState[];       // Per-segment status
  manifestKeyBase64: string;      // Base64-encoded manifest key (for JSON serialization)
  chunkCids: Record<string, string>; // Mapping of chunk IDs to CIDs
  created?: number;               // Batch creation timestamp
}

interface SegmentState {
  index: number;                  // Segment index (0-based)
  status: 'pending' | 'uploading' | 'complete';
}
```

---

## Manifest API

### getManifest(batchCid, options)

Retrieve and decrypt a batch manifest.

```typescript
getManifest(batchCid: string, options: ReadOptions): Promise<BatchManifest>
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `batchCid` | `string` | Root CID of the batch |
| `options` | `ReadOptions` | Retrieval options |

**Returns:** `Promise<BatchManifest>` — Decrypted manifest

**Throws:**
- `ValidationError` — Empty or invalid batch CID
- `ManifestError` — Cannot fetch, parse, or decrypt manifest; sender mismatch

### ReadOptions

Options for manifest retrieval.

```typescript
interface ReadOptions {
  recipientKeyPair: X25519KeyPair;         // Recipient's key pair for unwrapping
  expectedSenderPublicKey: X25519PublicKey; // Required sender verification
  signal?: AbortSignal;                     // Cancellation signal
}
```

### BatchManifest

Decrypted batch manifest.

```typescript
interface BatchManifest {
  cid: string;                    // Batch root CID
  manifestKey: SymmetricKey;      // Manifest encryption key (for file key derivation)
  senderPublicKey: X25519PublicKey; // Sender's public key
  directories: DirectoryInfo[];   // All directories in batch
  files: FileInfo[];              // All files in batch
  created: number;                // Batch creation timestamp (Unix ms)
}
```

### FileInfo

File information in manifest.

```typescript
interface FileInfo {
  path: string;           // Full path (e.g., "/photos/2024/img.jpg")
  name: string;           // Filename (e.g., "img.jpg")
  size: number;           // Original file size in bytes
  contentHash: ContentHash; // BLAKE2b content hash
  chunks: ChunkRef[];     // Chunk references for this file
  created: number;        // Creation timestamp (Unix ms)
}
```

### DirectoryInfo

Directory information in manifest.

```typescript
interface DirectoryInfo {
  path: string;   // Full path (e.g., "/photos/2024")
  name: string;   // Directory name (e.g., "2024")
  created: number; // Creation timestamp (Unix ms)
}
```

### ChunkRef

Reference to a chunk within a file.

```typescript
interface ChunkRef {
  chunkId: string;        // Unique chunk identifier (base58, 22 chars)
  cid: string;            // IPFS CID of encrypted chunk
  offset: number;         // Byte offset of encrypted segment within chunk
  length: number;         // Original plaintext length
  encryption: ChunkEncryption; // Encryption method (SINGLE_SHOT or STREAMING)
  encryptedLength: number; // Actual encrypted segment length (includes padding)
}
```

---

## Download API

### downloadFile(file, options?)

Download and decrypt a single file.

```typescript
downloadFile(file: FileDownloadRef, options?: DownloadOptions): AsyncIterable<Uint8Array>
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `file` | `FileDownloadRef` | File download reference |
| `options` | `DownloadOptions` | Optional download configuration |

**Returns:** `AsyncIterable<Uint8Array>` — Decrypted file chunks

**Throws:**
- `ValidationError` — Invalid file reference
- `ChunkUnavailableError` — Chunk fetch failed after retries
- `IntegrityError` — Content hash mismatch (in strict mode)

### downloadFiles(files, options?)

Download and decrypt multiple files sequentially (one at a time to bound memory usage).

```typescript
downloadFiles(files: FileDownloadRef[], options?: DownloadFilesOptions): AsyncIterable<DownloadedFile>
```

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `files` | `FileDownloadRef[]` | File download references |
| `options` | `DownloadFilesOptions` | Optional download configuration |

**Returns:** `AsyncIterable<DownloadedFile>` — Downloaded files (in request order)

**Throws:**
- `ValidationError` — Empty files array
- First file error (if no `onError` callback provided)

### FileDownloadRef

Reference for downloading a file (construct from `BatchManifest`).

```typescript
interface FileDownloadRef {
  batchCid: string;           // Batch root CID
  path: string;               // File path (for error messages)
  size: number;               // Original file size in bytes
  contentHash: ContentHash;   // BLAKE2b content hash
  manifestKey: SymmetricKey;  // Manifest key for file key derivation
  chunks: ChunkRef[];         // Chunk references for this file
}
```

### DownloadOptions

Options for single file download.

```typescript
interface DownloadOptions {
  retries?: number;           // Retry attempts per chunk (default: 3)
  chunkConcurrency?: number;  // Parallel chunk fetch (default: 3)
  signal?: AbortSignal;       // Cancellation signal
  onProgress?: DownloadProgressCallback; // Progress callback
  integrityMode?: 'strict' | 'warn';     // Verification mode (default: 'strict')
  onIntegrityError?: (error: IntegrityError) => void; // Warn mode callback
}
```

### DownloadFilesOptions

Options for multi-file download.

```typescript
interface DownloadFilesOptions {
  concurrency?: number;       // DEPRECATED: ignored (downloads are sequential)
  chunkConcurrency?: number;  // Parallel chunk fetch per file (default: 3)
  retries?: number;           // Retry attempts per chunk (default: 3)
  signal?: AbortSignal;       // Cancellation signal
  onProgress?: MultiDownloadProgressCallback; // Aggregate progress callback
  onError?: DownloadErrorCallback;            // Error callback (continue on error)
  integrityMode?: 'strict' | 'warn';
  onIntegrityError?: (error: IntegrityError) => void;
}
```

### DownloadedFile

Result of downloading a file.

```typescript
interface DownloadedFile {
  path: string;                   // File path
  size: number;                   // Original file size in bytes
  content: AsyncIterable<Uint8Array>; // Decrypted content
}
```

### DownloadProgress

Single file download progress.

```typescript
interface DownloadProgress {
  bytesDownloaded: number; // Decrypted bytes yielded so far
  totalBytes: number;      // Total file size
}
```

### MultiDownloadProgress

Multi-file download aggregate progress.

```typescript
interface MultiDownloadProgress {
  filesCompleted: number;   // Files completely downloaded
  totalFiles: number;       // Total files to download
  bytesDownloaded: number;  // Total bytes across all files
  totalBytes: number;       // Total bytes to download
  currentFile?: string;     // Path of file currently downloading
}
```

---

## Error Classes

All errors extend `IpfsStorageError`:

```
IpfsStorageError (base)
├── ValidationError        — Invalid input
├── IntegrityError         — Content hash mismatch
├── ManifestError          — Manifest retrieval/decryption failure
├── ChunkUnavailableError  — Chunk fetch failed
├── SegmentUploadError     — Segment upload failed
├── AbortUploadError       — Upload aborted via signal
├── ResumeValidationError  — Invalid resume state
└── CidMismatchError       — CID verification failed
```

### IpfsStorageError

Base error class for all package errors.

```typescript
class IpfsStorageError extends Error {
  readonly name: string;
}
```

### ValidationError

Thrown for invalid input.

```typescript
class ValidationError extends IpfsStorageError {}
```

**When thrown:**
- Empty files array
- Empty recipients array
- Invalid file path format
- Invalid configuration values

### IntegrityError

Thrown when content hash doesn't match.

```typescript
class IntegrityError extends IpfsStorageError {
  readonly expected: ContentHash;
  readonly actual: ContentHash;
  readonly path: string;
}
```

### ManifestError

Thrown for manifest retrieval/decryption failures.

```typescript
class ManifestError extends IpfsStorageError {
  readonly batchCid: string;
}
```

**When thrown:**
- Manifest not found at `/m`
- Cannot parse protobuf
- No matching recipient
- Sender public key mismatch
- Decryption failure

### ChunkUnavailableError

Thrown when chunk cannot be fetched after retries.

```typescript
class ChunkUnavailableError extends IpfsStorageError {
  readonly chunkId: string;
  readonly batchCid: string;
}
```

### SegmentUploadError

Thrown when segment upload fails. Contains state for resume.

```typescript
class SegmentUploadError extends IpfsStorageError {
  readonly state: UploadState;
  readonly segmentIndex: number;
  readonly cause?: Error;
}
```

### AbortUploadError

Thrown when upload is aborted via signal. Contains state for resume.

```typescript
class AbortUploadError extends IpfsStorageError {
  readonly state: UploadState;
  readonly reason?: unknown;
  readonly cause?: Error;
}
```

### ResumeValidationError

Thrown for invalid resume state structure.

```typescript
class ResumeValidationError extends IpfsStorageError {
  readonly field: string;
}
```

**When thrown:**
- Missing required fields
- Invalid base64 manifest key
- Wrong key length
- Segment count mismatch

### CidMismatchError

Thrown when CID verification fails.

```typescript
class CidMismatchError extends IpfsStorageError {
  readonly expected: string;
  readonly actual: string;
}
```

---

## Types Reference

### ChunkEncryption

Encryption method enum.

```typescript
enum ChunkEncryption {
  SINGLE_SHOT = 0,  // Single-shot encryption (≤10MB chunks)
  STREAMING = 1,    // Streaming encryption (>10MB chunks)
}
```

### Callback Types

```typescript
type UploadProgressCallback = (progress: UploadProgress) => void;
type SegmentCompleteCallback = (result: SegmentResult) => void;
type DownloadProgressCallback = (progress: DownloadProgress) => void;
type MultiDownloadProgressCallback = (progress: MultiDownloadProgress) => void;
type DownloadErrorCallback = (error: Error, file: FileDownloadRef) => void;
```

---

## Re-exported Types

The following types are re-exported from `@0xd49daa/safecrypt` for convenience:

```typescript
export type {
  SymmetricKey,      // 32-byte symmetric encryption key
  ContentHash,       // 32-byte BLAKE2b content hash
  X25519PublicKey,   // 32-byte X25519 public key
  X25519PrivateKey,  // 32-byte X25519 private key
  X25519KeyPair,     // Public/private key pair
} from '@0xd49daa/safecrypt';
```

---

## IpfsClient Interface

Interface for IPFS client implementations.

```typescript
interface IpfsClient {
  /**
   * Upload a CAR file. Must be atomic - all blocks stored or none.
   */
  uploadCar(car: Uint8Array): Promise<string>;

  /**
   * Retrieve content by CID, optionally with path.
   * @param cid - Root CID
   * @param path - Optional path within UnixFS directory (e.g., "/m", "/6B/v7/abc123")
   */
  cat(cid: string, path?: string): AsyncIterable<Uint8Array>;

  /**
   * Check if a CID exists.
   */
  has(cid: string): Promise<boolean>;
}
```

### MockIpfsClient

In-memory mock implementation for testing.

```typescript
class MockIpfsClient implements IpfsClient {
  constructor(options?: MockIpfsClientOptions);

  // IpfsClient methods
  uploadCar(car: Uint8Array): Promise<string>;
  cat(cid: string, path?: string): AsyncIterable<Uint8Array>;
  has(cid: string): Promise<boolean>;

  // Test helpers
  clear(): void;                              // Reset all state
  getBlock(cid: string): Uint8Array | undefined; // Get raw block
  getBlockCount(): number;                    // Count stored blocks
  isRoot(cid: string): boolean;               // Check if CID is a root
  setFailNextUpload(error: Error): void;      // Simulate upload failure
  clearFailNextUpload(): void;                // Clear failure simulation
  setUploadLatch(signal: AbortSignal): Promise<void>; // Pause upload (for testing)
  clearUploadLatch(): void;                   // Release upload latch
}
```

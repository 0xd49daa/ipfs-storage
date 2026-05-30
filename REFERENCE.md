# API Reference

Complete API documentation for `@0xd49daa/ipfs-storage` `0.2.0`.

The package is symmetric-only. It does not expose recipient lists, sender key
pairs, X25519 keys, or key wrapping APIs. Callers provide `manifestKey` for
upload, manifest retrieval, and download. Upload also requires a 16-byte
`batch_id`.

## Table of Contents

- [Module Factory](#module-factory)
- [Upload API](#upload-api)
- [Manifest API](#manifest-api)
- [Download API](#download-api)
- [Wire Format](#wire-format)
- [Error Classes](#error-classes)
- [Types Reference](#types-reference)
- [Re-exported Types](#re-exported-types)
- [IpfsClient Interface](#ipfsclient-interface)
- [Kubo RPC Client](#kubo-rpc-client)

---

## Module Factory

### createIpfsStorageModule(config)

Creates an IPFS storage module instance with a bound IPFS client.

```typescript
function createIpfsStorageModule(config: IpfsStorageConfig): IpfsStorageModule;
```

Parameters:

| Name     | Type                | Description          |
| -------- | ------------------- | -------------------- |
| `config` | `IpfsStorageConfig` | Module configuration |

Returns: `IpfsStorageModule`.

Throws: `ValidationError` if `config` is invalid.

```typescript
import {
  createIpfsStorageModule,
  MockIpfsClient,
} from "@0xd49daa/ipfs-storage";

const storage = createIpfsStorageModule({
  ipfsClient: new MockIpfsClient(),
});
```

### IpfsStorageConfig

```typescript
interface IpfsStorageConfig {
  ipfsClient: IpfsClient;
}
```

### IpfsStorageModule

```typescript
interface IpfsStorageModule {
  uploadBatch(
    files: AsyncIterable<StreamingFileInput>,
    options: UploadOptions,
  ): Promise<BatchResult>;

  getManifest(batchCid: string, options: ReadOptions): Promise<BatchManifest>;

  downloadFile(
    file: FileDownloadRef,
    options: DownloadOptions & { output: WritableStream<Uint8Array> },
  ): Promise<void>;

  downloadFile(
    file: FileDownloadRef,
    options: DownloadOptions & { output: "memory" },
  ): Promise<Uint8Array>;

  downloadFile(
    file: FileDownloadRef,
    options: DownloadOptions & { output?: undefined },
  ): AsyncIterable<Uint8Array>;

  downloadFiles(
    files: FileDownloadRef[],
    options: DownloadFilesOptions,
  ): AsyncIterable<DownloadedFile>;
}
```

---

## Upload API

### uploadBatch(files, options)

Uploads a batch of files to IPFS with Vault-compatible symmetric encryption.

```typescript
function uploadBatch(
  files: AsyncIterable<StreamingFileInput>,
  options: UploadOptions,
  ipfsClient: IpfsClient,
): Promise<BatchResult>;
```

Most consumers call `module.uploadBatch(files, options)` so `ipfsClient` is
bound by `createIpfsStorageModule()`.

Parameters:

| Name      | Type                                | Description          |
| --------- | ----------------------------------- | -------------------- |
| `files`   | `AsyncIterable<StreamingFileInput>` | Files to upload      |
| `options` | `UploadOptions`                     | Upload configuration |

Returns: `Promise<BatchResult>`.

Throws: `ValidationError` for invalid options, empty input, invalid paths, or
invalid file metadata.

### StreamingFileInput

Input for a file to upload. `getStream()` must return a fresh stream each time
it is called because retries may re-read a file.

```typescript
interface StreamingFileInput {
  path: string;
  contentHash: ContentHash;
  size: number;
  created?: number;
  getStream: () => ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
}
```

Fields:

| Field         | Description                                                           |
| ------------- | --------------------------------------------------------------------- |
| `path`        | Full path in the batch, such as `/photos/2024/img.jpg`                |
| `contentHash` | Caller-computed content hash from `hashContent()`                     |
| `size`        | Plaintext file size in bytes                                          |
| `created`     | Optional Unix timestamp in milliseconds; defaults to upload time      |
| `getStream`   | Returns file content as a browser `ReadableStream` or `AsyncIterable` |

### DirectoryInput

Explicit directory declaration. Use this for empty directories or timestamp
overrides for inferred directories.

```typescript
interface DirectoryInput {
  path: string;
  created?: number;
}
```

### UploadOptions

```typescript
interface UploadOptions {
  manifestKey: SymmetricKey;
  batch_id: Uint8Array;
  directories?: DirectoryInput[];
  signal?: AbortSignal;
  uploadRetries?: number;
  onProgress?: UploadProgressCallback;
  onChunkUploaded?: ChunkUploadedCallback;
  onSubManifestFlushed?: SubManifestFlushedCallback;
}
```

Fields:

| Field                  | Description                                                         |
| ---------------------- | ------------------------------------------------------------------- |
| `manifestKey`          | Required 32-byte caller-derived symmetric key                       |
| `batch_id`             | Required 16-byte caller-supplied batch id, usually random per batch |
| `directories`          | Optional explicit directory declarations                            |
| `signal`               | Optional cancellation signal                                        |
| `uploadRetries`        | Retry attempts per chunk upload; default `3`                        |
| `onProgress`           | Upload progress callback                                            |
| `onChunkUploaded`      | Called after a chunk upload completes                               |
| `onSubManifestFlushed` | Called after an incremental sub-manifest upload completes           |

Abort behavior:

- Throws a `DOMException` with name `AbortError`.
- A current chunk upload may complete before the abort takes effect.

### BatchResult

```typescript
interface BatchResult {
  cid: string;
  manifest: BatchManifest;
  totalSize: number;
  chunkCount: number;
  manifestCount: number;
  renamed?: RenamedFile[];
}
```

### RenamedFile

```typescript
interface RenamedFile {
  originalPath: string;
  newPath: string;
}
```

### UploadProgress

```typescript
interface UploadProgress {
  phase: "processing" | "finalizing";
  filesProcessed: number;
  totalFiles?: number;
  bytesProcessed: number;
  totalBytes?: number;
  chunksUploaded: number;
  subManifestsFlushed: number;
  currentFile?: {
    path: string;
    size: number;
    bytesRead: number;
  };
}
```

For true lazy `AsyncIterable` inputs, `totalFiles` and `totalBytes` may be
undefined.

### ChunkUploadedInfo

```typescript
interface ChunkUploadedInfo {
  chunkId: string;
  cid: string;
  encryptedSize: number;
}
```

### SubManifestFlushedInfo

```typescript
interface SubManifestFlushedInfo {
  index: number;
  cid: string;
  fileCount: number;
}
```

---

## Manifest API

### getManifest(batchCid, options)

Retrieves and decrypts a batch manifest from IPFS.

```typescript
function getManifest(
  batchCid: string,
  options: GetManifestOptions,
): Promise<BatchManifest>;
```

Most consumers call `module.getManifest(batchCid, options)` with `ReadOptions`.

Parameters:

| Name       | Type                                  | Description                |
| ---------- | ------------------------------------- | -------------------------- |
| `batchCid` | `string`                              | Root CID of the batch      |
| `options`  | `ReadOptions` or `GetManifestOptions` | Manifest retrieval options |

Returns: `Promise<BatchManifest>`.

Throws:

- `ValidationError` for an empty CID, missing `manifestKey`, or invalid key
  size.
- `ManifestError` when the manifest cannot be fetched, decrypted, parsed, or has
  an unsupported version.

### ReadOptions

Options for `module.getManifest()` where the IPFS client is bound to the module.

```typescript
interface ReadOptions {
  manifestKey: SymmetricKey;
  signal?: AbortSignal;
}
```

### GetManifestOptions

Options for the standalone `getManifest()` implementation.

```typescript
interface GetManifestOptions {
  ipfsClient: IpfsClient;
  manifestKey: SymmetricKey;
  signal?: AbortSignal;
}
```

### getBatchIdFromManifestBlob(blob)

Parses the plaintext `batch_id` locator prefix from a root manifest IPFS blob.

```typescript
function getBatchIdFromManifestBlob(blob: Uint8Array): Uint8Array;
```

The returned value is the first 16 bytes of the blob. This function performs no
decryption and does not authenticate the encrypted manifest record that follows
the prefix.

Throws `ValidationError` when the blob is shorter than 16 bytes.

### BatchManifest

Decrypted batch manifest. It intentionally does not contain `manifestKey`; the
caller already owns that key and must pass it again for downloads.

```typescript
interface BatchManifest {
  cid: string;
  manifestVersion: number;
  directories: DirectoryInfo[];
  files: FileInfo[];
  created: number;
}
```

### FileInfo

```typescript
interface FileInfo {
  path: string;
  name: string;
  size: number;
  contentHash: ContentHash;
  chunks: ChunkRef[];
  created: number;
}
```

### DirectoryInfo

```typescript
interface DirectoryInfo {
  path: string;
  name: string;
  created: number;
}
```

### ChunkRef

```typescript
interface ChunkRef {
  chunkId: string;
  cid: string;
  offset: number;
  length: number;
  encryption: ChunkEncryption;
  encryptedLength: number;
}
```

`offset` and `encryptedLength` address the encrypted segment inside an IPFS
chunk object. `length` is the original plaintext segment length after removing
PADME padding.

---

## Download API

### downloadFile(file, options)

Downloads and decrypts one file.

```typescript
function downloadFile(
  file: FileDownloadRef,
  options: DownloadOptions & { output: WritableStream<Uint8Array> },
  ipfsClient: IpfsClient,
): Promise<void>;

function downloadFile(
  file: FileDownloadRef,
  options: DownloadOptions & { output: "memory" },
  ipfsClient: IpfsClient,
): Promise<Uint8Array>;

function downloadFile(
  file: FileDownloadRef,
  options: DownloadOptions & { output?: undefined },
  ipfsClient: IpfsClient,
): AsyncIterable<Uint8Array>;
```

Most consumers call `module.downloadFile(file, options)`.

Without `output`, the function returns `AsyncIterable<Uint8Array>`. With
`output: 'memory'`, it returns `Promise<Uint8Array>`. With a caller-owned
`WritableStream`, decrypted bytes are written to that stream and the function
returns `Promise<void>`; the stream is closed on success and aborted on failure.

Throws:

- `ValidationError` for invalid file references or options.
- `ManifestError` if the root manifest `batch_id` prefix cannot be read.
- `ChunkUnavailableError` if a chunk cannot be fetched after retries.
- `IntegrityError` if content hash verification fails in strict mode.

### downloadFiles(files, options)

Downloads and decrypts multiple files sequentially as a convenience API. For
large files, prefer `downloadFile()` with a caller-owned `WritableStream`
because `downloadFiles()` yields each `DownloadedFile` after that file has
completed.

```typescript
function downloadFiles(
  files: FileDownloadRef[],
  options: DownloadFilesOptions,
  ipfsClient: IpfsClient,
): AsyncIterable<DownloadedFile>;
```

Most consumers call `module.downloadFiles(files, options)`.

### FileDownloadRef

Construct this from `BatchManifest.files`.

```typescript
interface FileDownloadRef {
  batchCid: string;
  path: string;
  size: number;
  contentHash: ContentHash;
  chunks: ChunkRef[];
}
```

### DownloadOptions

```typescript
interface DownloadOptions {
  manifestKey: SymmetricKey;
  retries?: number;
  chunkConcurrency?: number;
  signal?: AbortSignal;
  onProgress?: DownloadProgressCallback;
  integrityMode?: "strict" | "warn";
  onIntegrityError?: (error: IntegrityError) => void;
  output?: "memory" | WritableStream<Uint8Array>;
}
```

Fields:

| Field              | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| `manifestKey`      | Required 32-byte key for chunk key derivation and decryption   |
| `retries`          | Retry attempts per chunk; default `3`                          |
| `chunkConcurrency` | Parallel chunk fetch concurrency per file; default `3`         |
| `signal`           | Optional cancellation signal                                   |
| `onProgress`       | Single-file progress callback                                  |
| `integrityMode`    | `strict` throws on hash mismatch; `warn` reports and continues |
| `onIntegrityError` | Callback used in `warn` mode                                   |
| `output`           | Optional `'memory'` result or caller-owned stream sink         |

### DownloadFilesOptions

```typescript
interface DownloadFilesOptions {
  manifestKey: SymmetricKey;
  concurrency?: number;
  chunkConcurrency?: number;
  retries?: number;
  signal?: AbortSignal;
  onProgress?: MultiDownloadProgressCallback;
  onError?: DownloadErrorCallback;
  integrityMode?: "strict" | "warn";
  onIntegrityError?: (error: IntegrityError) => void;
}
```

`concurrency` is deprecated and ignored. Files are downloaded sequentially;
chunk-level parallelism is controlled by `chunkConcurrency`.

### DownloadedFile

```typescript
interface DownloadedFile {
  path: string;
  size: number;
  content: AsyncIterable<Uint8Array>;
}
```

### DownloadProgress

```typescript
interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number;
}
```

### MultiDownloadProgress

```typescript
interface MultiDownloadProgress {
  filesCompleted: number;
  totalFiles: number;
  bytesDownloaded: number;
  totalBytes: number;
  currentFile?: string;
}
```

---

## Wire Format

### Manifest Version

The package exports `MANIFEST_VERSION_SUPPORTED`. The current value is `1`.
Uploads write this value and manifest retrieval rejects unsupported encrypted
manifest versions.

```typescript
import { MANIFEST_VERSION_SUPPORTED } from "@0xd49daa/ipfs-storage";
```

### Root Manifest Locator Prefix

The root manifest is stored at `/m`. Its blob format is:

```text
batch_id(16) | encrypted_root_manifest_aead_record
```

The `batch_id` prefix is plaintext so consumers can identify the batch locator
before decrypting. The encrypted record still authenticates `batch_id` in AAD;
tampering with the prefix causes decryption failure.

Sub-manifest blobs do not include this prefix; they are stored directly as AEAD
records.

### Canonical AEAD Record

Chunks, root manifests after the prefix, and sub-manifests use this record
layout:

```text
version(1) | key_scope(1) | nonce(12) | ciphertext | tag(16)
```

Supported values:

| Name                | Value    |
| ------------------- | -------- |
| AEAD record version | `0x01`   |
| Chunk key scope     | `0x04`   |
| Manifest key scope  | `0x05`   |
| Nonce size          | 12 bytes |
| GCM tag size        | 16 bytes |
| Manifest key size   | 32 bytes |
| Batch id size       | 16 bytes |

Manifest AAD contains `version`, manifest key scope, `batch_id`, and
`manifest_node_id`. Root manifest node id is `0`; sub-manifests use sequential
ids starting at `1`.

Chunk AAD contains `version`, chunk key scope, `batch_id`, file path hash, and
chunk index. Chunk file keys are derived from `manifestKey` and the file path
hash.

### Plaintext Handling

The library never writes plaintext files, OPFS caches, or temporary decrypted
files. Decrypted bytes are returned to the caller as an async iterable,
collected into memory with `output: 'memory'`, or written to the caller-supplied
`WritableStream` in `DownloadOptions.output`.

---

## Error Classes

All package errors extend `IpfsStorageError`.

```text
IpfsStorageError
├── ValidationError
├── IntegrityError
├── ManifestError
├── ChunkUnavailableError
├── ChunkUploadError
├── IpfsUploadError
├── IpfsFetchError
└── CidMismatchError
```

### IpfsStorageError

Base error class.

```typescript
class IpfsStorageError extends Error {
  readonly name: string;
}
```

### ValidationError

Thrown for invalid input, including:

- Missing or non-32-byte `manifestKey`.
- Missing or non-16-byte `batch_id`.
- Empty batch CID.
- Invalid file paths or directory paths.
- Invalid retry or concurrency values.

```typescript
class ValidationError extends IpfsStorageError {}
```

### IntegrityError

Thrown when downloaded plaintext does not match the expected content hash in
strict integrity mode.

```typescript
class IntegrityError extends IpfsStorageError {
  readonly expected: ContentHash;
  readonly actual: ContentHash;
  readonly path: string;
}
```

### ManifestError

Thrown for manifest retrieval, decryption, parsing, or unsupported version
failures.

```typescript
class ManifestError extends IpfsStorageError {
  readonly batchCid: string;
}
```

### ChunkUnavailableError

Thrown when a chunk cannot be fetched after retries.

```typescript
class ChunkUnavailableError extends IpfsStorageError {
  readonly chunkId: string;
  readonly batchCid: string;
}
```

### ChunkUploadError

Thrown when a chunk upload fails.

```typescript
class ChunkUploadError extends IpfsStorageError {
  readonly cid: string;
}
```

### CidMismatchError

Thrown when CID verification fails.

```typescript
class CidMismatchError extends IpfsStorageError {
  readonly expected: string;
  readonly actual: string;
}
```

### IpfsUploadError

Thrown when an `IpfsClient` upload fails, including Kubo RPC upload failures and
invalid CAR input.

```typescript
class IpfsUploadError extends IpfsStorageError {}
```

### IpfsFetchError

Thrown when an `IpfsClient` fetch fails.

```typescript
class IpfsFetchError extends IpfsStorageError {
  readonly cid: string;
  readonly path?: string;
}
```

---

## Types Reference

### ChunkEncryption

```typescript
enum ChunkEncryption {
  SINGLE_SHOT = 0,
  STREAMING = 1,
}
```

The current Vault AEAD implementation emits `SINGLE_SHOT` records for encrypted
segments. The enum remains part of the manifest type surface.

### DownloadOutput

```typescript
type DownloadOutput = "memory" | WritableStream<Uint8Array>;
```

### Callback Types

```typescript
type UploadProgressCallback = (progress: UploadProgress) => void;
type ChunkUploadedCallback = (info: ChunkUploadedInfo) => void;
type SubManifestFlushedCallback = (info: SubManifestFlushedInfo) => void;
type DownloadProgressCallback = (progress: DownloadProgress) => void;
type MultiDownloadProgressCallback = (progress: MultiDownloadProgress) => void;
type DownloadErrorCallback = (error: Error, file: FileDownloadRef) => void;
```

### Utilities

```typescript
function asAsyncIterable<T>(items: Iterable<T>): AsyncIterable<T>;
function hashContent(bytes: Uint8Array): Promise<ContentHash>;
function asContentHash(bytes: Uint8Array): ContentHash;
```

`asAsyncIterable()` converts an in-memory iterable to an async iterable for
tests, examples, and small inputs. `hashContent()` computes the content hash
format accepted by this package without exposing the concrete algorithm in the
public API name.

---

## Content Hash Helpers And Types

The following helpers and types are exported for caller-side file metadata:

```typescript
export { asContentHash, hashContent } from "@0xd49daa/ipfs-storage";
export type { ContentHash, SymmetricKey } from "@0xd49daa/ipfs-storage";
```

Asymmetric key pair and public/private key types are not re-exported by this
package.

---

## IpfsClient Interface

Interface for IPFS client implementations.

```typescript
interface IpfsClient {
  uploadCar(car: AsyncIterable<Uint8Array>): Promise<string>;
  cat(cid: string, path?: string): AsyncIterable<Uint8Array>;
  has(cid: string): Promise<boolean>;
}
```

### MockIpfsClient

In-memory mock implementation for tests and examples.

```typescript
class MockIpfsClient implements IpfsClient {
  constructor(options?: MockIpfsClientOptions);

  uploadCar(car: AsyncIterable<Uint8Array>): Promise<string>;
  cat(cid: string, path?: string): AsyncIterable<Uint8Array>;
  has(cid: string): Promise<boolean>;

  clear(): void;
  getBlock(cid: string): Uint8Array | undefined;
  getBlockCount(): number;
  isRoot(cid: string): boolean;
  setFailNextUpload(error: Error): void;
  clearFailNextUpload(): void;
  setUploadLatch(signal: AbortSignal): Promise<void>;
  clearUploadLatch(): void;
}
```

---

## Kubo RPC Client

### KuboRpcClient

Browser-compatible adapter around the official `kubo-rpc-client` package.

```typescript
class KuboRpcClient implements IpfsClient {
  constructor(options?: KuboRpcClientOptions);

  uploadCar(car: AsyncIterable<Uint8Array>): Promise<string>;
  cat(cid: string, path?: string): AsyncIterable<Uint8Array>;
  has(cid: string): Promise<boolean>;
}

interface KuboRpcClientOptions {
  baseUrl?: string | URL;
  headers?: Headers | Record<string, string>;
  timeout?: number | string;
}
```

`baseUrl` defaults to `http://127.0.0.1:5001`. Rooted CARs are uploaded through
Kubo `/api/v0/dag/import`; rootless CAR blocks are uploaded through
`/api/v0/block/put`. Returned CIDs are verified against the CAR contents and a
`CidMismatchError` is thrown if Kubo returns an unexpected CID.

Browser callers must configure Kubo CORS for the application origin. The Kubo
RPC API is an admin interface and should stay bound to localhost.

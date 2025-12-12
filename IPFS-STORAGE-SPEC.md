# IPFS Storage Module — Tech Spec

## Overview

Browser-first TypeScript library for IPFS-based encrypted batch storage. Stateless module — client stores manifests locally.

**Target:** Browser (primary), Bun/Node (secondary)  
**Serialization:** Protocol Buffers  
**Crypto:** `@filemanager/encryptionv2`

---

## Decisions

| Topic | Decision |
|-------|----------|
| Input format | `FileInput[]` with full path |
| Directory support | Full hierarchy with path, name, created |
| Key wrapping | `wrapKeyAuthenticatedMulti()` |
| File keys | Derived: `hashBlake2b(DOMAIN.FILE_KEY ‖ manifestKey ‖ contentHash, 32)` |
| Symmetric key scope | One manifest_key per batch; file keys derived on-the-fly |
| Chunking | Small files (<10MB) combined; large files split into 10MB chunks |
| Chunk encryption | `encrypt()` for ≤10MB, `createEncryptStream()` for larger |
| Chunk path | Hierarchical: `/{id[0:2]}/{id[2:4]}/{id}` |
| Upload strategy | Segmented CAR (10 chunks/segment, ~100MB) |
| Chunk deduplication | `ipfsClient.has(cid)` — resume only, not cross-batch |
| Chunk naming | `crypto.randomUUID()` + base58 (22 chars) |
| Padding | PADME for last physical chunk in batch |
| Content hash | `hashBlake2b()` — caller computes, module trusts on upload |
| Manifest splitting | ~1MB sub-manifests; sorted by path |
| Duplicate paths | Auto-rename: `photo.jpg` → `photo_1.jpg` |
| Empty files | Allowed; manifest only |
| Empty directories | Only if explicitly provided |
| Download concurrency | Configurable per-file and multi-file |
| Multi-device | Encrypt for multiple recipient public keys |

---

## Browser Constraints

| Constraint | Solution |
|------------|----------|
| Memory limits | Streaming encryption/decryption, chunk-by-chunk processing |
| No filesystem | Client uses IndexedDB/OPFS for state, module is stateless |
| Large file handling | Segmented upload, parallel chunk download with sliding window |
| Network interruption | Resumable upload via UploadState |

---

## Cryptography Mapping

All crypto via `@filemanager/encryptionv2`:

| Operation | Function |
|-----------|----------|
| Manifest key | `generateKey()` |
| File key derivation | `hashBlake2b(DOMAIN.FILE_KEY ‖ manifestKey ‖ contentHash, 32)` |
| Chunk encrypt (≤10MB) | `encrypt()` / `decrypt()` |
| Chunk encrypt (>10MB) | `createEncryptStream()` / `createDecryptStream()` |
| Manifest encrypt | `encrypt()` |
| Key wrap (multi-device) | `wrapKeyAuthenticatedMulti()` |
| Key unwrap | `unwrapKeyAuthenticated()` |
| Content hash | `hashBlake2b()` |

---

## Domain Separation

All derived values use domain prefixes to prevent collisions:

```typescript
// Domain separation constants (UTF-8 encoded)
const DOMAIN = {
  FILE_KEY: 'ipfs-storage:file-key:v1',
  // Reserved for future use:
  // SHARE_KEY: 'ipfs-storage:share-key:v1',
} as const
```

### File Key Derivation

```typescript
// Explicit byte concatenation (‖ means byte concat, not string)
fileKey = hashBlake2b(
  concat(
    utf8Encode(DOMAIN.FILE_KEY),  // 24 bytes
    manifestKey,                   // 32 bytes
    contentHash,                   // 32 bytes
  ),                               // Total: 88 bytes
  32,                              // Output: 32 bytes
)
```

```typescript
// Implementation
function deriveFileKey(manifestKey: SymmetricKey, contentHash: ContentHash): Promise<SymmetricKey> {
  const domain = new TextEncoder().encode(DOMAIN.FILE_KEY)
  const input = new Uint8Array(domain.length + 32 + 32)
  input.set(domain, 0)
  input.set(manifestKey, domain.length)
  input.set(contentHash, domain.length + 32)
  return hashBlake2b(input, 32) as Promise<SymmetricKey>
}
```

**Why domain separation:**
- Prevents collisions if same inputs used elsewhere
- Version suffix allows safe algorithm changes
- Clear audit trail of what each hash represents

---

## Batch Structure

```
batch_root/
  ├── 6B/v7/6Bv7HnWcL4mT9Rp2QsXx3a   ← encrypted chunk
  ├── 9c/Ld/9cLdPx8Yk2RmNp3QwT5f1b   ← encrypted chunk
  ├── m                               ← root manifest (encrypted)
  └── m_0, m_1...                     ← sub-manifests (if needed)
```

**Chunk ID:** `base58(crypto.randomUUID())` → 22 chars  
**Chunk path:** `{id[0:2]}/{id[2:4]}/{id}` → supports petabyte+ scale

---

## Chunk Aggregation

Small files are combined into shared chunks to reduce IPFS overhead:

| File size | Strategy |
|-----------|----------|
| < 10MB | Aggregate into shared chunk until ~10MB |
| ≥ 10MB | Split into dedicated 10MB chunks |

**Semantics:**

- One physical chunk can contain multiple files (via `offset`/`length` in manifest)
- Files are packed sequentially; chunk boundary at ~1MB
- Each chunk encrypted with random nonce → different ciphertext each time
- `ipfsClient.has(cid)` only useful for resume (same upload session, CID already known)
- No deduplication — each file processed independently, even if identical `contentHash`

**Tradeoffs:**

| Aspect | Implication |
|--------|-------------|
| Storage efficiency | Small files share chunk overhead (encryption header, IPFS block) |
| Update granularity | Changing one small file requires re-uploading entire shared chunk |
| Batch immutability | Not an issue — batches are immutable; updates create new batch |
| File size privacy | Individual file sizes visible in manifest; acceptable since manifest is encrypted |
| Padding | PADME applied only to last physical chunk — hides total batch size from IPFS |

**Example:**

```
Files: a.txt (1MB), b.txt (2MB), c.txt (9MB), d.txt (25MB)

Chunk 0: [a.txt][b.txt][partial c.txt]  → ~10MB
Chunk 1: [rest of c.txt]                → ~2MB  
Chunk 2: [d.txt part 1]                 → 10MB
Chunk 3: [d.txt part 2]                 → 10MB
Chunk 4: [d.txt part 3]                 → 5MB

Manifest entries:
  a.txt → [{chunk: 0, offset: 0, length: 1MB}]
  b.txt → [{chunk: 0, offset: 1MB, length: 2MB}]
  c.txt → [{chunk: 0, offset: 3MB, length: 7MB}, {chunk: 1, offset: 0, length: 2MB}]
  d.txt → [{chunk: 2, ...}, {chunk: 3, ...}, {chunk: 4, ...}]
```

### Empty Files & Directories

**Empty file** — manifest entry with `size: 0`, no chunks:

```typescript
{
  path: '/docs/placeholder.txt',
  name: 'placeholder.txt',
  size: 0,
  contentHash: hashBlake2b(new Uint8Array(0)),  // Hash of empty
  chunks: [],  // No chunks
  created: 1699900000000,
}
```

**Empty directory** — only if explicitly provided in `directories`:

```typescript
// Upload call
uploadBatch(files, {
  ...options,
  directories: [
    { path: '/photos/2024', created: 1699900000000 },
    { path: '/photos/2024/empty-album' },  // Explicit empty dir
  ],
})

// Result in manifest
{
  directories: [
    { path: '/photos', name: 'photos', created: 1699900000000 },
    { path: '/photos/2024', name: '2024', created: 1699900000000 },
    { path: '/photos/2024/empty-album', name: 'empty-album', created: 1699900000000 },
  ],
  files: [],  // No files
}
```

**Note:** Intermediate directories (e.g., `/photos`) are inferred from file paths automatically. Only leaf empty directories need explicit declaration.

### Duplicate Path Handling

When multiple files have the same path, auto-rename ensures uniqueness:

```typescript
// Algorithm
function resolveConflicts(files: FileInput[]): Map<string, string> {
  const seen = new Set<string>()
  const renames = new Map<string, string>()  // original → resolved
  
  for (const file of files) {
    let resolved = file.path
    let counter = 1
    
    while (seen.has(resolved)) {
      // photo.jpg → photo_1.jpg → photo_2.jpg
      const ext = extname(file.path)           // ".jpg"
      const base = basename(file.path, ext)    // "photo"
      const dir = dirname(file.path)           // "/photos"
      resolved = `${dir}/${base}_${counter}${ext}`
      counter++
    }
    
    seen.add(resolved)
    if (resolved !== file.path) {
      renames.set(file.path, resolved)
    }
  }
  
  return renames
}
```

**Rules:**

| Scenario | Result |
|----------|--------|
| `photo.jpg` (first) | `photo.jpg` |
| `photo.jpg` (second) | `photo_1.jpg` |
| `photo.jpg` (third) | `photo_2.jpg` |
| `photo_1.jpg` exists, then `photo.jpg` duplicate | `photo_2.jpg` (skips `_1`) |

**No limit** on counter — practically bounded by filesystem limits.

**Determinism:** Files processed in input order. Same input array → same renames. Returned in `BatchResult.renamed` for caller awareness.

---

## Integrity Model

Content hash verification on download only:

| Phase | Behavior |
|-------|----------|
| **Upload** | Trust caller's `contentHash` — no re-computation |
| **Download** | Verify after decryption + assembly |

### Why Trust Caller on Upload

- Caller uses same `@filemanager/encryptionv2` → same `hashBlake2b()`
- Re-computing = read file twice (expensive for large files)
- IPFS CID provides upload integrity (hash of encrypted bytes)
- Real corruption caught on download anyway

### Download Verification

```
    downloadFile()
         ↓
    fetch chunks → decrypt → assemble
         ↓
    hashBlake2b(plaintext) → compare with manifest contentHash
         ↓
    mismatch? → throw IntegrityError (default) or callback (soft mode)
         ↓
    match? → return stream
```

**Options:**

```typescript
interface DownloadOptions {
  // ... existing fields
  integrityMode?: 'strict' | 'warn'  // Default: 'strict'
  onIntegrityError?: (error: IntegrityError) => void
}
```

| Mode | Behavior |
|------|----------|
| `strict` | Throw `IntegrityError`, abort download |
| `warn` | Call `onIntegrityError`, continue returning data |

### IPFS CID as Additional Layer

IPFS CID guarantees chunk-level integrity (hash of encrypted bytes). This catches:
- Network corruption
- Storage node tampering
- Chunk substitution

Module verifies CID implicitly via IPFS `cat()`. `contentHash` is additional end-to-end verification after decryption.

---

## Concurrency & Cancellation

### Defaults

| Option | Default | Context |
|--------|---------|---------|
| `segmentSize` | 10 | Chunks per CAR segment (~100MB) |
| `chunkConcurrency` | 3 | Parallel chunk downloads per file |
| `concurrency` | 3 | Parallel file downloads |
| `retries` | 3 | Retry attempts per chunk |

**Note:** `concurrency` and `chunkConcurrency` are upper bounds. Actual parallelism may be lower due to browser connection limits (~6 per host) or backpressure.

### Error Handling in `downloadFiles`

```typescript
interface DownloadFilesOptions {
  onError?: DownloadErrorCallback  // Optional error handler
}
```

| `onError` provided | Behavior |
|--------------------|----------|
| Yes | Call handler, continue downloading remaining files |
| No | Throw on first error, abort remaining downloads |

```typescript
// Continue on error — collect failures
const failures: Array<{ path: string; error: Error }> = []

for await (const file of module.downloadFiles(refs, {
  onError: (err, ref) => failures.push({ path: ref.path, error: err }),
})) {
  await saveFile(file)
}

if (failures.length > 0) {
  console.warn('Some files failed:', failures)
}

// Fail fast — no onError
try {
  for await (const file of module.downloadFiles(refs)) {
    await saveFile(file)
  }
} catch (err) {
  // First failure stops iteration
}
```

### Cancellation

All async operations accept `AbortSignal` for graceful cancellation:

```typescript
const controller = new AbortController()

// Start upload
const uploadPromise = module.uploadBatch(files, {
  ...options,
  signal: controller.signal,
})

// Cancel after 30s
setTimeout(() => controller.abort(), 30_000)

try {
  await uploadPromise
} catch (err) {
  if (err.name === 'AbortError') {
    // Use resumeState from last onSegmentComplete to resume later
  }
}
```

**Behavior on abort:**
- Current chunk/segment completes (no partial writes)
- Throws `AbortError`
- Upload: `UploadState` from last `onSegmentComplete` is valid for resume
- Download: Partial data discarded

---

## TypeScript Interfaces

### Public API

```typescript
interface IpfsStorageModule {
  uploadBatch(files: FileInput[], options: UploadOptions): Promise<BatchResult>
  getManifest(batchCid: string, options: ReadOptions): Promise<BatchManifest>
  downloadFile(file: FileDownloadRef, options?: DownloadOptions): AsyncIterable<Uint8Array>
  downloadFiles(files: FileDownloadRef[], options?: DownloadFilesOptions): AsyncIterable<DownloadedFile>
}
```

**Stream compatibility:**

`AsyncIterable<Uint8Array>` works natively in both environments:

```typescript
// Bun/Node — direct iteration
for await (const chunk of module.downloadFile(ref)) {
  await file.write(chunk)
}

// Browser — convert to ReadableStream if needed
const stream = ReadableStream.from(module.downloadFile(ref))

// Node — convert to node:stream if needed
import { Readable } from 'node:stream'
const nodeStream = Readable.fromWeb(ReadableStream.from(module.downloadFile(ref)))
```

### Upload Types

```typescript
import type {
  SymmetricKey, X25519KeyPair, X25519PublicKey, ContentHash
} from '@filemanager/encryptionv2'

interface FileInput {
  file: File
  path: string                     // "/photos/2024/img.jpg"
  contentHash: ContentHash         // BLAKE2b from caller
  created?: number                 // Unix ms
}

interface DirectoryInput {
  path: string
  created?: number
}

interface UploadOptions {
  senderKeyPair: X25519KeyPair
  recipients: RecipientInfo[]             // Multi-device support
  directories?: DirectoryInput[]
  segmentSize?: number                    // Default: 10 (chunks per segment, ~100MB)
  signal?: AbortSignal                    // Graceful cancellation
  resumeState?: UploadState
  onProgress?: UploadProgressCallback
  onSegmentComplete?: SegmentCompleteCallback
}

interface RecipientInfo {
  publicKey: X25519PublicKey
  label?: string                          // "MacBook Pro", "iPhone", etc.
}

interface BatchResult {
  cid: string
  manifest: BatchManifest
  totalSize: number
  chunkCount: number
  manifestCount: number
  segmentsUploaded: number
  renamed?: RenamedFile[]
}

interface RenamedFile {
  originalPath: string
  newPath: string
}
```

### Resumable Upload

```typescript
interface UploadState {
  batchId: string
  segments: SegmentState[]
  manifestCid?: string
  rootCid?: string
}

interface SegmentState {
  index: number
  status: 'pending' | 'uploading' | 'complete' | 'failed'
  chunkCids: Record<string, string>  // chunkId → CID
  error?: string
}

type SegmentCompleteCallback = (result: SegmentResult) => void

interface SegmentResult {
  index: number
  chunksUploaded: number
  chunksSkipped: number
  totalSegments: number
  state: UploadState
}
```

### Resume Semantics

**Segment atomicity:**

`ipfsClient.uploadCar()` must be atomic per segment — either fully uploaded or not. This is a hard requirement for `IpfsClient` implementation.

```
Segment upload:
  ↓
  uploadCar(segment) → success → mark 'complete'
                     → failure → mark 'failed', retry whole segment
```

**On retry:**

- Failed segment is re-uploaded entirely (no partial segment recovery)
- `ipfsClient.has(cid)` not used within segment — atomicity handles this
- `has(cid)` only used across segments if same CID appears in multiple segments (rare)

**Non-atomic providers:**

If IPFS provider doesn't guarantee atomicity (e.g., local test node):

| Approach | Tradeoff |
|----------|----------|
| Wrapper with cleanup | Delete orphan blocks on failure — complex, provider-specific |
| Accept duplicates | Retry may create duplicate blocks — wastes storage, but safe |
| Use `has(cid)` per block | Check before each block upload — slow, but recoverable |

For production, use providers with atomic CAR upload (e.g., web3.storage, Crust gateway).

**Why segment-level atomicity:**

- Simpler recovery logic
- CAR is single unit — partial CAR is invalid anyway
- Segment size (10 chunks, ~100MB) is reasonable retry unit
```

### Download Types

```typescript
interface FileDownloadRef {
  batchCid: string
  path: string
  size: number
  contentHash: ContentHash
  manifestKey: SymmetricKey
  chunks: ChunkRef[]
}

interface ChunkRef {
  chunkId: string              // base58(uuid)
  cid: string                  // IPFS CID
  offset: number               // Offset within decrypted chunk
  length: number               // Decrypted length
  encryption: ChunkEncryption
}

enum ChunkEncryption {
  SINGLE_SHOT = 0,   // ≤10MB chunks (default)
  STREAMING = 1,     // >10MB chunks (if chunkSize increased)
}

interface DownloadOptions {
  retries?: number             // Default: 3
  chunkConcurrency?: number    // Default: 3
  signal?: AbortSignal         // Graceful cancellation
  onProgress?: DownloadProgressCallback
}

interface DownloadFilesOptions {
  concurrency?: number         // Default: 3 (parallel files)
  chunkConcurrency?: number    // Default: 3 (per file)
  retries?: number             // Default: 3
  signal?: AbortSignal         // Graceful cancellation
  onProgress?: MultiDownloadProgressCallback
  onError?: DownloadErrorCallback
}

interface DownloadedFile {
  path: string
  size: number
  content: AsyncIterable<Uint8Array>
}
```

### Manifest Types

```typescript
interface BatchManifest {
  cid: string
  manifestKey: SymmetricKey
  senderPublicKey: X25519PublicKey
  directories: DirectoryInfo[]
  files: FileInfo[]
  created: number
}

interface DirectoryInfo {
  path: string
  name: string
  created: number
}

interface FileInfo {
  path: string
  name: string
  size: number
  contentHash: ContentHash
  chunks: ChunkRef[]
  created: number
}

interface ReadOptions {
  recipientKeyPair: X25519KeyPair
  expectedSenderPub: X25519PublicKey
}
```

### Progress Types

```typescript
type UploadProgressCallback = (progress: UploadProgress) => void

interface UploadProgress {
  phase: 'chunking' | 'encrypting' | 'uploading' | 'finalizing'
  filesProcessed: number
  totalFiles: number
  bytesProcessed: number
  totalBytes: number
  currentSegment?: number
  totalSegments?: number
  chunksSkipped?: number
}

type DownloadProgressCallback = (progress: DownloadProgress) => void

interface DownloadProgress {
  bytesDownloaded: number
  totalBytes: number
}

type MultiDownloadProgressCallback = (progress: MultiDownloadProgress) => void

interface MultiDownloadProgress {
  filesCompleted: number
  totalFiles: number
  bytesDownloaded: number
  totalBytes: number
  currentFile?: string
}

type DownloadErrorCallback = (error: Error, file: FileDownloadRef) => void
```

### Error Types

```typescript
class IpfsStorageError extends Error {}

class ValidationError extends IpfsStorageError {
  // Empty batch, invalid path format, no recipients
}

class IntegrityError extends IpfsStorageError {
  path: string
  expected: ContentHash
  actual: ContentHash
}

class ManifestError extends IpfsStorageError {
  batchCid: string
}

class ChunkUnavailableError extends IpfsStorageError {
  batchCid: string
  chunkId: string
}

class SegmentUploadError extends IpfsStorageError {
  segmentIndex: number
  state: UploadState
}

class CidMismatchError extends IpfsStorageError {
  expected: string
  actual: string
}

// Re-export from encryptionv2
export { EncryptionError, ErrorCode } from '@filemanager/encryptionv2'
```

---

## Configuration

```typescript
interface IpfsStorageConfig {
  ipfsClient: IpfsClient
  chunkSize?: number            // Default: 10MB
  streamingThreshold?: number   // Default: 10MB (same as chunkSize)
}

interface IpfsClient {
  /**
   * Upload CAR file to IPFS.
   * 
   * REQUIREMENT: Must be atomic — either fully uploaded or not at all.
   * Partial uploads must not leave dangling blocks.
   * 
   * If provider doesn't guarantee atomicity, wrapper must implement
   * cleanup on failure or accept potential duplicate blocks on retry.
   */
  uploadCar(car: AsyncIterable<Uint8Array>): Promise<string>
  
  cat(cid: string, path?: string): AsyncIterable<Uint8Array>
  has(cid: string): Promise<boolean>
}
```

---

## Protobuf Schema

```protobuf
syntax = "proto3";

message ManifestEnvelope {
  bytes encrypted_manifest = 1;
  repeated RecipientKey recipients = 2;
}

message RecipientKey {
  bytes recipient_public_key = 1;  // 32 bytes
  bytes nonce = 2;                 // 24 bytes
  bytes ciphertext = 3;            // 48 bytes
  bytes sender_public_key = 4;     // 32 bytes
  string label = 5;                // Optional: "MacBook Pro", "iPhone", "bob@example.com"
}

message RootManifest {
  repeated DirectoryRecord directories = 1;
  repeated FileRecord files = 2;
  repeated SubManifestIndex sub_manifests = 3;
  uint64 created = 4;
}

message SubManifestIndex {
  string manifest_id = 1;
  string start_path = 2;
  string end_path = 3;
  uint32 file_count = 4;
}

message SubManifest {
  repeated FileRecord files = 1;
}

message DirectoryRecord {
  string path = 1;
  string name = 2;
  uint64 created = 3;
}

message FileRecord {
  string path = 1;
  string name = 2;
  uint64 size = 3;
  bytes content_hash = 4;
  repeated FileChunk chunks = 5;
  uint64 created = 6;
}

message FileChunk {
  string chunk_id = 1;
  string cid = 2;
  uint32 offset = 3;
  uint32 length = 4;
  ChunkEncryption encryption = 5;
}

enum ChunkEncryption {
  CHUNK_ENCRYPTION_SINGLE_SHOT = 0;
  CHUNK_ENCRYPTION_STREAMING = 1;
}
```

---

## Dependencies

- `@filemanager/encryptionv2` — All cryptographic operations
- `@ipld/car` — CAR file generation
- `@ipld/unixfs` — UnixFS directory building
- `multiformats` — CID handling
- `@bufbuild/protobuf` — Protocol Buffers
- `@scure/base` — base58 encoding

---

## Testing

**Framework:** Bun test

```bash
bun test                    # Run all tests
bun test --watch            # Watch mode
bun test src/upload.test.ts # Single file
```

No browser required — `@filemanager/encryptionv2` uses libsodium WASM which works in Bun/Node.

---

## Security Considerations

### File Key Derivation

`fileKey = hashBlake2b(DOMAIN.FILE_KEY ‖ manifestKey ‖ contentHash, 32)`

**Same content within batch → same fileKey:**

| Property | Status |
|----------|--------|
| Ciphertext uniqueness | ✓ Preserved — random nonce per chunk |
| Key uniqueness | ✗ Same fileKey for identical files |
| Content correlation | Attacker with manifest can see same `contentHash` entries |

**Why acceptable:**

- Manifest is encrypted — `contentHash` not visible externally
- Random nonce ensures different ciphertext even with same key
- Cross-batch: different `manifestKey` → different `fileKey` for same content
- Threat model assumes manifest compromise = full metadata exposure anyway

**If stronger isolation needed (v2):**

```typescript
// Add file path to derivation
fileKey = hashBlake2b(DOMAIN.FILE_KEY ‖ manifestKey ‖ contentHash ‖ utf8(path), 32)
```

This gives unique keys even for identical files at different paths.

---

## Not In Scope (v1)

- Range requests / video seek (`downloadFileRange`)
- HD key derivation (caller uses `@filemanager/encryptionv2` directly)
- ICP canister interaction
- Crust pinning requests
- Phala renewal
- Local manifest/index storage
- OPFS staging
- Cross-batch deduplication
- Compression
- File sharing

### Future Considerations (v2+)

**Partial batch updates:**
Virtual FS layer over immutable batches — track deltas, merge on read, compact periodically.

**Path-based versioning:**
Convention for versioned paths: `/photos/2024/@v1/...`, `/photos/2024/@v2/...`. Enables rollback without separate batch management.

**Smaller chunks for video:**
Content-type hint in `FileInput` → 256KB chunks for seek-heavy content, better range request granularity.

---

## Recipient Revocation (Future)

Batches are immutable — revocation requires creating new batch:

```
Batch A: recipients = [device1, device2, device3]
         ↓
    revoke device2
         ↓
Batch B: recipients = [device1, device3]  ← new manifest key, re-wrapped
         ↓
    stop renewing Batch A → expires
```

**Implications:**
- No in-place recipient removal
- Revoked device retains access until old batch expires or is deleted
- For immediate revocation: re-encrypt with new manifest key (costly for large batches)

This aligns with batch immutability principle from architecture doc.

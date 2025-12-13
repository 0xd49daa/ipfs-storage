# IPFS Storage Module — Implementation Plan

## Overview

This plan breaks down the implementation into logical phases, ordered by dependencies. Each phase builds on the previous, enabling incremental testing and validation.

---

## Phase 0: Project Scaffolding & Foundation ✅

**Status:** Complete

**Goal:** Establish project structure, dependencies, and shared infrastructure.

**Tasks:**
1. ✅ Initialize Bun project with TypeScript configuration
2. ✅ Install core dependencies: `@filemanager/encryptionv2`, `@ipld/car`, `@ipld/unixfs`, `multiformats`, `@bufbuild/protobuf`, `@scure/base`
3. ✅ Set up Bun test framework with initial smoke test
4. ✅ Define domain separation constants (`DOMAIN.FILE_KEY`)
5. ✅ Create branded types: `ChunkId`, `BatchCid`, `ChunkCid`, `FilePath`
6. ✅ Implement `deriveFileKey()` using `hashBlake2b` with proper byte concatenation
7. ✅ Create base error classes: `IpfsStorageError`, `ValidationError`, `IntegrityError`, `ManifestError`, `ChunkUnavailableError`, `SegmentUploadError`, `CidMismatchError`

**Deliverables:**
- ✅ Working Bun project with all dependencies
- ✅ Exported constants and branded types
- ✅ `deriveFileKey()` with unit tests
- ✅ Error class hierarchy

**Files Created:**
- `src/constants.ts` — Domain separation constants, chunk sizes, defaults
- `src/branded.ts` — `ChunkId`, `BatchCid`, `ChunkCid`, `FilePath` branded types
- `src/errors.ts` — Error class hierarchy (7 classes)
- `src/crypto.ts` — `deriveFileKey()` implementation
- `src/index.ts` — Public API exports
- `src/index.test.ts` — 20 unit tests

**Testing:** 20 tests passing
- ✅ `deriveFileKey()` produces deterministic output for same inputs
- ✅ Domain prefix is correctly encoded as UTF-8 bytes (24 bytes)
- ✅ Error classes properly extend `IpfsStorageError`
- ✅ Branded types validate and reject invalid inputs

---

## Phase 1: Protobuf Schema & Serialization ✅

**Status:** Complete

**Goal:** Define and compile Protocol Buffer schemas for manifest structures.

**Tasks:**
1. ✅ Create `.proto` file with all message types: `ManifestEnvelope`, `RecipientKey`, `RootManifest`, `SubManifestIndex`, `SubManifest`, `DirectoryRecord`, `FileRecord`, `FileChunk`, `ChunkEncryption` enum
2. ✅ Configure `@bufbuild/protobuf` for code generation (buf v2 format)
3. ✅ Create TypeScript wrapper functions for encode/decode operations
4. ✅ Implement conversion between Protobuf messages and public TypeScript interfaces (`BatchManifest`, `FileInfo`, `DirectoryInfo`, `ChunkRef`)

**Deliverables:**
- ✅ Generated Protobuf TypeScript bindings
- ✅ Serialization/deserialization utilities
- ✅ Type converters
- ✅ 10 public TypeScript interfaces

**Files Created:**
- `proto/manifest.proto` — Protobuf schema (9 messages + 1 enum)
- `buf.yaml` — Buf v2 workspace configuration
- `buf.gen.yaml` — Code generation configuration
- `src/gen/manifest_pb.ts` — Auto-generated TypeScript bindings
- `src/types.ts` — Public TypeScript interfaces (10 types)
- `src/serialization.ts` — Encode/decode functions + type converters
- `src/serialization.test.ts` — 12 unit tests

**Files Modified:**
- `package.json` — Added `@bufbuild/buf`, `@bufbuild/protoc-gen-es` devDeps; added `proto:generate` script
- `src/index.ts` — Exported new types and serialization functions

**Testing:** 12 tests passing
- ✅ ManifestEnvelope round-trip (single/multiple recipients, empty label)
- ✅ RootManifest round-trip (directories + files, sub-manifests, empty arrays)
- ✅ SubManifest round-trip (100 files)
- ✅ Multi-chunk files handled correctly
- ✅ STREAMING encryption enum preserved
- ✅ Empty files (size 0, no chunks)
- ✅ Large timestamps (year 2100)
- ✅ 1000 files encode/decode < 100ms

---

## Phase 2: IpfsClient Interface & Mock Implementation ✅

**Status:** Complete

**Goal:** Define the IPFS abstraction layer and create a test double.

**Tasks:**
1. ✅ Define `IpfsClient` interface: `uploadCar()`, `cat()`, `has()`
2. ✅ Implement in-memory mock `IpfsClient` for testing (stores CAR content in Map, computes CIDs)
3. ✅ Add helper to extract blocks from stored CARs
4. ✅ Implement CID computation using `multiformats`

**Deliverables:**
- ✅ `IpfsClient` interface definition with JSDoc
- ✅ `MockIpfsClient` for testing with test helpers
- ✅ CID computation utilities (`computeRawCid`, `computeDagPbCid`, `parseCid`, `formatCid`)
- ✅ Error classes (`IpfsUploadError`, `IpfsFetchError`)

**Files Created:**
- `src/ipfs-client.ts` — IpfsClient interface, MockIpfsClient, CID utilities, error classes
- `src/ipfs-client.test.ts` — 27 unit tests

**Files Modified:**
- `package.json` — Added `@ipld/dag-pb` dependency
- `src/index.ts` — Exported new types and functions

**Testing:** 27 tests passing
- ✅ Mock correctly computes CIDs for uploaded content
- ✅ `uploadCar()` stores all blocks atomically
- ✅ `cat()` returns correct bytes for direct CID (no path)
- ✅ `cat()` resolves paths within UnixFS directory structure
- ✅ `cat()` handles nested paths like `/subdir/file.txt`
- ✅ `has()` returns true only for uploaded CIDs
- ✅ Test helpers: `clear()`, `setFailNextUpload()`, `getBlock()`, `getBlockCount()`

---

## Phase 3: Chunk ID Generation & Path Utilities ✅

**Status:** Complete

**Goal:** Implement chunk naming and hierarchical path generation.

**Tasks:**
1. ✅ Implement `generateChunkId()`: `base58(randomBytes(16))` → 22 chars
2. ✅ Implement `chunkIdToPath()`: `{id[0:2]}/{id[2:4]}/{id}`
3. ✅ Create path validation utilities (`isValidPath()`, `normalizePath()`)
4. ✅ Implement `dirname()`, `basename()`, `extname()` for path manipulation

**Deliverables:**
- ✅ Chunk ID generator (`generateChunkId()`)
- ✅ Path transformation utilities (`chunkIdToPath()`)
- ✅ Path validation functions (`isValidPath()`, `normalizePath()`)
- ✅ Path manipulation functions (`dirname()`, `basename()`, `extname()`)

**Files Created:**
- `src/chunk-id.ts` — `generateChunkId()`, `chunkIdToPath()`
- `src/path-utils.ts` — `dirname()`, `basename()`, `extname()`, `isValidPath()`, `normalizePath()`
- `src/chunk-id.test.ts` — 29 unit tests

**Files Modified:**
- `src/index.ts` — Exported Phase 3 functions

**Testing:** 29 tests passing
- ✅ Generated IDs are 22 characters, valid base58
- ✅ Produces unique IDs on repeated calls
- ✅ Path hierarchy correctly splits ID (format `{2}/{2}/{22}`)
- ✅ Path utilities handle edge cases (root, no extension, multiple dots, dotfiles)

---

## Phase 4: Duplicate Path Resolution ✅

**Status:** Complete

**Goal:** Implement auto-rename logic for conflicting file paths.

**Tasks:**
1. ✅ Implement `resolveConflicts()` algorithm per spec
2. ✅ Handle edge cases: existing `_N` suffixes, files without extensions, nested paths
3. ✅ Build deterministic processing order (input array order)
4. ✅ Return `string[]` aligned with input (resolvedPaths[i] is path for files[i])

**Deliverables:**
- ✅ `resolveConflicts(files: FileInput[]): string[]` function (array aligned with input)
- ✅ `FileInput` interface (file, path, contentHash, created?)

**Files Created:**
- `src/conflicts.ts` — `resolveConflicts()` implementation
- `src/conflicts.test.ts` — 15 unit tests

**Files Modified:**
- `tsconfig.json` — Added `"DOM"` to lib for `File` type
- `src/types.ts` — Added `FileInput` interface
- `src/index.ts` — Exported `FileInput` type and `resolveConflicts` function

**Testing:** 15 tests passing
- ✅ No conflicts returns unchanged paths
- ✅ Single duplicate renamed with `_1` suffix
- ✅ Multiple duplicates with incrementing suffixes
- ✅ Counter skips existing `_N` patterns
- ✅ Files without extension handled
- ✅ Multiple dots in filename (`.tar.gz`)
- ✅ Dotfiles handled correctly
- ✅ Nested paths work
- ✅ Different directories don't conflict
- ✅ Deterministic output for same input
- ✅ Large batch (100+ duplicates) with all unique paths
- ✅ Root-level duplicates (no `//` in output)
- ✅ Invalid paths throw `ValidationError`
- ✅ Returned array aligned with input array

---

## Phase 5: Directory Inference & Validation ✅

**Status:** Complete

**Goal:** Build directory structure from file paths and explicit directory inputs.

**Tasks:**
1. ✅ Implement directory inference from file paths
2. ✅ Merge inferred directories with explicit `DirectoryInput[]`
3. ✅ Deduplicate and sort directories by path
4. ✅ Validate path formats (no double slashes, proper root)
5. ✅ Build `DirectoryInfo[]` with name extraction and created timestamps

**Deliverables:**
- ✅ `buildDirectoryTree()` function
- ✅ `DirectoryInput` interface
- ✅ `BuildDirectoryTreeOptions` interface

**Files Created:**
- `src/directories.ts` — `buildDirectoryTree()` implementation
- `src/directories.test.ts` — 22 unit tests

**Files Modified:**
- `src/types.ts` — Added `DirectoryInput` interface
- `src/index.ts` — Exported Phase 5 types and functions

**Testing:** 22 tests passing
- ✅ Intermediate directories inferred correctly
- ✅ Explicit directories override inferred timestamps
- ✅ Empty directories preserved only when explicitly declared
- ✅ Ancestors of explicit dirs use `defaultCreated` (not inherited)
- ✅ Explicit "/" throws ValidationError
- ✅ Invalid paths in `resolvedPaths` throw ValidationError
- ✅ Timestamp pinned once at function entry for determinism

---

## Phase 6: Chunk Aggregation Engine

**Goal:** Implement the core chunking logic that combines small files and splits large files.

**Tasks:**
1. Implement file sorting/ordering for deterministic chunking
2. Build aggregation algorithm: accumulate small files until ~10MB boundary
3. Implement large file splitting into 10MB chunks
4. Track `offset` and `length` for each file segment within chunks
5. Generate `FileChunk` records with chunk boundaries
6. Apply PADME padding to the final physical chunk

**Deliverables:**
- `ChunkPlan` type describing chunk composition
- `planChunks()` function that produces chunk plan from `FileInput[]`
- PADME padding utility

**Testing:**
- Small files correctly aggregated
- Large files split at 10MB boundaries
- Files spanning multiple chunks have correct offsets
- PADME padding applied only to final chunk
- Empty files produce no chunks

---

## Phase 7: Chunk Encryption Pipeline

**Goal:** Encrypt chunks using the appropriate encryption strategy.

**Tasks:**
1. Implement `encryptChunk()` for single-shot encryption (≤10MB)
2. Implement streaming encryption wrapper for larger chunks (future-proofing)
3. Derive file keys per content hash using `deriveFileKey()`
4. Handle chunk boundaries and byte slicing
5. Track `ChunkEncryption` enum value per chunk

**Deliverables:**
- `encryptChunk()` function
- Encryption mode selection logic
- Key derivation integration

**Testing:**
- Single-shot encryption produces valid ciphertext
- Decryption recovers original bytes
- Different content hashes produce different file keys
- Same content hash within batch produces same file key

---

## Phase 8: CAR File Generation

**Goal:** Build UnixFS directory structure and generate CAR files.

**Tasks:**
1. Build UnixFS directory tree matching batch structure (`/XX/YY/chunkId`)
2. Add encrypted chunks as file nodes
3. Add manifest as `/m` file
4. Implement CAR writer using `@ipld/car`
5. Compute root CID from directory structure
6. Implement segmented CAR generation (10 chunks per segment)

**Deliverables:**
- `buildBatchDirectory()` function
- `generateCarSegment()` function
- Root CID computation

**Testing:**
- Generated CAR is valid and parseable
- Root CID matches expected structure
- Segment boundaries correct
- Paths within CAR follow spec hierarchy

---

## Phase 9: Manifest Construction & Encryption

**Goal:** Build, split, and encrypt manifests.

**Tasks:**
1. Build `RootManifest` from file records and directory info
2. Implement manifest splitting (~1MB per sub-manifest, sorted by path)
3. Build `SubManifestIndex` entries with path ranges
4. Encrypt manifest using `encrypt()` with manifest key
5. Build `ManifestEnvelope` with `wrapKeyAuthenticatedMulti()` for recipients
6. Serialize to Protobuf

**Deliverables:**
- `buildManifest()` function
- Manifest splitting logic
- `encryptManifest()` function
- Recipient key wrapping

**Testing:**
- Manifest round-trips through encryption/decryption
- Large file counts trigger splitting
- All recipients can unwrap manifest key
- Labels preserved in recipient records

---

## Phase 10: Upload Orchestration

**Goal:** Implement the main `uploadBatch()` function.

**Tasks:**
1. Validate inputs (non-empty batch, valid recipients, path formats)
2. Resolve duplicate paths
3. Plan chunks using aggregation engine
4. Generate manifest key via `generateKey()`
5. Encrypt all chunks
6. Build CAR segments
7. Upload segments sequentially via `ipfsClient.uploadCar()`
8. Track `UploadState` after each segment
9. Call progress callbacks at appropriate points
10. Build and return `BatchResult`

**Deliverables:**
- `uploadBatch()` implementation
- Progress callback integration
- `UploadState` tracking

**Testing:**
- End-to-end upload produces valid batch CID
- Progress callbacks fire in correct sequence
- Empty files handled correctly
- Single file batch works
- Large multi-file batch works

---

## Phase 11: Upload Resume Support

**Goal:** Implement resumable uploads from saved state.

**Tasks:**
1. Accept `resumeState` in `UploadOptions`
2. Skip already-completed segments
3. Resume from failed segment
4. Use `ipfsClient.has()` for cross-segment CID deduplication
5. Maintain state consistency across resume attempts
6. Implement `onSegmentComplete` callback for state persistence

**Deliverables:**
- Resume logic in `uploadBatch()`
- State validation on resume
- Segment completion callback

**Testing:**
- Resume from middle of upload completes successfully
- State from interrupted upload is valid for resume
- Completed segments not re-uploaded
- Failed segment correctly retried

---

## Phase 12: AbortSignal Integration (Upload)

**Goal:** Add cancellation support to upload flow.

**Tasks:**
1. Thread `AbortSignal` through all async operations
2. Check signal before each segment upload
3. Allow current segment to complete before aborting
4. Throw `AbortError` with valid `UploadState` for resume

**Deliverables:**
- Cancellation support in `uploadBatch()`
- Clean abort semantics

**Testing:**
- Abort mid-upload throws `AbortError`
- State from abort is valid for resume
- No partial segments left on abort

---

## Phase 13: Manifest Retrieval & Decryption

**Goal:** Implement `getManifest()` function.

**Tasks:**
1. Fetch manifest bytes via `ipfsClient.cat(batchCid, '/m')`
2. Parse `ManifestEnvelope` from Protobuf
3. Find matching recipient by public key
4. Unwrap manifest key using `unwrapKeyAuthenticated()`
5. Decrypt manifest content
6. Parse `RootManifest`
7. Fetch and decrypt sub-manifests if present
8. Merge file records from all sub-manifests
9. Build and return `BatchManifest`

**Deliverables:**
- `getManifest()` implementation
- Sub-manifest handling

**Testing:**
- Manifest decryption succeeds with correct key
- Wrong key throws appropriate error
- Sub-manifests correctly merged
- Large manifest with splits handled

---

## Phase 14: Single File Download

**Goal:** Implement `downloadFile()` function.

**Tasks:**
1. Accept `FileDownloadRef` with chunk references
2. Derive file key from manifest key and content hash
3. Fetch chunks via `ipfsClient.cat()` with concurrency control
4. Decrypt each chunk (single-shot or streaming based on `ChunkEncryption`)
5. Slice decrypted content using `offset`/`length`
6. Yield assembled plaintext as `AsyncIterable<Uint8Array>`
7. Implement retry logic for failed chunk fetches
8. Verify content hash after full assembly (strict mode default)
9. Handle integrity errors per `integrityMode` option

**Deliverables:**
- `downloadFile()` implementation
- Chunk fetch with concurrency
- Integrity verification

**Testing:**
- Downloaded content matches original
- Chunk retry works on transient failure
- Integrity error thrown on corruption (strict mode)
- Integrity callback invoked (warn mode)
- Files spanning multiple chunks reassembled correctly

---

## Phase 15: Multi-File Download

**Goal:** Implement `downloadFiles()` function.

**Tasks:**
1. Accept `FileDownloadRef[]` array
2. Implement parallel file download with configurable concurrency
3. Yield `DownloadedFile` objects as files complete
4. Track multi-file progress
5. Handle errors per `onError` callback presence (continue vs fail-fast)
6. Aggregate progress across all files

**Deliverables:**
- `downloadFiles()` implementation
- Error handling modes
- Multi-file progress tracking

**Testing:**
- Multiple files download in parallel
- Progress tracks all files
- Error callback allows continuation
- Missing error callback fails fast
- Correct ordering of yielded files

---

## Phase 16: AbortSignal Integration (Download)

**Goal:** Add cancellation support to download flows.

**Tasks:**
1. Thread `AbortSignal` through download operations
2. Check signal between chunk fetches
3. Abort in-flight requests on cancellation
4. Discard partial data cleanly

**Deliverables:**
- Cancellation support in `downloadFile()` and `downloadFiles()`

**Testing:**
- Abort stops download promptly
- No resource leaks on abort
- Partial data not returned

---

## Phase 17: Configuration & Module Factory

**Goal:** Create the module entry point with configuration.

**Tasks:**
1. Define `IpfsStorageConfig` interface
2. Implement factory function `createIpfsStorageModule(config)`
3. Apply default values for optional config
4. Validate config on creation
5. Export public API types

**Deliverables:**
- `createIpfsStorageModule()` factory
- Configuration validation
- Public type exports

**Testing:**
- Module creation with minimal config works
- Invalid config throws `ValidationError`
- Defaults applied correctly

---

## Phase 18: Integration Testing

**Goal:** Comprehensive end-to-end testing with realistic scenarios.

**Tasks:**
1. Upload → manifest retrieval → download round-trip
2. Multi-device recipient scenarios
3. Large batch with manifest splitting
4. Resume after simulated failure
5. Concurrent download stress test
6. Edge cases: empty files, empty directories, single file batch, maximum chunk count

**Deliverables:**
- Integration test suite
- Test fixtures and helpers

**Testing:**
- All scenarios pass
- No memory leaks in long-running tests
- Performance acceptable for target file sizes

---

## Phase 19: Documentation & API Polish

**Goal:** Finalize public API and documentation.

**Tasks:**
1. JSDoc comments on all public types and functions
2. README with quick start guide
3. API reference documentation
4. Example code snippets
5. Error handling guide
6. Migration notes if replacing existing module

**Deliverables:**
- Complete JSDoc coverage
- README.md
- Example files

---

## Dependency Graph

```
Phase 0 (Foundation)
    │
    ├──► Phase 1 (Protobuf)
    │        │
    │        └──► Phase 9 (Manifest) ──► Phase 13 (getManifest)
    │
    ├──► Phase 2 (IpfsClient Mock)
    │        │
    │        └──► Phase 8 (CAR) ──► Phase 10 (uploadBatch)
    │
    ├──► Phase 3 (Chunk IDs) ──► Phase 6 (Aggregation)
    │                                   │
    ├──► Phase 4 (Duplicate Paths) ─────┤
    │                                   │
    └──► Phase 5 (Directories) ─────────┴──► Phase 7 (Encryption) ──► Phase 8

Phase 10 (uploadBatch)
    │
    ├──► Phase 11 (Resume)
    └──► Phase 12 (Abort)

Phase 13 (getManifest)
    │
    └──► Phase 14 (downloadFile)
             │
             ├──► Phase 15 (downloadFiles)
             └──► Phase 16 (Abort)

Phases 10-16 ──► Phase 17 (Factory) ──► Phase 18 (Integration) ──► Phase 19 (Docs)
```

---

## Risk Areas & Mitigations

| Risk | Mitigation |
|------|------------|
| PADME padding complexity | Research existing implementations; test with various final chunk sizes |
| CAR generation edge cases | Thorough testing with `@ipld/car` parser; verify against IPFS gateway |
| Memory pressure on large batches | Implement streaming throughout; test with 10GB+ file scenarios |
| Manifest splitting boundary conditions | Unit test with files at exact 1MB boundaries |
| Cross-platform consistency | Test in both Bun and Node early; document any divergence |
| libsodium WASM initialization | Ensure `@filemanager/encryptionv2` handles init; test cold starts |

---

## Estimated Complexity by Phase

| Phase | Complexity | Rationale |
|-------|------------|-----------|
| 0-5 | Low | Foundation work, well-understood patterns |
| 6 | Medium-High | Aggregation algorithm has nuanced boundary conditions |
| 7-8 | Medium | Integration with existing crypto and IPLD libraries |
| 9 | Medium | Manifest splitting logic |
| 10-12 | High | Upload orchestration ties everything together |
| 13-16 | Medium | Follows upload patterns; simpler state |
| 17-19 | Low | Wrapping and documentation |

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

## Phase 6: Chunk Aggregation Engine ✅

**Status:** Complete

**Goal:** Implement the core chunking logic that combines small files and splits large files.

**Tasks:**
1. ✅ Implement file ordering for deterministic chunking (input array order, caller controls sorting)
2. ✅ Build aggregation algorithm: accumulate small files until ~10MB boundary
3. ✅ Implement large file splitting into 10MB chunks
4. ✅ Track `offset` and `length` for each file segment within chunks
5. ✅ Generate `PlannedChunkRef` records with chunk boundaries
6. ✅ Apply PADME padding to the final physical chunk
7. ✅ Dynamic encryption mode selection (SINGLE_SHOT vs STREAMING based on chunk size)
8. ✅ Input validation (array alignment, path format, chunkSize > 0)

**Deliverables:**
- ✅ `ChunkPlan` type describing chunk composition
- ✅ `planChunks()` function that produces chunk plan from `FileInput[]`
- ✅ PADME padding utilities (`padme()`, `padmeWithDetails()`)
- ✅ Supporting types: `FileSegment`, `PlannedChunk`, `PlannedChunkRef`, `PlannedFile`, `PlanChunksOptions`

**Files Created:**
- `src/padme.ts` — PADME padding algorithm (≤12% overhead, mantissa/exponent masking)
- `src/padme.test.ts` — 20 unit tests
- `src/chunk-plan.ts` — Chunk planning types and `planChunks()` function
- `src/chunk-plan.test.ts` — 35 unit tests

**Files Modified:**
- `src/index.ts` — Exported Phase 6 types and functions

**Testing:** 55 tests passing
- ✅ PADME: zero/tiny sizes unchanged, overhead caps (12% max), determinism, idempotency
- ✅ Validation: array alignment, invalid paths, chunkSize <= 0 rejected
- ✅ Empty files: produce no chunks, manifest entry only
- ✅ Small file aggregation: combine until ~10MB, track offsets
- ✅ Large file splitting: 10MB chunks, correct segment boundaries
- ✅ Spec example: a.txt(1MB) + b.txt(2MB) + c.txt(9MB) + d.txt(25MB) → 5 chunks
- ✅ PADME padding applied only to final chunk
- ✅ Encryption mode: SINGLE_SHOT for ≤10MB, STREAMING for >10MB
- ✅ Chunk ref consistency with chunk encryption

---

## Phase 7: Chunk Encryption Pipeline ✅

**Status:** Complete

**Goal:** Encrypt chunks using per-segment encryption with file-derived keys.

**Tasks:**
1. ✅ Implement `encryptChunk()` for single-shot encryption (≤10MB)
2. ✅ Implement streaming encryption for larger segments (>10MB)
3. ✅ Derive file keys per content hash using `deriveFileKey(manifestKey, contentHash)`
4. ✅ Handle per-segment encryption within aggregated chunks
5. ✅ Track `ChunkEncryption` enum value per chunk
6. ✅ Apply PADME padding to final chunk's last segment
7. ✅ Store `encryptedLength` per segment for exact ciphertext extraction
8. ✅ Add AbortSignal support with multiple checkpoints

**Deliverables:**
- ✅ `encryptChunk()` and `encryptChunks()` functions
- ✅ `createFileDataProvider()` for file access with bounds checking
- ✅ `computeEncryptedLength()` (deprecated for extraction, use `encryptedLength` field)
- ✅ `decryptSingleShot()` and `decryptStreaming()` helpers
- ✅ `EncryptedChunk`, `EncryptedSegmentInfo`, `FileDataProvider` types
- ✅ Updated `ChunkRef` schema with `encryptedLength` field (proto + TS)

**Files Created:**
- `src/chunk-encrypt.ts` — Per-segment encryption pipeline (486 lines)
- `src/chunk-encrypt.test.ts` — 38 unit tests

**Files Modified:**
- `src/constants.ts` — Added encryption constants (NONCE_SIZE, AUTH_TAG_SIZE, SINGLE_SHOT_OVERHEAD, STREAM_HEADER_SIZE, STREAM_CHUNK_OVERHEAD, STREAM_CHUNK_SIZE)
- `proto/manifest.proto` — Added `encrypted_length` field to `FileChunk` message
- `src/types.ts` — Added `encryptedLength` to `ChunkRef` interface
- `src/serialization.ts` — Updated converters for `encryptedLength`
- `src/serialization.test.ts` — Updated test data with `encryptedLength`
- `src/index.ts` — Exported Phase 7 types and functions

**Testing:** 38 tests passing
- ✅ `computeEncryptedLength()` formulas for SINGLE_SHOT and STREAMING
- ✅ `FileDataProvider` bounds checking (invalid index, offset, length)
- ✅ Single-shot round-trip: encrypt → decrypt → verify
- ✅ Streaming round-trip: with/without padding, exact boundary
- ✅ Multi-segment chunks: each segment uses correct derived key
- ✅ Encrypted offsets cumulative and correct
- ✅ PADME padding: `plaintextLength` = original, `encryptedLength` = padded
- ✅ Invariant validation: `paddedSize >= dataSize`
- ✅ AbortSignal cancellation at multiple checkpoints
- ✅ Generator yields chunks in order
- ✅ Integration: aggregated files decrypt with segment boundaries

**Key Design Decisions:**
- Per-segment encryption: each file segment encrypted with `deriveFileKey(manifestKey, contentHash)`
- `encryptedLength` stored per segment (not computed) to handle PADME padding correctly
- `STREAM_CHUNK_SIZE` locked at 64KB (not configurable) for encrypt/decrypt consistency
- Download uses `ref.encryptedLength` for extraction, not `computeEncryptedLength(ref.length)`

---

## Phase 8: CAR File Generation ✅

**Status:** Complete

**Goal:** Build UnixFS directory structure and generate CAR files for IPFS upload.

**Design Decisions:**

| Topic | Decision | Rationale |
|-------|----------|-----------|
| Chunk codec | raw (0x55) | Opaque encrypted bytes, no structure |
| Manifest `/m` codec | raw (0x55) | Opaque encrypted bytes |
| Sub-manifest `/m_N` codec | raw (0x55) | Opaque encrypted bytes (same as manifest) |
| Directory codec | dag-pb (0x70) | UnixFS directory standard for path resolution |
| Directory placement | Final segment only | All CIDs known upfront; atomic completion; simpler resume |
| Manifest placement | Final segment, linked from root | Ensures chunks exist before manifest references them |
| Sub-manifests | Final segment as `/m_0`, `/m_1`, ... | Same rationale as manifest |
| Non-final CAR roots | `roots: []` (empty) | Avoids "root not present" validation errors on headless segments |
| Final CAR roots | `roots: [rootCid]` | Standard single-root CAR |
| Link ordering | Byte-wise compare (`a < b ? -1 : a > b ? 1 : 0`) | Locale-independent determinism |

**Segment Layout:**
```
Segment 0:     roots: []                  ← empty roots (headless CAR)
               [chunk0..chunk9]           ← raw blocks only

Segment 1:     roots: []                  ← empty roots (headless CAR)
               [chunk10..chunk19]         ← raw blocks only
...
Segment N-1:   roots: [rootCid]           ← real root declared
               [remaining chunks]         ← raw blocks
               [level-2 dirs: 6B/v7, ...]  ← dag-pb directories
               [level-1 dirs: 6B, 9c, ...] ← dag-pb directories
               [root directory]            ← links to level-1 + manifests
               [/m manifest]               ← encrypted root manifest
               [/m_0, /m_1, ...]           ← sub-manifests if any
```

**Determinism Rules (for identical CARs on re-upload):**

| Aspect | Rule |
|--------|------|
| Directory link order | Links sorted by byte-wise string comparison (NOT localeCompare) |
| PBLink.Tsize | Size of the **linked block's encoded bytes** (NOT cumulative subtree) |
| Block write order | Chunks in input order → level-2 dirs (sorted) → level-1 dirs (sorted) → root → manifest → sub-manifests |
| CAR header | Version 1, roots as specified above |

**Deliverables:**
- ✅ `buildBatchDirectory(options): Promise<BatchDirectoryResult>` — builds UnixFS tree
- ✅ `buildCarSegments(options): Promise<CarSegmentsResult>` — creates segment generators
- ✅ `CarBlock`, `BatchDirectoryResult`, `CarSegmentGenerator`, `CarSegmentsResult` types
- ✅ Input validation (empty chunks, empty manifest, empty sub-manifests, segmentSize <= 0)

**Files Created:**
- `src/car-builder.ts` — CAR generation logic (350 lines)
- `src/car-builder.test.ts` — 42 unit tests

**Files Modified:**
- `src/index.ts` — Export CAR builder types and functions
- `src/ipfs-client.ts` — Updated MockIpfsClient to support headless CARs (empty roots)

**Testing:** 42 tests passing

*Input Validation:*
- ✅ Empty chunks array throws ValidationError
- ✅ Empty manifest throws ValidationError
- ✅ Chunk with empty encryptedData throws ValidationError
- ✅ Zero-length sub-manifest throws ValidationError
- ✅ segmentSize <= 0 throws ValidationError

*CID & Codec:*
- ✅ Chunks use raw codec (0x55), CID prefix `bafkrei...`
- ✅ Manifest `/m` uses raw codec (0x55), CID prefix `bafkrei...`
- ✅ Sub-manifests `/m_0`, `/m_1` use raw codec (0x55), CID prefix `bafkrei...`
- ✅ Directories use dag-pb codec (0x70), CID prefix `bafybei...`
- ✅ Same input → same CID (deterministic)

*Directory Structure:*
- ✅ Level-2 dirs contain chunk links with correct Tsize
- ✅ Level-1 dirs contain level-2 dir links with correct Tsize
- ✅ Root dir contains level-1 dirs + manifest + sub-manifests
- ✅ All directory links sorted lexicographically by Name
- ✅ Tsize for dir links equals encoded dir bytes, not subtree sum

*Segmentation:*
- ✅ Single segment: 1-10 chunks → 1 segment with `isLast: true`
- ✅ Multi-segment: 25 chunks → 3 segments (10 + 10 + 5+dirs+manifest)
- ✅ Exact boundaries: 10, 20 chunks produce correct segment counts
- ✅ Non-final segments: raw blocks only, `roots: []` (empty)
- ✅ Final segment: chunks + dirs + manifest, `roots: [rootCid]`
- ✅ Custom segmentSize parameter works correctly

*CAR Validity:*
- ✅ Non-final CARs parseable with empty roots
- ✅ Final CAR parseable with single root
- ✅ All blocks in CAR have valid CIDs matching content
- ✅ CAR header roots match segment.roots
- ✅ Manifests only in final segment CAR

*Determinism:*
- ✅ Re-generate same fixed chunks produces byte-identical CAR
- ✅ Directory link order is byte-wise sorted (not locale-dependent)
- ✅ chunkCidMap entries match actual block CIDs

*Round-trip with MockIpfsClient:*
- ✅ Upload all segments → `cat(rootCid, '/m')` returns manifest bytes
- ✅ Upload all segments → `cat(rootCid, '/6B/v7/chunkId')` returns chunk bytes
- ✅ Upload all segments → `cat(rootCid, '/m_0')` returns first sub-manifest
- ✅ 15 chunks batch: all paths resolve correctly

*Edge Cases:*
- ✅ Empty `subManifests` array → no `/m_N` links
- ✅ 1-byte chunk works correctly
- ✅ Chunk IDs with leading `1` (base58 edge case) resolve
- ✅ Many chunks in same level-2 dir work correctly
- ✅ Sub-manifests array with 3 entries all accessible

---

## Phase 9: Manifest Construction & Encryption ✅

**Status:** Complete

**Goal:** Build, split, and encrypt manifests.

**Tasks:**
1. ✅ Build `RootManifest` from file records and directory info
2. ✅ Implement manifest splitting (~1MB per sub-manifest, sorted by path)
3. ✅ Build `SubManifestIndex` entries with path ranges
4. ✅ Encrypt manifest using `encrypt()` with manifest key
5. ✅ Build `ManifestEnvelope` with `wrapKeyAuthenticatedMulti()` for recipients
6. ✅ Serialize to Protobuf

**Design Decisions:**

| Topic | Decision | Rationale |
|-------|----------|-----------|
| Split threshold | Encoded protobuf bytes | `encodeSubManifest().length`, not payload sum |
| manifest_id naming | Zero-based `m_0`, `m_1`, ... | Matches Phase 8 CAR `/m_N` paths |
| Path sorting | True UTF-8 byte comparison | Uses TextEncoder to compare actual bytes, not UTF-16 code units |
| Domain separation | `MANIFEST_DOMAIN.ROOT` vs `.SUB` | Different contexts prevent cross-usage attacks |
| Directory placement | Root manifest only | Directories never split; Phase 13 reads dirs from root |
| Single file handling | Always in root | Splitting only makes sense with multiple files |
| Recipients validation | Check before encryption | `recipients.length === 0` throws ValidationError |
| maxSubManifestSize validation | Must be positive | Zero/negative values throw ValidationError |

**Deliverables:**
- ✅ `sortFilesByPath()` function (byte-wise deterministic sort)
- ✅ `buildManifest()` function with optional splitting
- ✅ `encryptManifest()` function with domain separation
- ✅ `buildAndEncryptManifest()` convenience function
- ✅ `RecipientInfo` interface for upload input
- ✅ `MANIFEST_DOMAIN` constants for encryption contexts

**Files Created:**
- `src/manifest-builder.ts` — Core manifest building and encryption (290 lines)
- `src/manifest-builder.test.ts` — 37 unit tests

**Files Modified:**
- `src/types.ts` — Added `RecipientInfo` interface
- `src/constants.ts` — Added `MANIFEST_DOMAIN` constants
- `src/index.ts` — Exported Phase 9 types and functions

**Testing:** 37 tests passing
- ✅ `sortFilesByPath()` byte-wise ordering, special chars, unicode
- ✅ `sortFilesByPath()` UTF-8 bytes vs UTF-16 code units (emoji, BMP chars)
- ✅ `sortFilesByPath()` multi-byte UTF-8 sequences (CJK, Greek, ASCII)
- ✅ `buildManifest()` no splitting for small batches
- ✅ `buildManifest()` triggers splitting for large batches
- ✅ `buildManifest()` directories stay in root (never split)
- ✅ Sub-manifest index has correct path ranges (startPath/endPath)
- ✅ Single file never splits unnecessarily
- ✅ Empty files array (directories only) is valid
- ✅ Throws ValidationError for zero/negative maxSubManifestSize
- ✅ `encryptManifest()` round-trip encrypt/decrypt
- ✅ Multiple recipients can all unwrap manifest key
- ✅ Labels preserved in recipient records
- ✅ Throws ValidationError for empty recipients
- ✅ Sub-manifests use different domain context than root
- ✅ Integration: large manifest with splitting round-trips correctly

---

## Phase 10: Upload Orchestration ✅

**Status:** Complete

**Goal:** Implement the main `uploadBatch()` function.

**Tasks:**
1. ✅ Validate inputs (non-empty batch, valid recipients, path formats)
2. ✅ Resolve duplicate paths
3. ✅ Plan chunks using aggregation engine
4. ✅ Generate manifest key via `generateKey()`
5. ✅ Encrypt all chunks
6. ✅ Build CAR segments (two-pass: first for CID map, second with real manifest)
7. ✅ Upload segments sequentially via `ipfsClient.uploadCar()`
8. ✅ Track `UploadState` after each segment
9. ✅ Call progress callbacks at appropriate points
10. ✅ Build and return `BatchResult`

**Design Decisions:**

| Topic | Decision | Rationale |
|-------|----------|-----------|
| CID source of truth | `buildCarSegments().chunkCidMap` | Avoids CID divergence between manifest and CAR |
| Two-pass CAR build | First pass gets CIDs, second builds final | CIDs are deterministic, so same result |
| Manifest key flow | Generate once, pass to `encryptManifest()` | Avoids generating second key in buildAndEncryptManifest |
| Empty batch handling | `buildEmptyBatchCar()` helper | buildCarSegments rejects empty chunks array |
| ChunkRef mapping | Use `EncryptedSegmentInfo` fields directly | offset=encryptedOffset, length=plaintextLength, encryptedLength includes PADME |
| BatchManifest construction | Built from source data, not re-decrypted | Avoids unnecessary decrypt round-trip |

**Deliverables:**
- ✅ `uploadBatch()` implementation with 14-step orchestration
- ✅ Progress callback integration (`onProgress`)
- ✅ Segment completion callback (`onSegmentComplete`)
- ✅ `UploadState` tracking with `chunkCids` populated before upload
- ✅ `buildEmptyBatchCar()` helper for all-empty-file batches
- ✅ Upload types: `UploadOptions`, `BatchResult`, `RenamedFile`, `UploadProgress`, `SegmentResult`

**Files Created:**
- `src/upload.ts` — Main upload orchestration (400 lines)
- `src/upload.test.ts` — Phase A tests (24 tests)

**Files Modified:**
- `src/types.ts` — Added upload types (UploadOptions, BatchResult, UploadProgress, etc.)
- `src/index.ts` — Exported Phase 10 types and functions
- `src/car-builder.ts` — Stricter segmentSize validation (defense in depth)

**Bug Fixes Applied:**

| Issue | Fix |
|-------|-----|
| `BatchResult.totalSize` ignored manifest/directory bytes | Now tracks actual bytes uploaded via CAR generator wrapper |
| Empty batches reported `totalSize: 0` | Now uses `emptyCarResult.carBytes.length` |
| `segmentSize` accepted NaN/Infinity/non-integers | Added `Number.isFinite()` + `Number.isInteger()` validation |
| `buildCarSegments()` only checked `<= 0` | Mirrored stricter validation for defense in depth |

**Testing:** 24 tests passing (Phase A expanded)

*Validation:*
- ✅ Empty files array throws ValidationError
- ✅ Empty recipients throws ValidationError
- ✅ Invalid paths throw ValidationError

*segmentSize Validation:*
- ✅ NaN throws ValidationError
- ✅ Infinity throws ValidationError
- ✅ Negative throws ValidationError
- ✅ Zero throws ValidationError
- ✅ Non-integer (e.g., 5.5) throws ValidationError

*Single File:*
- ✅ Small file uploads successfully with dag-pb CID
- ✅ Returns correct BatchResult structure
- ✅ BatchResult.manifest has correct FileInfo with ChunkRef

*Round-trip Verification:*
- ✅ Upload → `cat('/m')` returns valid manifest envelope
- ✅ Upload → `cat('/{chunkPath}')` returns encrypted chunk
- ✅ Chunk decrypts correctly with derived file key (includes PADME trim)

*Empty Files:*
- ✅ Single empty file (0 bytes) uploads with totalSize > 0
- ✅ All-empty-file batch uses buildEmptyBatchCar path
- ✅ Mix of empty and non-empty files handled correctly
- ✅ Empty batch cat(/m) returns valid manifest envelope

*Multi-Segment:*
- ✅ segmentSize=1 creates expected segments
- ✅ onSegmentComplete callback fires for each segment
- ✅ totalSize includes manifest and directory overhead

*Error Handling:*
- ✅ Upload failure throws SegmentUploadError
- ✅ SegmentUploadError contains valid UploadState
- ✅ UploadState has chunkCids populated before upload

**Orchestration Flow:**
```
1. VALIDATION → files.length > 0, recipients.length > 0, valid paths
2. CONFLICT RESOLUTION → resolveConflicts(files)
3. DIRECTORY BUILDING → buildDirectoryTree(resolvedPaths, directories)
4. CHUNK PLANNING → planChunks(files, resolvedPaths)
5. MANIFEST KEY GENERATION → generateKey()
6. CHUNK ENCRYPTION → encryptChunks(plan, files, manifestKey)
7. EMPTY BATCH CHECK → buildEmptyBatchCar() if no chunks
8. FIRST CAR BUILD → get chunkCidMap as single source of truth
9. BUILD FILE INFO → map PlannedChunkRef + EncryptedSegmentInfo → ChunkRef
10. MANIFEST ENCRYPTION → buildManifest() + encryptManifest(manifestKey)
11. FINAL CAR BUILD → buildCarSegments() with real manifest
12. INITIALIZE UPLOAD STATE → batchId, segments, chunkCids
13. UPLOAD SEGMENTS → sequential upload with state tracking
14. BUILD RESULT → BatchManifest from source data
```

---

## Phase 11: Upload Resume Support ✅

**Status:** Complete (with limitations)

**Goal:** Implement resumable uploads from saved state.

**Key Discovery:** Encryption uses random nonces (libsodium secretbox), so re-encryption produces different ciphertext and different CIDs. True segment skipping would require either:
1. Deterministic encryption (derive nonces from content hash)
2. Storing encrypted chunk bytes in resume state

Neither is implemented, so **resume preserves the manifestKey but re-uploads all segments**.

**Design Decisions:**

| Topic | Decision | Rationale |
|-------|----------|-----------|
| ManifestKey storage | Base64 string in `UploadState` | JSON-serializable for persistence |
| Timestamp preservation | `created` field in `UploadState` | Stable batch timestamp across resume attempts |
| Segment skipping | **Not implemented** | CIDs are non-deterministic; skipping causes batch corruption |
| CID validation | **Removed** | Re-encryption produces different CIDs each time |
| `verifyResumeState` | **Deprecated (no-op)** | Verification meaningless without deterministic CIDs |
| Segment count validation | Enforced | Catches file list changes between attempts |
| ManifestKey reuse | Implemented | Same file keys → previously-downloaded files still decryptable |

**Tasks:**
1. ✅ Accept `resumeState` in `UploadOptions`
2. ✅ Validate segment count matches (throws `ResumeValidationError` on mismatch)
3. ✅ Decode and reuse `manifestKeyBase64` from resume state
4. ✅ Store `manifestKeyBase64` in `UploadState` for JSON serialization
5. ✅ Add `ResumeValidationError` class for validation failures
6. ✅ Document limitations in JSDoc (segment skipping not supported)
7. ✅ Preserve `created` timestamp across resume attempts
8. ❌ Skip already-completed segments (removed - causes corruption)
9. ❌ CID validation (removed - CIDs are non-deterministic)
10. ❌ `verifyResumeState` functionality (deprecated - no effect)

**Deliverables:**
- ✅ `resumeState` option in `UploadOptions`
- ✅ `manifestKeyBase64` field in `UploadState`
- ✅ `created` field in `UploadState` (optional, backward-compatible)
- ✅ `ResumeValidationError` class
- ✅ `assertValidResumeState()` structure validation
- ✅ `validateResumeState()` segment count validation (returns void)
- ⚠️ `verifyResumeState` option (deprecated, no-op)
- ⚠️ `chunksSkipped` fields (deprecated, always 0)

**Files Modified:**
- `src/upload.ts` — Resume logic, validation helpers, timestamp preservation
- `src/errors.ts` — Added `ResumeValidationError`, `manifestKeyBase64`, `created` to `UploadStateForError`
- `src/types.ts` — Added `verifyResumeState` option (deprecated), updated JSDoc
- `src/index.ts` — Exported `ResumeValidationError`

**Testing:** 37 tests passing
- ✅ Structure validation (missing fields, invalid base64, wrong key length)
- ✅ Segment count mismatch throws `ResumeValidationError`
- ✅ Resume reuses manifestKey from state
- ✅ Resume re-uploads all segments (no skipping)
- ✅ `UploadState` survives JSON round-trip
- ✅ Resumed upload produces retrievable, decryptable data
- ✅ Data integrity after resume (manifest retrieval, chunk decryption)

**Current Resume Behavior:**
```
Initial Upload (fails at segment 2):
  segment[0]: complete → state saved (includes created timestamp)
  segment[1]: complete → state saved
  segment[2]: uploading → error thrown with UploadState

Resume (from saved state):
  segment[0]: re-uploaded (new CID)
  segment[1]: re-uploaded (new CID)
  segment[2]: re-uploaded (new CID)
  segment[3]: uploaded

Result: New rootCid (different from original attempt)
        Same file keys (manifestKey preserved)
        Same batch timestamp (created preserved from state)
        Previously-downloaded files still decryptable
```

**Limitations:**
- All segments re-uploaded on resume (no bandwidth savings)
- New rootCid generated each attempt (CIDs not stable)
- `verifyResumeState` option has no effect

**Future Enhancement (not planned):**
To enable true segment skipping, would need deterministic encryption where nonces are derived from content (e.g., `nonce = hash(fileKey || offset)`). This is a significant crypto architecture change.

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

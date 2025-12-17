# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser-first TypeScript library for IPFS-based encrypted batch storage. Stateless module — client stores manifests locally.

**Package:** `@0xd49daa/ipfs-storage`
**Runtime:** Browser (primary), Bun (secondary)
**Serialization:** Protocol Buffers
**Crypto:** `@0xd49daa/safecrypt`

## Version Management

When updating the package version, update both files:
- `package.json` — npm/bun version
- `jsr.json` — JSR registry version

## Development Commands

```bash
bun install              # Install dependencies
bun test                 # Run tests
bun test --watch         # Watch mode
bun test src/upload.test.ts  # Single test file
bun run typecheck        # Type check
```

## Architecture

### Public API

```typescript
interface IpfsStorageModule {
  uploadBatch(files: FileInput[], options: UploadOptions): Promise<BatchResult>
  getManifest(batchCid: string, options: ReadOptions): Promise<BatchManifest>
  downloadFile(file: FileDownloadRef, options?: DownloadOptions): AsyncIterable<Uint8Array>
  downloadFiles(files: FileDownloadRef[], options?: DownloadFilesOptions): AsyncIterable<DownloadedFile>
}
```

### Batch Structure

```
batch_root/
  ├── 6B/v7/6Bv7HnWcL4mT9Rp2QsXx3a   ← encrypted chunk
  ├── 9c/Ld/9cLdPx8Yk2RmNp3QwT5f1b   ← encrypted chunk
  ├── m                               ← root manifest (encrypted)
  └── m_0, m_1...                     ← sub-manifests (if needed)
```

**Chunk ID:** `base58(crypto.randomUUID())` → 22 chars
**Chunk path:** `{id[0:2]}/{id[2:4]}/{id}` → supports petabyte+ scale

### Chunk Aggregation

| File size | Strategy |
|-----------|----------|
| < 10MB | Aggregate into shared chunk until ~10MB |
| ≥ 10MB | Split into dedicated 10MB chunks |

Files packed sequentially with `offset`/`length` in manifest. PADME padding on final chunk.

### Key Derivation

```typescript
// Domain separation constant
const DOMAIN = { FILE_KEY: 'ipfs-storage:file-key:v1' }

// File key derived from manifest key + content hash
fileKey = hashBlake2b(concat(
  utf8Encode(DOMAIN.FILE_KEY),  // 24 bytes
  manifestKey,                   // 32 bytes
  contentHash,                   // 32 bytes
), 32)
```

## Cryptography Mapping

All crypto via `@0xd49daa/safecrypt`:

| Operation | Function |
|-----------|----------|
| Manifest key | `generateKey()` |
| File key derivation | `hashBlake2b(DOMAIN ‖ manifestKey ‖ contentHash, 32)` |
| Chunk encrypt (≤10MB) | `encrypt()` / `decrypt()` |
| Chunk encrypt (>10MB) | `createEncryptStream()` / `createDecryptStream()` |
| Manifest encrypt | `encrypt()` |
| Key wrap (multi-device) | `wrapKeyAuthenticatedMulti()` |
| Key unwrap | `unwrapKeyAuthenticated()` |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@0xd49daa/safecrypt` | All cryptographic operations |
| `@ipld/car` | CAR file generation |
| `@ipld/unixfs` | UnixFS directory building |
| `multiformats` | CID handling |
| `@bufbuild/protobuf` | Protocol Buffers |
| `@scure/base` | base58 encoding |

## Key Design Decisions

| Topic | Decision |
|-------|----------|
| Input format | `FileInput[]` with full path |
| Directory support | Full hierarchy with path, name, created |
| Symmetric key scope | One manifest_key per batch; file keys derived on-the-fly |
| Upload strategy | Segmented CAR (10 chunks/segment, ~100MB) |
| Chunk deduplication | Resume only, not cross-batch |
| Content hash | Trust caller on upload, verify on download |
| Duplicate paths | Auto-rename: `photo.jpg` → `photo_1.jpg` |
| Empty files | Allowed; manifest only |
| Empty directories | Only if explicitly provided |

## Error Classes

| Class | Meaning |
|-------|---------|
| `ValidationError` | Empty batch, invalid path format, no recipients |
| `IntegrityError` | Content hash mismatch on download |
| `ManifestError` | Cannot parse or decrypt manifest |
| `ChunkUnavailableError` | Chunk fetch failed after retries |
| `SegmentUploadError` | Segment upload failed, includes resume state |
| `CidMismatchError` | CID verification failed |

## Key Documents

- `IPFS-STORAGE-SPEC.md` — Full technical specification
- `IPFS-STORAGE-PLAN.md` — Implementation plan with phases

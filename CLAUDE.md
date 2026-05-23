# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

Browser-first TypeScript library for IPFS-based encrypted batch storage.
Stateless module — client stores manifests locally.

**Package:** `@0xd49daa/ipfs-storage` **Runtime:** Browser (primary), Deno
(development/testing) **Serialization:** Protocol Buffers **Crypto:** WebCrypto
AES-GCM and `@noble/hashes`

## Version Management

When updating the package version, update `deno.json`.

## Development Commands

```bash
deno task test           # Run tests
deno test --watch src    # Watch mode
deno test src/upload-retry.test.ts  # Single test file
deno task typecheck      # Type check
```

## Architecture

### Public API

```typescript
interface IpfsStorageModule {
  uploadBatch(
    files: AsyncIterable<StreamingFileInput>,
    options: UploadOptions,
  ): Promise<BatchResult>;
  getManifest(batchCid: string, options: ReadOptions): Promise<BatchManifest>;
  downloadFile(
    file: FileDownloadRef,
    options: DownloadOptions,
  ): AsyncIterable<Uint8Array>;
  downloadFiles(
    files: FileDownloadRef[],
    options: DownloadFilesOptions,
  ): AsyncIterable<DownloadedFile>;
}
```

### Batch Structure

```
batch_root/
  ├── 6B/v7/6Bv7HnWcL4mT9Rp2QsXx3a   ← encrypted chunk
  ├── 9c/Ld/9cLdPx8Yk2RmNp3QwT5f1b   ← encrypted chunk
  ├── m                               ← batch_id prefix + encrypted root manifest
  └── m_0, m_1...                     ← sub-manifests (if needed)
```

**Chunk ID:** `base58(crypto.randomUUID())` → 22 chars **Chunk path:**
`{id[0:2]}/{id[2:4]}/{id}` → supports petabyte+ scale

### Chunk Aggregation

| File size | Strategy                                  |
| --------- | ----------------------------------------- |
| < 16 MiB  | Aggregate into shared chunk until ~16 MiB |
| ≥ 16 MiB  | Split into dedicated 16 MiB chunks        |

Files packed sequentially with `offset`/`length` in manifest. PADME padding on
final chunk.

### Key Scope

The package is symmetric-only. Callers provide a 32-byte `manifestKey` and a
16-byte `batch_id`. Manifest records use the `manifestKey` directly. Chunk file
keys are derived from the `manifestKey` and the file path hash.

## Cryptography Mapping

Crypto uses WebCrypto AES-GCM for Vault AEAD records plus `@noble/hashes` for
content hashing:

| Operation             | Implementation                                     |
| --------------------- | -------------------------------------------------- |
| Manifest key          | Caller-provided 32-byte AES-256 key                |
| Batch id              | Caller-provided 16-byte random value               |
| Chunk key derivation  | WebCrypto HKDF over `manifestKey` + file path hash |
| Chunk encrypt/decrypt | Vault AES-GCM AEAD record, key scope `0x04`        |
| Manifest encrypt      | Vault AES-GCM AEAD record, key scope `0x05`        |
| Content hash          | `hashContent(content)`                             |

## Dependencies

| Package              | Purpose                     |
| -------------------- | --------------------------- |
| `@noble/hashes`      | Content hash implementation |
| `@ipld/car`          | CAR file generation         |
| `@ipld/unixfs`       | UnixFS directory building   |
| `multiformats`       | CID handling                |
| `@bufbuild/protobuf` | Protocol Buffers            |
| `@scure/base`        | base58 encoding             |

## Key Design Decisions

| Topic               | Decision                                                 |
| ------------------- | -------------------------------------------------------- |
| Input format        | `AsyncIterable<StreamingFileInput>` with full path       |
| Directory support   | Full hierarchy with path, name, created                  |
| Symmetric key scope | One manifest_key per batch; file keys derived on-the-fly |
| Upload strategy     | Segmented CAR (10 chunks/segment, ~100MB)                |
| Chunk deduplication | Resume only, not cross-batch                             |
| Content hash        | Trust caller on upload, verify on download               |
| Duplicate paths     | Auto-rename: `photo.jpg` → `photo_1.jpg`                 |
| Empty files         | Allowed; manifest only                                   |
| Empty directories   | Only if explicitly provided                              |

## Error Classes

| Class                   | Meaning                                      |
| ----------------------- | -------------------------------------------- |
| `ValidationError`       | Invalid paths, missing key, invalid batch id |
| `IntegrityError`        | Content hash mismatch on download            |
| `ManifestError`         | Cannot parse or decrypt manifest             |
| `ChunkUnavailableError` | Chunk fetch failed after retries             |
| `SegmentUploadError`    | Segment upload failed, includes resume state |
| `CidMismatchError`      | CID verification failed                      |

## Key Documents

- `IPFS-STORAGE-SPEC.md` — Full technical specification
- `IPFS-STORAGE-PLAN.md` — Implementation plan with phases

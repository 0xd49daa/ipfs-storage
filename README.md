# @0xd49daa/ipfs-storage

[![JSR](https://jsr.io/badges/@0xd49daa/ipfs-storage)](https://jsr.io/@0xd49daa/ipfs-storage)

Browser-first TypeScript library for IPFS-based encrypted batch storage. The
current package is symmetric-only: callers provide a 32-byte `manifestKey` and a
16-byte `batch_id`; the package encrypts chunks and manifests before upload and
never performs recipient key wrapping.

## Features

- **Symmetric-only API** — Upload, manifest retrieval, and download all use a
  caller-owned `manifestKey`.
- **Vault v0.34 wire format** — Chunks and manifests are encoded as canonical
  AES-GCM AEAD records with Vault-compatible AAD.
- **Streaming upload and download** — Handles large files with bounded memory.
- **Protocol Buffers** — Compact manifest encoding with explicit manifest
  version support.
- **PADME padding** — Pads chunk and manifest plaintext before encryption.
- **Abort support** — Cancel operations with `AbortSignal`.
- **No plaintext at rest** — The library does not write decrypted files, OPFS
  caches, or temporary plaintext storage.

## Installation

```bash
deno add jsr:@0xd49daa/ipfs-storage
```

## Quick Start

```typescript
import {
  asAsyncIterable,
  createIpfsStorageModule,
  MockIpfsClient,
  type StreamingFileInput,
  type SymmetricKey,
} from "@0xd49daa/ipfs-storage";
import { hashBlake2b } from "@0xd49daa/safecrypt";

const storage = createIpfsStorageModule({
  ipfsClient: new MockIpfsClient(),
});

const content = new TextEncoder().encode("Hello, IPFS!");

const manifestKey = crypto.getRandomValues(new Uint8Array(32)) as SymmetricKey;
const batch_id = crypto.getRandomValues(new Uint8Array(16));

const file: StreamingFileInput = {
  path: "/hello.txt",
  size: content.length,
  contentHash: await hashBlake2b(content, 32),
  getStream: () => asAsyncIterable([content]),
};

const result = await storage.uploadBatch(asAsyncIterable([file]), {
  manifestKey,
  batch_id,
});

console.log("Batch CID:", result.cid);

const manifest = await storage.getManifest(result.cid, { manifestKey });
const firstFile = manifest.files[0]!;

const fileRef = {
  batchCid: manifest.cid,
  path: firstFile.path,
  size: firstFile.size,
  contentHash: firstFile.contentHash,
  chunks: firstFile.chunks,
};

for await (const chunk of storage.downloadFile(fileRef, { manifestKey })) {
  // Process decrypted bytes. The library does not persist plaintext.
}
```

## API Overview

| Method | Description |
| --- | --- |
| `createIpfsStorageModule(config)` | Create a module instance with a bound IPFS client |
| `module.uploadBatch(files, options)` | Upload an encrypted file batch using `manifestKey` and `batch_id` |
| `module.getManifest(cid, options)` | Retrieve and decrypt the manifest using `manifestKey` |
| `module.downloadFile(ref, options)` | Download and decrypt one file |
| `module.downloadFiles(refs, options)` | Download and decrypt multiple files sequentially |
| `getBatchIdFromManifestBlob(blob)` | Parse the plaintext `batch_id` prefix from a root manifest blob |

See [REFERENCE.md](./REFERENCE.md) for complete API documentation.

## Symmetric Keys

`manifestKey` is a caller-owned 32-byte AES-256 key. The package does not derive
it from a mnemonic, wrap it for recipients, or store it in the manifest. Vault or
another consumer is responsible for deriving, storing, or sharing this key.

`batch_id` is a caller-owned 16-byte random value. It is used as a Vault locator
and as part of AEAD additional authenticated data. Generate a fresh `batch_id`
for each uploaded batch.

## Wire Format Notes

The root manifest is stored at `/m` under the batch root. Its IPFS blob starts
with the plaintext 16-byte `batch_id` locator prefix, followed by the encrypted
root manifest AEAD record. `getBatchIdFromManifestBlob()` parses only this
prefix; it does not decrypt or authenticate the remaining bytes.

Chunks and manifests use the canonical Vault AEAD record layout:

```text
version(1) | key_scope(1) | nonce(12) | ciphertext | tag(16)
```

Supported key scopes are:

| Scope | Value | Used For |
| --- | --- | --- |
| Chunk | `0x04` | Encrypted file chunk records |
| Manifest | `0x05` | Encrypted root and sub-manifest records |

Manifest records use the `manifestKey` directly. Chunk records use file-scoped
keys derived from the `manifestKey` and the file path hash. AEAD AAD binds the
record version, key scope, `batch_id`, and the relevant chunk or manifest node
identity. This README intentionally summarizes the consumer-facing behavior; the
normative format remains Vault Spec v0.34.

## Manifest Versions

The package currently supports manifest schema version `1`, exported as
`MANIFEST_VERSION_SUPPORTED`. Uploads write this version and manifest retrieval
rejects unsupported encrypted manifest versions.

## Plaintext Handling

The library encrypts data before upload and decrypts data only into caller-owned
streams. It never writes plaintext files, OPFS caches, or temporary decrypted
files. `downloadFile()` either yields plaintext chunks as an
`AsyncIterable<Uint8Array>` or writes them to a caller-supplied
`WritableStream<Uint8Array>` through `DownloadOptions.output`. If that stream is
persistent, plaintext persistence is controlled by the caller.

## Error Handling

| Error Class | When Thrown |
| --- | --- |
| `ValidationError` | Invalid inputs such as empty paths, missing `manifestKey`, or invalid `batch_id` |
| `IntegrityError` | Content hash mismatch on download |
| `ManifestError` | Cannot fetch, parse, or decrypt a manifest |
| `ChunkUnavailableError` | Chunk fetch failed after retries |
| `CidMismatchError` | CID verification failed |

All errors extend `IpfsStorageError`. See [REFERENCE.md](./REFERENCE.md) for
details.

## Testing

```bash
deno task typecheck
deno task test
```

E2E tests use a local Deno mock Kubo RPC server by default:

```bash
deno task test:e2e
```

Set `IPFS_API_URL` to run the same tests against a real Kubo RPC endpoint:

```bash
IPFS_API_URL=http://127.0.0.1:5001 deno task test:e2e
```

## Architecture

```text
Files -> Chunk Aggregation -> Vault AEAD Encryption -> CAR Segments -> IPFS Upload
                                      |
                                      v
                              Encrypted Manifests
```

Batch structure on IPFS:

```text
batch_root/
  ├── 6B/v7/6Bv7HnWcL4mT9Rp2QsXx3a   encrypted chunk
  ├── 9c/Ld/9cLdPx8Yk2RmNp3QwT5f1b   encrypted chunk
  ├── m                               batch_id prefix + encrypted root manifest
  └── m_0, m_1...                     encrypted sub-manifests, if needed
```

Key design decisions:

| Decision | Rationale |
| --- | --- |
| Immutable batches | CID never changes; compatible with storage orders |
| 16 MiB chunks | Balance aggregation efficiency and streaming behavior |
| Randomized chunk paths | Avoid leaking file paths through IPFS object names |
| PADME padding | Reduce plaintext size leakage before encryption |
| Symmetric manifest key | Keeps this package focused on storage wire format; callers handle key management |

## Migration Notes

Version `0.2.0` removes the previously documented asymmetric recipient model.
See [MIGRATION.md](./MIGRATION.md) for the migration checklist.

## License

MIT

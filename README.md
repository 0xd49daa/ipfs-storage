# @0xd49daa/ipfs-storage

[![JSR](https://jsr.io/badges/@0xd49daa/ipfs-storage)](https://jsr.io/@0xd49daa/ipfs-storage)

Browser-first TypeScript library for IPFS-based encrypted batch storage with self-custody keys and multi-recipient support.

## Motivation

### The Problem

Building privacy-preserving decentralized storage is hard. You need:

- **True self-custody** — Users own their keys, not a service provider
- **Multi-device access** — Share encrypted files across devices without re-encrypting
- **Paid storage integration** — Work with incentivized networks like Crust that pin data
- **Privacy from infrastructure** — Payment relays shouldn't see file contents or structure
- **Offline recovery** — Recover everything from a single seed phrase

### Why Not WNFS?

[WNFS](https://github.com/wnfs-wg/rs-wnfs) (WebNative File System) is a mature encrypted filesystem for IPFS, but it solves a different problem:

| Aspect | WNFS | This Package |
|--------|------|--------------|
| **Key management** | UCAN tokens, app-controlled | BIP-39 mnemonic, user-controlled |
| **Mutability** | Mutable filesystem with history | Immutable batches (Crust-compatible) |
| **Sharing model** | Capability-based delegation | Multi-recipient key wrapping |
| **Infrastructure** | Designed for Fission/custom gateways | Designed for blind payment relays |
| **Recovery** | Requires backup of root CID | Mnemonic recovers everything |
| **Batch semantics** | Continuous writes | Atomic uploads (all-or-nothing) |

WNFS is excellent for apps that manage user data on their behalf. This package is for systems where:
- Users must control their own keys (self-custody requirement)
- A relay pays for storage without seeing content (zero-knowledge payment)
- Data lives on incentivized networks with immutable CID semantics (Crust, Filecoin)
- Recovery must work from mnemonic alone across all devices

### Why Not Raw IPFS + Encryption?

You could encrypt files and upload them yourself, but you'd need to solve:
- **Key derivation** — How to derive file keys deterministically for recovery
- **Manifest format** — How to store file metadata (Protocol Buffers vs JSON bloat)
- **Multi-recipient** — Authenticated key wrapping with sender verification
- **Chunking strategy** — Aggregation for small files, splitting for large files
- **Privacy** — PADME padding, randomized chunk IDs, no size leakage

This package provides these primitives as a tested, minimal library.

## Features

- **Self-custody keys** — BIP-39 derived keys, user holds mnemonic
- **End-to-end encryption** — Files encrypted before upload using libsodium
- **Multi-recipient support** — Share batches with multiple devices/users via authenticated key wrapping
- **Streaming encryption** — Memory-efficient handling of large files (~12MB peak memory)
- **Protocol Buffers** — Compact, versioned manifest format
- **Abort support** — Cancel operations gracefully with AbortSignal
- **PADME padding** — Hides file sizes (≤12% overhead)

## Installation

```bash
# JSR (recommended)
bunx jsr add @0xd49daa/ipfs-storage

# npm via JSR
npx jsr add @0xd49daa/ipfs-storage

# Deno
deno add jsr:@0xd49daa/ipfs-storage
```

## Quick Start

```typescript
import {
  createIpfsStorageModule,
  MockIpfsClient,
  type FileInput,
} from '@0xd49daa/ipfs-storage';
import {
  preloadSodium,
  deriveSeed,
  deriveEncryptionKeyPair,
  hashBlake2b,
} from '@0xd49daa/safecrypt';

// Initialize libsodium
await preloadSodium();

// Create key pairs (from BIP-39 mnemonic in production)
const seed = await deriveSeed(mnemonic);
const senderKeyPair = await deriveEncryptionKeyPair(seed, 0);
const recipientKeyPair = await deriveEncryptionKeyPair(seed, 1);

// Create module (use real IpfsClient in production)
const storage = createIpfsStorageModule({
  ipfsClient: new MockIpfsClient(),
});

// Create FileInput
const content = new TextEncoder().encode('Hello, IPFS!');
const fileInput: FileInput = {
  file: new File([content], 'hello.txt'),
  path: '/hello.txt',
  contentHash: await hashBlake2b(content, 32),
};

// Upload
const result = await storage.uploadBatch([fileInput], {
  senderKeyPair,
  recipients: [{ publicKey: recipientKeyPair.publicKey }],
});
console.log('Batch CID:', result.cid);

// Retrieve manifest
const manifest = await storage.getManifest(result.cid, {
  recipientKeyPair,
  expectedSenderPublicKey: senderKeyPair.publicKey,
});

// Download
const fileRef = {
  batchCid: manifest.cid,
  path: manifest.files[0].path,
  size: manifest.files[0].size,
  contentHash: manifest.files[0].contentHash,
  manifestKey: manifest.manifestKey,
  chunks: manifest.files[0].chunks,
};

for await (const chunk of storage.downloadFile(fileRef)) {
  // Process decrypted chunk
}
```

## API Overview

| Method | Description |
|--------|-------------|
| `createIpfsStorageModule(config)` | Create module instance with IPFS client |
| `module.uploadBatch(files, options)` | Upload encrypted file batch |
| `module.getManifest(cid, options)` | Retrieve and decrypt manifest |
| `module.downloadFile(ref, options?)` | Download single file (async iterable) |
| `module.downloadFiles(refs, options?)` | Download multiple files sequentially |

See [REFERENCE.md](./REFERENCE.md) for complete API documentation.

## Error Handling

| Error Class | When Thrown |
|-------------|-------------|
| `ValidationError` | Invalid input (empty batch, invalid paths, missing recipients) |
| `IntegrityError` | Content hash mismatch on download |
| `ManifestError` | Cannot parse/decrypt manifest, sender mismatch |
| `ChunkUnavailableError` | Chunk fetch failed after retries |
| `CidMismatchError` | CID verification failed |

All errors extend `IpfsStorageError`. See [REFERENCE.md](./REFERENCE.md) for details.

## Testing

```bash
bun test              # Run all tests
bun test --watch      # Watch mode
bun run typecheck     # Type check
```

### E2E in Devcontainer

When running inside the devcontainer, use the IPFS service from
`.devcontainer/docker-compose.yml`:

```bash
bun run test:e2e:dev
bun run test:e2e:watch
```

`test:e2e` uses the standalone `docker-compose.yml`, while `test:e2e:dev` targets
`http://ipfs:5001` in the devcontainer network. Ensure the devcontainer and IPFS
service are healthy before running.

### MockIpfsClient

The package exports `MockIpfsClient` for testing:

```typescript
import { MockIpfsClient } from '@0xd49daa/ipfs-storage';

const client = new MockIpfsClient();
// Use in tests - stores CAR files in memory, resolves paths

// Test helpers
client.setFailNextUpload(new Error('Simulated failure'));
client.clear(); // Reset state
```

## Architecture

```
Files → Chunk Aggregation → Encryption → CAR Segments → IPFS Upload
                                              ↓
                              Encrypted Manifest with Recipient Keys
```

**Batch structure on IPFS:**
```
batch_root/
  ├── 6B/v7/6Bv7HnWcL4mT9Rp2QsXx3a   ← encrypted chunk (randomized path)
  ├── 9c/Ld/9cLdPx8Yk2RmNp3QwT5f1b   ← encrypted chunk
  ├── m                               ← root manifest (encrypted)
  └── m_0, m_1...                     ← sub-manifests (if >255 files)
```

**Key design decisions:**

| Decision | Rationale |
|----------|-----------|
| **Immutable batches** | CID never changes — compatible with Crust storage orders |
| **10MB chunks** | Balance between aggregation efficiency and streaming |
| **Randomized chunk paths** | No file structure leakage; `{id[0:2]}/{id[2:4]}/{id}` scales to petabytes |
| **PADME padding** | Hides actual file sizes with ≤12% overhead |
| **Streaming upload** | Each chunk uploaded immediately; ~12MB peak memory |
| **Authenticated key wrap** | Recipients verify sender — prevents malicious manifest injection |
| **Deterministic file keys** | `fileKey = hash(manifestKey ‖ contentHash)` — no per-file key storage |

**Chunking strategy:**
- Files < 10MB are aggregated into shared chunks
- Files ≥ 10MB are split into dedicated 10MB chunks
- PADME padding applied to final chunk
- Manifest encrypted with symmetric key, wrapped for each recipient
- Chunks uploaded as single-block CARs for immediate upload

## License

MIT

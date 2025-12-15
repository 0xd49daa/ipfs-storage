# @filemanager/ipfs-storage

Browser-first TypeScript library for IPFS-based encrypted batch storage with end-to-end encryption, multi-recipient support, and resumable uploads.

## Features

- **End-to-end encryption** — Files encrypted before upload using libsodium
- **Multi-recipient support** — Share batches with multiple devices/users
- **Resumable uploads** — Resume failed uploads without re-encrypting
- **Streaming encryption** — Memory-efficient handling of large files
- **Protocol Buffers** — Compact, versioned manifest format
- **Abort support** — Cancel operations gracefully with AbortSignal

## Installation

```bash
bun add @filemanager/ipfs-storage
```

## Quick Start

```typescript
import {
  createIpfsStorageModule,
  MockIpfsClient,
  type FileInput,
} from '@filemanager/ipfs-storage';
import {
  preloadSodium,
  deriveSeed,
  deriveEncryptionKeyPair,
  hashBlake2b,
} from '@filemanager/encryptionv2';

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
| `module.downloadFiles(refs, options?)` | Download multiple files in parallel |

See [REFERENCE.md](./REFERENCE.md) for complete API documentation.

## Examples

Runnable examples in `src/examples/`:

| Example | Description |
|---------|-------------|
| [basic-upload.ts](./src/examples/basic-upload.ts) | Simple upload workflow |
| [download-files.ts](./src/examples/download-files.ts) | Upload → manifest → download |
| [multi-recipient.ts](./src/examples/multi-recipient.ts) | Multiple recipients with labels |
| [resume-upload.ts](./src/examples/resume-upload.ts) | Error handling and resume |
| [progress-tracking.ts](./src/examples/progress-tracking.ts) | Progress callbacks |

Run examples with:

```bash
bun run src/examples/basic-upload.ts
```

## Error Handling

| Error Class | When Thrown |
|-------------|-------------|
| `ValidationError` | Invalid input (empty batch, invalid paths, missing recipients) |
| `IntegrityError` | Content hash mismatch on download |
| `ManifestError` | Cannot parse/decrypt manifest, sender mismatch |
| `ChunkUnavailableError` | Chunk fetch failed after retries |
| `SegmentUploadError` | Segment upload failed (includes resume state) |
| `AbortUploadError` | Upload aborted via signal (includes resume state) |
| `ResumeValidationError` | Invalid resume state structure |
| `CidMismatchError` | CID verification failed |

All errors extend `IpfsStorageError`. See [REFERENCE.md](./REFERENCE.md) for details.

## Testing

```bash
bun test              # Run all tests
bun test --watch      # Watch mode
bun run typecheck     # Type check
```

### MockIpfsClient

The package exports `MockIpfsClient` for testing:

```typescript
import { MockIpfsClient } from '@filemanager/ipfs-storage';

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

- Files < 10MB are aggregated into shared chunks
- Files ≥ 10MB are split into dedicated 10MB chunks
- PADME padding applied to final chunk (≤12% overhead)
- Manifest encrypted with symmetric key, wrapped for each recipient
- CAR segments uploaded sequentially for resumability

## License

MIT

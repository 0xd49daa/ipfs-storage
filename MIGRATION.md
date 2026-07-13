# Migration Notes

## 0.2.0

Version `0.2.0` documents the package as a symmetric-only Vault v0.34 storage module. The previously
documented asymmetric recipient model is removed from the public documentation and should not be
used by consumers.

### Breaking Changes

- `uploadBatch()` requires `manifestKey: SymmetricKey` and `batch_id: Uint8Array`.
- `batch_id` must be exactly 16 bytes and should be random per batch.
- `manifestKey` must be exactly 32 bytes and is owned by the caller.
- `getManifest()` requires `manifestKey` instead of recipient key material.
- `downloadFile()` and `downloadFiles()` require `manifestKey` in options.
- `BatchManifest` does not expose `manifestKey` or sender public key fields.
- `FileDownloadRef` does not carry `manifestKey`; pass it through download options instead.
- Asymmetric sender and recipient options are removed from the documented API.
- X25519 key types are not re-exported by this package.

### Removed Asymmetric Concepts

Remove these options and types from consumer code:

- `senderKeyPair`
- `recipients`
- `recipientKeyPair`
- `expectedSenderPublicKey`
- recipient labels for key wrapping
- sender public key verification
- package-level X25519 key pair imports

### Upload

```typescript
const manifestKey = crypto.getRandomValues(new Uint8Array(32)) as SymmetricKey;
const batch_id = crypto.getRandomValues(new Uint8Array(16));

await storage.uploadBatch(files, {
  manifestKey,
  batch_id,
});
```

### Manifest Retrieval

```typescript
const manifest = await storage.getManifest(batchCid, { manifestKey });
```

### Download

```typescript
const fileRef = {
  batchCid: manifest.cid,
  path: file.path,
  size: file.size,
  contentHash: file.contentHash,
  chunks: file.chunks,
};

for await (const chunk of storage.downloadFile(fileRef, { manifestKey })) {
  // ...
}

const bytes = await storage.downloadFile(fileRef, {
  manifestKey,
  output: "memory",
});

await storage.downloadFile(fileRef, {
  manifestKey,
  output: writableStream,
});
```

### Root Manifest Locator

The root manifest blob at `/m` starts with a plaintext 16-byte `batch_id` prefix, followed by the
encrypted root manifest AEAD record. Consumers that need to read the locator without decrypting the
manifest can use:

```typescript
import { getBatchIdFromManifestBlob } from "@0xd49daa/ipfs-storage";

const batchId = getBatchIdFromManifestBlob(rootManifestBlob);
```

This parser only reads the prefix. It does not authenticate or decrypt the remaining bytes.

### Plaintext Handling

The library still does not write plaintext files, OPFS caches, or temporary decrypted files.
Downloads yield decrypted bytes to the caller, return an in-memory `Uint8Array` when requested, or
write them to a caller-owned `WritableStream`.

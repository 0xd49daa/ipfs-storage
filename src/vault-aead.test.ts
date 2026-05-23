import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { preloadSodium } from "@0xd49daa/safecrypt";
import {
  buildVaultChunkAad,
  buildVaultChunkFileKeyInfo,
  buildVaultManifestAad,
  computeVaultFilePathHash,
  decryptVaultAeadRecord,
  decryptVaultChunkRecord,
  decryptVaultManifestRecord,
  deriveVaultChunkFileKey,
  encryptVaultAeadRecord,
  encryptVaultChunkRecord,
  encryptVaultManifestRecord,
  parseVaultAeadRecord,
  VAULT_AEAD_NONCE_SIZE,
  VAULT_AEAD_TAG_SIZE,
  VAULT_AEAD_VERSION,
  VAULT_AES_256_KEY_SIZE,
  VAULT_KEY_SCOPE_CHUNK,
  VAULT_KEY_SCOPE_MANIFEST,
  type VaultAeadKeyScope,
} from "./vault-aead.ts";

function rangeBytes(length: number, start = 0): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (start + i) & 0xff;
  }
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("Vault AEAD crypto foundation", () => {
  beforeAll(async () => {
    await preloadSodium();
  });

  describe("canonical AEAD records", () => {
    test("round-trips a chunk record", async () => {
      const manifestKey = randomBytes(VAULT_AES_256_KEY_SIZE);
      const batchId = rangeBytes(16);
      const plaintext = new TextEncoder().encode("chunk plaintext");

      const record = await encryptVaultChunkRecord({
        plaintext,
        manifestKey,
        batchId,
        filePathWithinBatch: "/docs/readme.txt",
        chunkIndex: 7,
      });
      const parsed = parseVaultAeadRecord(record);

      expect(parsed.version).toBe(VAULT_AEAD_VERSION);
      expect(parsed.keyScope).toBe(VAULT_KEY_SCOPE_CHUNK);
      expect(parsed.nonce).toHaveLength(VAULT_AEAD_NONCE_SIZE);
      expect(parsed.ciphertext).toHaveLength(plaintext.length);
      expect(parsed.tag).toHaveLength(VAULT_AEAD_TAG_SIZE);

      const decrypted = await decryptVaultChunkRecord({
        record,
        manifestKey,
        batchId,
        filePathWithinBatch: "/docs/readme.txt",
        chunkIndex: 7,
      });

      expect(decrypted).toEqual(plaintext);
    });

    test("round-trips a manifest record", async () => {
      const manifestKey = randomBytes(VAULT_AES_256_KEY_SIZE);
      const batchId = rangeBytes(16, 16);
      const plaintext = new TextEncoder().encode("manifest plaintext");

      const record = await encryptVaultManifestRecord({
        plaintext,
        manifestKey,
        batchId,
        manifestNodeId: 0,
      });
      const parsed = parseVaultAeadRecord(record);

      expect(parsed.version).toBe(VAULT_AEAD_VERSION);
      expect(parsed.keyScope).toBe(VAULT_KEY_SCOPE_MANIFEST);
      expect(parsed.nonce).toHaveLength(VAULT_AEAD_NONCE_SIZE);
      expect(parsed.ciphertext).toHaveLength(plaintext.length);
      expect(parsed.tag).toHaveLength(VAULT_AEAD_TAG_SIZE);

      const decrypted = await decryptVaultManifestRecord({
        record,
        manifestKey,
        batchId,
        manifestNodeId: 0,
      });

      expect(decrypted).toEqual(plaintext);
    });

    test("rejects unsupported write scopes", async () => {
      const key = randomBytes(VAULT_AES_256_KEY_SIZE);
      const batchId = rangeBytes(16);
      const aad = buildVaultManifestAad(batchId, 0);

      await expect(
        encryptVaultAeadRecord(
          new Uint8Array([1, 2, 3]),
          key,
          0x06 as VaultAeadKeyScope,
          aad,
        ),
      ).rejects.toThrow(/Unsupported AEAD key scope/);
    });

    test("rejects unsupported record versions clearly", async () => {
      const manifestKey = randomBytes(VAULT_AES_256_KEY_SIZE);
      const batchId = rangeBytes(16);
      const record = await encryptVaultManifestRecord({
        plaintext: new Uint8Array([1, 2, 3]),
        manifestKey,
        batchId,
        manifestNodeId: 0,
      });
      const tampered = record.slice();
      tampered[0] = 0x02;

      expect(() => parseVaultAeadRecord(tampered)).toThrow(
        /Unsupported AEAD record version/,
      );
      await expect(
        decryptVaultManifestRecord({
          record: tampered,
          manifestKey,
          batchId,
          manifestNodeId: 0,
        }),
      ).rejects.toThrow(/Unsupported AEAD record version/);
    });
  });

  describe("authentication failures", () => {
    test("tampered scope, nonce, ciphertext, tag, and AAD fail", async () => {
      const manifestKey = randomBytes(VAULT_AES_256_KEY_SIZE);
      const batchId = rangeBytes(16);
      const plaintext = new TextEncoder().encode("authenticated chunk");
      const record = await encryptVaultChunkRecord({
        plaintext,
        manifestKey,
        batchId,
        filePathWithinBatch: "/file.bin",
        chunkIndex: 3,
      });

      const scopeTampered = record.slice();
      scopeTampered[1] = VAULT_KEY_SCOPE_MANIFEST;
      await expect(
        decryptVaultChunkRecord({
          record: scopeTampered,
          manifestKey,
          batchId,
          filePathWithinBatch: "/file.bin",
          chunkIndex: 3,
        }),
      ).rejects.toThrow(/AAD prefix does not match/);

      const nonceTampered = record.slice();
      nonceTampered[2] = nonceTampered[2]! ^ 0x01;
      await expect(
        decryptVaultChunkRecord({
          record: nonceTampered,
          manifestKey,
          batchId,
          filePathWithinBatch: "/file.bin",
          chunkIndex: 3,
        }),
      ).rejects.toThrow();

      const ciphertextTampered = record.slice();
      ciphertextTampered[2 + VAULT_AEAD_NONCE_SIZE] = ciphertextTampered[
        2 + VAULT_AEAD_NONCE_SIZE
      ]! ^ 0x01;
      await expect(
        decryptVaultChunkRecord({
          record: ciphertextTampered,
          manifestKey,
          batchId,
          filePathWithinBatch: "/file.bin",
          chunkIndex: 3,
        }),
      ).rejects.toThrow();

      const tagTampered = record.slice();
      tagTampered[tagTampered.length - 1] = tagTampered[
        tagTampered.length - 1
      ]! ^ 0x01;
      await expect(
        decryptVaultChunkRecord({
          record: tagTampered,
          manifestKey,
          batchId,
          filePathWithinBatch: "/file.bin",
          chunkIndex: 3,
        }),
      ).rejects.toThrow();

      await expect(
        decryptVaultChunkRecord({
          record,
          manifestKey,
          batchId: rangeBytes(16, 1),
          filePathWithinBatch: "/file.bin",
          chunkIndex: 3,
        }),
      ).rejects.toThrow();

      await expect(
        decryptVaultChunkRecord({
          record,
          manifestKey,
          batchId,
          filePathWithinBatch: "/file.bin",
          chunkIndex: 4,
        }),
      ).rejects.toThrow();
    });

    test("tampered manifest AAD fails", async () => {
      const manifestKey = randomBytes(VAULT_AES_256_KEY_SIZE);
      const batchId = rangeBytes(16);
      const record = await encryptVaultManifestRecord({
        plaintext: new TextEncoder().encode("root manifest"),
        manifestKey,
        batchId,
        manifestNodeId: 0,
      });

      await expect(
        decryptVaultManifestRecord({
          record,
          manifestKey,
          batchId,
          manifestNodeId: 1,
        }),
      ).rejects.toThrow();
    });
  });

  describe("AAD construction", () => {
    test("builds golden chunk AAD", () => {
      const aad = buildVaultChunkAad(
        rangeBytes(16, 0x00),
        rangeBytes(32, 0x20),
        0x01020304,
      );

      expect(bytesToHex(aad)).toBe(
        "0104" +
          "000102030405060708090a0b0c0d0e0f" +
          "202122232425262728292a2b2c2d2e2f" +
          "303132333435363738393a3b3c3d3e3f" +
          "01020304",
      );
    });

    test("builds golden manifest AAD", () => {
      const aad = buildVaultManifestAad(rangeBytes(16), 0x0a0b0c0d);

      expect(bytesToHex(aad)).toBe(
        "0105" +
          "000102030405060708090a0b0c0d0e0f" +
          "0a0b0c0d",
      );
    });

    test("computes deterministic BLAKE2b-256 file path hashes", async () => {
      const hash1 = await computeVaultFilePathHash("/photos/2024/img.jpg");
      const hash2 = await computeVaultFilePathHash("/photos/2024/img.jpg");
      const hash3 = await computeVaultFilePathHash("/photos/2024/other.jpg");

      expect(hash1).toHaveLength(32);
      expect(hash1).toEqual(hash2);
      expect(hash1).not.toEqual(hash3);
    });
  });

  describe("HKDF chunk keys", () => {
    test("builds golden HKDF info bytes", () => {
      const info = buildVaultChunkFileKeyInfo(rangeBytes(32));

      expect(bytesToHex(info)).toBe(
        "7661756c742d6368756e6b2d7631" +
          "000102030405060708090a0b0c0d0e0f" +
          "101112131415161718191a1b1c1d1e1f",
      );
    });

    test("derives deterministic 32-byte chunk file keys", async () => {
      const manifestKey = rangeBytes(VAULT_AES_256_KEY_SIZE, 0x40);
      const filePathHash = rangeBytes(32, 0x80);

      const key1 = await deriveVaultChunkFileKey(manifestKey, filePathHash);
      const key2 = await deriveVaultChunkFileKey(manifestKey, filePathHash);
      const key3 = await deriveVaultChunkFileKey(
        manifestKey,
        rangeBytes(32, 0x81),
      );

      expect(key1).toHaveLength(VAULT_AES_256_KEY_SIZE);
      expect(key1).toEqual(key2);
      expect(key1).not.toEqual(key3);
    });
  });

  describe("nonce policy", () => {
    test("rejects all-zero and all-ones nonce inputs", async () => {
      const key = randomBytes(VAULT_AES_256_KEY_SIZE);
      const aad = buildVaultManifestAad(rangeBytes(16), 0);

      await expect(
        encryptVaultAeadRecord(
          new Uint8Array([1, 2, 3]),
          key,
          VAULT_KEY_SCOPE_MANIFEST,
          aad,
          { nonce: new Uint8Array(VAULT_AEAD_NONCE_SIZE) },
        ),
      ).rejects.toThrow(/Forbidden AES-GCM nonce value/);

      await expect(
        encryptVaultAeadRecord(
          new Uint8Array([1, 2, 3]),
          key,
          VAULT_KEY_SCOPE_MANIFEST,
          aad,
          { nonce: new Uint8Array(VAULT_AEAD_NONCE_SIZE).fill(0xff) },
        ),
      ).rejects.toThrow(/Forbidden AES-GCM nonce value/);
    });

    test("uses fresh random nonces across many encryptions", async () => {
      const key = randomBytes(VAULT_AES_256_KEY_SIZE);
      const batchId = rangeBytes(16);
      const nonceHexes = new Set<string>();

      for (let i = 0; i < 64; i++) {
        const record = await encryptVaultManifestRecord({
          plaintext: new Uint8Array([i]),
          manifestKey: key,
          batchId,
          manifestNodeId: 0,
        });
        const parsed = parseVaultAeadRecord(record);
        nonceHexes.add(bytesToHex(parsed.nonce));
      }

      expect(nonceHexes.size).toBe(64);
      expect(nonceHexes.has("000000000000000000000000")).toBe(false);
      expect(nonceHexes.has("ffffffffffffffffffffffff")).toBe(false);
    });
  });

  describe("low-level decrypt", () => {
    test("requires AAD prefix to match record prefix", async () => {
      const key = randomBytes(VAULT_AES_256_KEY_SIZE);
      const batchId = rangeBytes(16);
      const manifestAad = buildVaultManifestAad(batchId, 0);
      const record = await encryptVaultAeadRecord(
        new Uint8Array([1, 2, 3]),
        key,
        VAULT_KEY_SCOPE_MANIFEST,
        manifestAad,
      );
      const chunkAad = buildVaultChunkAad(batchId, rangeBytes(32), 0);

      await expect(decryptVaultAeadRecord(record, key, chunkAad)).rejects
        .toThrow(/AAD prefix does not match/);
    });
  });
});

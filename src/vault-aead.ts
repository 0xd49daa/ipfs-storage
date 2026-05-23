import { hashBytes } from "./crypto-primitives.ts";

export const VAULT_AEAD_VERSION = 0x01;
export const VAULT_KEY_SCOPE_CHUNK = 0x04;
export const VAULT_KEY_SCOPE_MANIFEST = 0x05;

export const VAULT_AEAD_NONCE_SIZE = 12;
export const VAULT_AEAD_TAG_SIZE = 16;
export const VAULT_AES_256_KEY_SIZE = 32;
export const VAULT_BATCH_ID_SIZE = 16;
export const VAULT_FILE_PATH_HASH_SIZE = 32;

const AES_GCM_TAG_BITS = VAULT_AEAD_TAG_SIZE * 8;
const U32_MAX = 0xffffffff;
const textEncoder = new TextEncoder();
const CHUNK_FILE_KEY_INFO_PREFIX = textEncoder.encode("vault-chunk-v1");

export type VaultAeadKeyScope =
  | typeof VAULT_KEY_SCOPE_CHUNK
  | typeof VAULT_KEY_SCOPE_MANIFEST;

export interface VaultAeadRecord {
  version: typeof VAULT_AEAD_VERSION;
  keyScope: VaultAeadKeyScope;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

export interface VaultAeadEncryptOptions {
  /** Test-only injection point. Production callers should let this be random. */
  nonce?: Uint8Array;
}

export interface VaultChunkRecordInput extends VaultAeadEncryptOptions {
  plaintext: Uint8Array;
  manifestKey: Uint8Array;
  batchId: Uint8Array;
  filePathWithinBatch: string;
  chunkIndex: number;
}

export interface VaultChunkRecordDecryptInput {
  record: Uint8Array;
  manifestKey: Uint8Array;
  batchId: Uint8Array;
  filePathWithinBatch: string;
  chunkIndex: number;
}

export interface VaultManifestRecordInput extends VaultAeadEncryptOptions {
  plaintext: Uint8Array;
  manifestKey: Uint8Array;
  batchId: Uint8Array;
  manifestNodeId: number;
}

export interface VaultManifestRecordDecryptInput {
  record: Uint8Array;
  manifestKey: Uint8Array;
  batchId: Uint8Array;
  manifestNodeId: number;
}

export class VaultAeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultAeadError";
  }
}

function assertLength(bytes: Uint8Array, length: number, name: string): void {
  if (bytes.length !== length) {
    throw new VaultAeadError(
      `${name} must be ${length} bytes, got ${bytes.length}`,
    );
  }
}

function assertUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new VaultAeadError(`${name} must be a uint32, got ${value}`);
  }
}

function assertSupportedScope(
  scope: number,
): asserts scope is VaultAeadKeyScope {
  if (scope !== VAULT_KEY_SCOPE_CHUNK && scope !== VAULT_KEY_SCOPE_MANIFEST) {
    throw new VaultAeadError(
      `Unsupported AEAD key scope 0x${scope.toString(16).padStart(2, "0")}`,
    );
  }
}

function isAllByte(bytes: Uint8Array, value: number): boolean {
  for (const byte of bytes) {
    if (byte !== value) return false;
  }
  return true;
}

function assertAllowedNonce(nonce: Uint8Array): void {
  assertLength(nonce, VAULT_AEAD_NONCE_SIZE, "nonce");
  if (isAllByte(nonce, 0x00) || isAllByte(nonce, 0xff)) {
    throw new VaultAeadError("Forbidden AES-GCM nonce value");
  }
}

function assertCanonicalAadPrefix(
  aad: Uint8Array,
  version: number,
  keyScope: number,
): void {
  if (aad.length < 2 || aad[0] !== version || aad[1] !== keyScope) {
    throw new VaultAeadError(
      "AAD prefix does not match AEAD record version and key scope",
    );
  }
}

function writeUint32Be(
  target: Uint8Array,
  offset: number,
  value: number,
): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function randomNonce(): Uint8Array {
  const nonce = new Uint8Array(VAULT_AEAD_NONCE_SIZE);
  crypto.getRandomValues(nonce);
  return nonce;
}

function asWebCryptoBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(bytes);
}

async function importAesKey(
  key: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  assertLength(key, VAULT_AES_256_KEY_SIZE, "AES-GCM key");
  return crypto.subtle.importKey(
    "raw",
    asWebCryptoBytes(key),
    "AES-GCM",
    false,
    usages,
  );
}

export function serializeVaultAeadRecord(record: VaultAeadRecord): Uint8Array {
  if (record.version !== VAULT_AEAD_VERSION) {
    throw new VaultAeadError(`Cannot serialize AEAD version ${record.version}`);
  }
  assertSupportedScope(record.keyScope);
  assertAllowedNonce(record.nonce);
  assertLength(record.tag, VAULT_AEAD_TAG_SIZE, "GCM tag");

  const result = new Uint8Array(
    2 + record.nonce.length + record.ciphertext.length + record.tag.length,
  );
  result[0] = record.version;
  result[1] = record.keyScope;
  result.set(record.nonce, 2);
  result.set(record.ciphertext, 2 + record.nonce.length);
  result.set(record.tag, 2 + record.nonce.length + record.ciphertext.length);
  return result;
}

export function parseVaultAeadRecord(record: Uint8Array): VaultAeadRecord {
  const minLength = 2 + VAULT_AEAD_NONCE_SIZE + VAULT_AEAD_TAG_SIZE;
  if (record.length < minLength) {
    throw new VaultAeadError(
      `AEAD record too short: expected at least ${minLength} bytes, got ${record.length}`,
    );
  }

  const version = record[0]!;
  if (version !== VAULT_AEAD_VERSION) {
    throw new VaultAeadError(
      `Unsupported AEAD record version 0x${
        version.toString(16).padStart(2, "0")
      }`,
    );
  }

  const keyScope = record[1]!;
  assertSupportedScope(keyScope);

  const nonceStart = 2;
  const ciphertextStart = nonceStart + VAULT_AEAD_NONCE_SIZE;
  const tagStart = record.length - VAULT_AEAD_TAG_SIZE;

  const nonce = record.slice(nonceStart, ciphertextStart);
  assertAllowedNonce(nonce);

  return {
    version: VAULT_AEAD_VERSION,
    keyScope,
    nonce,
    ciphertext: record.slice(ciphertextStart, tagStart),
    tag: record.slice(tagStart),
  };
}

export async function encryptVaultAeadRecord(
  plaintext: Uint8Array,
  key: Uint8Array,
  keyScope: VaultAeadKeyScope,
  aad: Uint8Array,
  options: VaultAeadEncryptOptions = {},
): Promise<Uint8Array> {
  assertSupportedScope(keyScope);
  assertCanonicalAadPrefix(aad, VAULT_AEAD_VERSION, keyScope);

  const nonce = options.nonce ? options.nonce.slice() : randomNonce();
  assertAllowedNonce(nonce);

  const cryptoKey = await importAesKey(key, ["encrypt"]);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: asWebCryptoBytes(nonce),
        additionalData: asWebCryptoBytes(aad),
        tagLength: AES_GCM_TAG_BITS,
      },
      cryptoKey,
      asWebCryptoBytes(plaintext),
    ),
  );

  const tagStart = encrypted.length - VAULT_AEAD_TAG_SIZE;
  return serializeVaultAeadRecord({
    version: VAULT_AEAD_VERSION,
    keyScope,
    nonce,
    ciphertext: encrypted.slice(0, tagStart),
    tag: encrypted.slice(tagStart),
  });
}

export async function decryptVaultAeadRecord(
  recordBytes: Uint8Array,
  key: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const record = parseVaultAeadRecord(recordBytes);
  assertCanonicalAadPrefix(aad, record.version, record.keyScope);

  const ciphertextAndTag = new Uint8Array(
    record.ciphertext.length + record.tag.length,
  );
  ciphertextAndTag.set(record.ciphertext, 0);
  ciphertextAndTag.set(record.tag, record.ciphertext.length);

  const cryptoKey = await importAesKey(key, ["decrypt"]);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asWebCryptoBytes(record.nonce),
        additionalData: asWebCryptoBytes(aad),
        tagLength: AES_GCM_TAG_BITS,
      },
      cryptoKey,
      asWebCryptoBytes(ciphertextAndTag),
    ),
  );
}

export function buildVaultChunkAad(
  batchId: Uint8Array,
  filePathHash: Uint8Array,
  chunkIndex: number,
): Uint8Array {
  assertLength(batchId, VAULT_BATCH_ID_SIZE, "batch_id");
  assertLength(filePathHash, VAULT_FILE_PATH_HASH_SIZE, "file_path_hash");
  assertUint32(chunkIndex, "chunk_index");

  const aad = new Uint8Array(2 + batchId.length + filePathHash.length + 4);
  aad[0] = VAULT_AEAD_VERSION;
  aad[1] = VAULT_KEY_SCOPE_CHUNK;
  aad.set(batchId, 2);
  aad.set(filePathHash, 2 + batchId.length);
  writeUint32Be(aad, 2 + batchId.length + filePathHash.length, chunkIndex);
  return aad;
}

export function buildVaultManifestAad(
  batchId: Uint8Array,
  manifestNodeId: number,
): Uint8Array {
  assertLength(batchId, VAULT_BATCH_ID_SIZE, "batch_id");
  assertUint32(manifestNodeId, "manifest_node_id");

  const aad = new Uint8Array(2 + batchId.length + 4);
  aad[0] = VAULT_AEAD_VERSION;
  aad[1] = VAULT_KEY_SCOPE_MANIFEST;
  aad.set(batchId, 2);
  writeUint32Be(aad, 2 + batchId.length, manifestNodeId);
  return aad;
}

export async function computeVaultFilePathHash(
  filePathWithinBatch: string,
): Promise<Uint8Array> {
  return hashBytes(textEncoder.encode(filePathWithinBatch), 32);
}

export function buildVaultChunkFileKeyInfo(
  filePathHash: Uint8Array,
): Uint8Array {
  assertLength(filePathHash, VAULT_FILE_PATH_HASH_SIZE, "file_path_hash");
  const info = new Uint8Array(
    CHUNK_FILE_KEY_INFO_PREFIX.length + filePathHash.length,
  );
  info.set(CHUNK_FILE_KEY_INFO_PREFIX, 0);
  info.set(filePathHash, CHUNK_FILE_KEY_INFO_PREFIX.length);
  return info;
}

export async function deriveVaultChunkFileKey(
  manifestKey: Uint8Array,
  filePathHash: Uint8Array,
): Promise<Uint8Array> {
  assertLength(manifestKey, VAULT_AES_256_KEY_SIZE, "manifestKey");
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    asWebCryptoBytes(manifestKey),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: asWebCryptoBytes(buildVaultChunkFileKeyInfo(filePathHash)),
    },
    keyMaterial,
    VAULT_AES_256_KEY_SIZE * 8,
  );
  return new Uint8Array(derivedBits);
}

export async function encryptVaultChunkRecord(
  input: VaultChunkRecordInput,
): Promise<Uint8Array> {
  const filePathHash = await computeVaultFilePathHash(
    input.filePathWithinBatch,
  );
  const chunkFileKey = await deriveVaultChunkFileKey(
    input.manifestKey,
    filePathHash,
  );
  const aad = buildVaultChunkAad(input.batchId, filePathHash, input.chunkIndex);
  return encryptVaultAeadRecord(
    input.plaintext,
    chunkFileKey,
    VAULT_KEY_SCOPE_CHUNK,
    aad,
    { nonce: input.nonce },
  );
}

export async function decryptVaultChunkRecord(
  input: VaultChunkRecordDecryptInput,
): Promise<Uint8Array> {
  const filePathHash = await computeVaultFilePathHash(
    input.filePathWithinBatch,
  );
  const chunkFileKey = await deriveVaultChunkFileKey(
    input.manifestKey,
    filePathHash,
  );
  const aad = buildVaultChunkAad(input.batchId, filePathHash, input.chunkIndex);
  return decryptVaultAeadRecord(input.record, chunkFileKey, aad);
}

export async function encryptVaultManifestRecord(
  input: VaultManifestRecordInput,
): Promise<Uint8Array> {
  const aad = buildVaultManifestAad(input.batchId, input.manifestNodeId);
  return encryptVaultAeadRecord(
    input.plaintext,
    input.manifestKey,
    VAULT_KEY_SCOPE_MANIFEST,
    aad,
    { nonce: input.nonce },
  );
}

export async function decryptVaultManifestRecord(
  input: VaultManifestRecordDecryptInput,
): Promise<Uint8Array> {
  const aad = buildVaultManifestAad(input.batchId, input.manifestNodeId);
  return decryptVaultAeadRecord(input.record, input.manifestKey, aad);
}

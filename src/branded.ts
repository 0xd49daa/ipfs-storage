declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

/** Base58 alphabet (excludes 0, O, I, l to avoid confusion) */
const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_REGEX = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

/** Base58-encoded chunk identifier (22 chars from UUID) */
export type ChunkId = Brand<string, 'ChunkId'>;

/** IPFS CID for a batch root */
export type BatchCid = Brand<string, 'BatchCid'>;

/** IPFS CID for a chunk */
export type ChunkCid = Brand<string, 'ChunkCid'>;

/** File path within a batch (e.g., "/photos/2024/img.jpg") */
export type FilePath = Brand<string, 'FilePath'>;

/**
 * Validate and brand as ChunkId.
 * ChunkId is base58-encoded UUID, should be 22 characters of valid base58.
 */
export function asChunkId(value: string): ChunkId {
  if (value.length !== 22) {
    throw new Error(`Invalid ChunkId: expected 22 characters, got ${value.length}`);
  }
  if (!BASE58_REGEX.test(value)) {
    throw new Error(`Invalid ChunkId: contains non-base58 characters`);
  }
  return value as ChunkId;
}

/**
 * Brand as BatchCid (basic validation only).
 */
export function asBatchCid(value: string): BatchCid {
  if (!value || value.length === 0) {
    throw new Error('Invalid BatchCid: cannot be empty');
  }
  return value as BatchCid;
}

/**
 * Brand as ChunkCid (basic validation only).
 */
export function asChunkCid(value: string): ChunkCid {
  if (!value || value.length === 0) {
    throw new Error('Invalid ChunkCid: cannot be empty');
  }
  return value as ChunkCid;
}

/**
 * Validate and brand as FilePath.
 * Must start with "/" and not contain double slashes.
 */
export function asFilePath(value: string): FilePath {
  if (!value.startsWith('/')) {
    throw new Error(`Invalid FilePath: must start with "/", got "${value}"`);
  }
  if (value.includes('//')) {
    throw new Error(`Invalid FilePath: cannot contain double slashes, got "${value}"`);
  }
  return value as FilePath;
}

/**
 * Unsafe branding without validation.
 * Use only when source is trusted.
 */
export const unsafe = {
  asChunkId: (value: string): ChunkId => value as ChunkId,
  asBatchCid: (value: string): BatchCid => value as BatchCid,
  asChunkCid: (value: string): ChunkCid => value as ChunkCid,
  asFilePath: (value: string): FilePath => value as FilePath,
};

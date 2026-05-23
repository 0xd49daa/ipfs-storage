import { blake2b } from "@noble/hashes/blake2b";

declare const contentHashBrand: unique symbol;
declare const symmetricKeyBrand: unique symbol;

export const CONTENT_HASH_SIZE = 32;
export const SYMMETRIC_KEY_SIZE = 32;

export type ContentHash = Uint8Array & {
  readonly [contentHashBrand]: "ContentHash";
};

export type SymmetricKey = Uint8Array & {
  readonly [symmetricKeyBrand]: "SymmetricKey";
};

export interface ContentHasher {
  update(bytes: Uint8Array): void;
  digest(): ContentHash;
}

function assertByteLength(
  bytes: Uint8Array,
  expectedLength: number,
  name: string,
): void {
  if (bytes.length !== expectedLength) {
    throw new Error(
      `${name} must be ${expectedLength} bytes, got ${bytes.length}`,
    );
  }
}

export function asContentHash(bytes: Uint8Array): ContentHash {
  assertByteLength(bytes, CONTENT_HASH_SIZE, "ContentHash");
  return bytes as ContentHash;
}

export function asSymmetricKey(bytes: Uint8Array): SymmetricKey {
  assertByteLength(bytes, SYMMETRIC_KEY_SIZE, "SymmetricKey");
  return bytes as SymmetricKey;
}

/**
 * Computes the content hash format currently used by this package.
 * The concrete algorithm is intentionally hidden from the public API name.
 */
export async function hashContent(bytes: Uint8Array): Promise<ContentHash> {
  return asContentHash(hashBytes(bytes, CONTENT_HASH_SIZE));
}

export function hashBytes(
  bytes: Uint8Array,
  length = CONTENT_HASH_SIZE,
): Uint8Array {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error(`Hash length must be a positive integer, got ${length}`);
  }
  return blake2b(bytes, { dkLen: length });
}

export function createContentHasher(): ContentHasher {
  const hasher = blake2b.create({ dkLen: CONTENT_HASH_SIZE });
  return {
    update(bytes: Uint8Array): void {
      hasher.update(bytes);
    },
    digest(): ContentHash {
      return asContentHash(hasher.digest());
    },
  };
}

export function constantTimeEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  const maxLength = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let i = 0; i < maxLength; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }

  return diff === 0;
}

export function generateSymmetricKey(): SymmetricKey {
  const key = new Uint8Array(SYMMETRIC_KEY_SIZE);
  crypto.getRandomValues(key);
  return key as SymmetricKey;
}

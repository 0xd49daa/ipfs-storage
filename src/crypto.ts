import type { SymmetricKey, ContentHash } from '@0xd49daa/safecrypt';
import { hashBlake2b } from '@0xd49daa/safecrypt';
import { DOMAIN } from './constants.ts';

/** Pre-computed UTF-8 encoded domain prefix */
const FILE_KEY_DOMAIN = new TextEncoder().encode(DOMAIN.FILE_KEY);

/**
 * Derive a file encryption key from manifest key and content hash.
 *
 * Uses domain separation to prevent collisions:
 * fileKey = hashBlake2b(DOMAIN.FILE_KEY ‖ manifestKey ‖ contentHash, 32)
 *
 * @param manifestKey - The batch's manifest encryption key (32 bytes)
 * @param contentHash - The file's content hash (32 bytes)
 * @returns Derived file encryption key (32 bytes)
 */
export async function deriveFileKey(
  manifestKey: SymmetricKey,
  contentHash: ContentHash
): Promise<SymmetricKey> {
  // Build input: domain (24 bytes) + manifestKey (32 bytes) + contentHash (32 bytes) = 88 bytes
  const input = new Uint8Array(FILE_KEY_DOMAIN.length + 32 + 32);
  input.set(FILE_KEY_DOMAIN, 0);
  input.set(manifestKey, FILE_KEY_DOMAIN.length);
  input.set(contentHash, FILE_KEY_DOMAIN.length + 32);

  // Hash to 32 bytes
  return hashBlake2b(input, 32) as Promise<SymmetricKey>;
}

import { base58 } from "@scure/base";
import { type ChunkId, unsafe } from "./branded.ts";

/** Expected length of a ChunkId (base58-encoded 16 bytes) */
const CHUNK_ID_LENGTH = 22;

/**
 * Generate a new chunk ID.
 * Uses 16 random bytes encoded as base58, padded to 22 characters.
 */
export async function generateChunkId(): Promise<ChunkId> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let encoded = base58.encode(bytes);

  // Base58 encoding of 16 bytes can be 21-22 chars depending on leading zeros
  // Pad with '1' (base58 zero) if needed
  while (encoded.length < CHUNK_ID_LENGTH) {
    encoded = "1" + encoded;
  }

  return unsafe.asChunkId(encoded);
}

/**
 * Convert a chunk ID to a hierarchical path.
 * Format: {id[0:2]}/{id[2:4]}/{id}
 * Example: "6Bv7HnWcL4mT9Rp2QsXx3a" → "6B/v7/6Bv7HnWcL4mT9Rp2QsXx3a"
 */
export function chunkIdToPath(chunkId: ChunkId): string {
  return `${chunkId.slice(0, 2)}/${chunkId.slice(2, 4)}/${chunkId}`;
}

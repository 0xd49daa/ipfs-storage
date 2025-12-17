/**
 * Chunk decryption utilities for IPFS storage.
 *
 * This module provides decryption functions for encrypted chunks.
 * Used by download.ts for decrypting file data.
 */

import type { SymmetricKey, Nonce } from '@0xd49daa/safecrypt';
import { decrypt, createDecryptStream } from '@0xd49daa/safecrypt';
import { ChunkEncryption } from './gen/manifest_pb.ts';
import {
  NONCE_SIZE,
  SINGLE_SHOT_OVERHEAD,
  STREAM_HEADER_SIZE,
  STREAM_CHUNK_OVERHEAD,
  STREAM_CHUNK_SIZE,
} from './constants.ts';

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Compute encrypted length from plaintext length.
 *
 * @deprecated For segment extraction, use `segment.encryptedLength` instead.
 * This function computes the expected encrypted size for UNPADDED plaintext.
 * For PADME-padded segments (last segment of final chunk), this returns
 * the wrong value - it doesn't account for padding bytes.
 *
 * Safe to use for:
 * - Sanity checks on non-final segments
 * - Estimating encrypted sizes before encryption
 *
 * NOT safe for:
 * - Extracting segment data from encrypted chunks (use encryptedLength field)
 * - Final chunk's last segment (has PADME padding)
 */
export function computeEncryptedLength(
  plaintextLength: number,
  encryption: ChunkEncryption
): number {
  if (encryption === ChunkEncryption.SINGLE_SHOT) {
    return plaintextLength + SINGLE_SHOT_OVERHEAD;
  } else {
    // STREAMING: header + (numChunks * overhead)
    // Uses locked STREAM_CHUNK_SIZE constant - not configurable
    const numChunks = Math.ceil(plaintextLength / STREAM_CHUNK_SIZE);
    return plaintextLength + STREAM_HEADER_SIZE + numChunks * STREAM_CHUNK_OVERHEAD;
  }
}

// ============================================================================
// Decryption Functions
// ============================================================================

/**
 * Decrypt segment using single-shot mode.
 * Expects wire format: [24-byte nonce][ciphertext with 16-byte tag]
 */
export async function decryptSingleShot(
  encryptedData: Uint8Array,
  key: SymmetricKey
): Promise<Uint8Array> {
  const nonce = encryptedData.subarray(0, NONCE_SIZE) as Nonce;
  const ciphertext = encryptedData.subarray(NONCE_SIZE);
  return decrypt(ciphertext, nonce, key);
}

/**
 * Decrypt segment using streaming mode.
 * Expects wire format: [24-byte header][encrypted_chunks...]
 *
 * IMPORTANT: This function assumes encrypted chunks were created with
 * STREAM_CHUNK_SIZE (64KB) as the plaintext chunk size. This is safe because:
 * 1. STREAM_CHUNK_SIZE is a locked constant (not configurable)
 * 2. encryptStreaming() always uses STREAM_CHUNK_SIZE
 * 3. Both encrypt and decrypt use the same constant
 *
 * The secretstream format requires feeding exact encrypted chunk boundaries
 * to pull(), so we must know the chunk size used during encryption.
 */
export async function decryptStreaming(
  encryptedData: Uint8Array,
  key: SymmetricKey
): Promise<Uint8Array> {
  const header = encryptedData.subarray(0, STREAM_HEADER_SIZE);
  const stream = await createDecryptStream(
    key,
    header as unknown as import('@0xd49daa/safecrypt').SecretstreamHeader
  );

  try {
    const encryptedBody = encryptedData.subarray(STREAM_HEADER_SIZE);
    const chunks: Uint8Array[] = [];

    let readOffset = 0;
    while (readOffset < encryptedBody.length) {
      // Each encrypted chunk = STREAM_CHUNK_SIZE plaintext + 17 bytes overhead
      // (except final chunk which may be smaller)
      const chunkSize = STREAM_CHUNK_SIZE + STREAM_CHUNK_OVERHEAD;
      const remaining = encryptedBody.length - readOffset;
      const encChunkLen = Math.min(chunkSize, remaining);

      const encChunk = encryptedBody.subarray(readOffset, readOffset + encChunkLen);
      const { plaintext, isFinal } = stream.pull(encChunk);
      chunks.push(plaintext);

      readOffset += encChunkLen;
      if (isFinal) break;
    }

    stream.finalize();

    // Concatenate plaintext chunks
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  } finally {
    stream.dispose();
  }
}

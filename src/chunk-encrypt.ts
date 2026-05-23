/**
 * Chunk encryption metadata utilities for IPFS storage.
 *
 * Vault AEAD encryption/decryption lives in vault-aead.ts. This module keeps
 * legacy encrypted-length helpers used by tests and metadata checks.
 */

import { ChunkEncryption } from "./gen/manifest_pb.ts";
import {
  SINGLE_SHOT_OVERHEAD,
  STREAM_CHUNK_OVERHEAD,
  STREAM_CHUNK_SIZE,
  STREAM_HEADER_SIZE,
} from "./constants.ts";

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
  encryption: ChunkEncryption,
): number {
  if (encryption === ChunkEncryption.SINGLE_SHOT) {
    return plaintextLength + SINGLE_SHOT_OVERHEAD;
  } else {
    // STREAMING: header + (numChunks * overhead)
    // Uses locked STREAM_CHUNK_SIZE constant - not configurable
    const numChunks = Math.ceil(plaintextLength / STREAM_CHUNK_SIZE);
    return plaintextLength + STREAM_HEADER_SIZE +
      numChunks * STREAM_CHUNK_OVERHEAD;
  }
}

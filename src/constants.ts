/**
 * Domain separation constants for cryptographic operations.
 * UTF-8 encoded prefixes prevent collisions if same inputs used elsewhere.
 */
export const DOMAIN = {
  /** Domain prefix for file key derivation */
  FILE_KEY: 'ipfs-storage:file-key:v1',
} as const;

/** Chunk size in bytes (10MB) */
export const CHUNK_SIZE = 10 * 1024 * 1024;

/** Streaming threshold - chunks larger than this use streaming encryption */
export const STREAMING_THRESHOLD = 10 * 1024 * 1024;

/** Default number of chunks per CAR segment */
export const DEFAULT_SEGMENT_SIZE = 10;

/** Default retry attempts for chunk fetches */
export const DEFAULT_RETRIES = 3;

/** Default concurrency for parallel chunk downloads per file */
export const DEFAULT_CHUNK_CONCURRENCY = 3;

/** Default concurrency for parallel file downloads */
export const DEFAULT_FILE_CONCURRENCY = 3;

/** Target sub-manifest size in bytes (~1MB) */
export const SUB_MANIFEST_SIZE = 1 * 1024 * 1024;

// ============================================================================
// Encryption Constants (Phase 7)
// ============================================================================

/** Nonce size for XChaCha20-Poly1305 */
export const NONCE_SIZE = 24;

/** Auth tag size for XChaCha20-Poly1305 */
export const AUTH_TAG_SIZE = 16;

/** Per-segment encryption overhead for SINGLE_SHOT (nonce + tag) */
export const SINGLE_SHOT_OVERHEAD = NONCE_SIZE + AUTH_TAG_SIZE; // 40 bytes

/** Header size for secretstream */
export const STREAM_HEADER_SIZE = 24;

/** Per-chunk overhead for secretstream */
export const STREAM_CHUNK_OVERHEAD = 17;

/**
 * Streaming chunk size (64KB).
 * CRITICAL: This value is locked and must be consistent between upload and download.
 * Download uses this constant to compute encrypted lengths from plaintext lengths.
 */
export const STREAM_CHUNK_SIZE = 64 * 1024;

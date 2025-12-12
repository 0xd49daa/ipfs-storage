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

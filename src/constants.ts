/** Chunk size in bytes (16 MiB) */
export const CHUNK_SIZE = 16 * 1024 * 1024;

/** Default number of chunks per CAR segment */
export const DEFAULT_SEGMENT_SIZE = 10;

/** Default retry attempts for chunk fetches */
export const DEFAULT_RETRIES = 3;

/** Default concurrency for parallel chunk downloads per file */
export const DEFAULT_CHUNK_CONCURRENCY = 3;

/** Default concurrency for parallel file downloads */
export const DEFAULT_FILE_CONCURRENCY = 3;

/** Supported encrypted manifest schema version. */
export const MANIFEST_VERSION_SUPPORTED = 1;

/** Target sub-manifest size in bytes (~1MB) */
export const SUB_MANIFEST_SIZE = 1 * 1024 * 1024;

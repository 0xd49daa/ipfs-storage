import type { ContentHash } from '@filemanager/encryptionv2';

/**
 * Base error class for all ipfs-storage errors.
 */
export class IpfsStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpfsStorageError';
  }
}

/**
 * Validation error for invalid inputs.
 * Thrown for: empty batch, invalid path format, no recipients, etc.
 */
export class ValidationError extends IpfsStorageError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Content integrity error.
 * Thrown when downloaded content hash doesn't match expected hash.
 */
export class IntegrityError extends IpfsStorageError {
  readonly path: string;
  readonly expected: ContentHash;
  readonly actual: ContentHash;

  constructor(path: string, expected: ContentHash, actual: ContentHash) {
    super(`Integrity check failed for "${path}": content hash mismatch`);
    this.name = 'IntegrityError';
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Manifest parsing or decryption error.
 */
export class ManifestError extends IpfsStorageError {
  readonly batchCid: string;

  constructor(batchCid: string, message: string) {
    super(`Manifest error for batch ${batchCid}: ${message}`);
    this.name = 'ManifestError';
    this.batchCid = batchCid;
  }
}

/**
 * Chunk fetch error after retries exhausted.
 */
export class ChunkUnavailableError extends IpfsStorageError {
  readonly batchCid: string;
  readonly chunkId: string;

  constructor(batchCid: string, chunkId: string, cause?: Error) {
    super(`Chunk unavailable: ${chunkId} in batch ${batchCid}`);
    this.name = 'ChunkUnavailableError';
    this.batchCid = batchCid;
    this.chunkId = chunkId;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Segment state for resumable uploads.
 */
export interface SegmentStateForError {
  index: number;
  status: 'pending' | 'uploading' | 'complete' | 'failed';
  chunkCids: Record<string, string>; // chunkId → CID
  error?: string;
}

/**
 * Upload state for resumable uploads.
 * Defined here to avoid circular dependency with types.ts.
 */
export interface UploadStateForError {
  batchId: string;
  segments: SegmentStateForError[];
  manifestCid?: string;
  rootCid?: string;
}

/**
 * Segment upload failure with resume state.
 */
export class SegmentUploadError extends IpfsStorageError {
  readonly segmentIndex: number;
  readonly state: UploadStateForError;

  constructor(segmentIndex: number, state: UploadStateForError, cause?: Error) {
    super(`Segment ${segmentIndex} upload failed`);
    this.name = 'SegmentUploadError';
    this.segmentIndex = segmentIndex;
    this.state = state;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * CID verification failure.
 * Thrown when computed CID doesn't match expected CID.
 */
export class CidMismatchError extends IpfsStorageError {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`CID mismatch: expected ${expected}, got ${actual}`);
    this.name = 'CidMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

// Re-export encryption errors for convenience
export { EncryptionError, ErrorCode } from '@filemanager/encryptionv2';

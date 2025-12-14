/**
 * Upload Orchestration (Phase 10)
 *
 * Main uploadBatch() function that orchestrates all building blocks
 * from Phases 0-9 to upload encrypted files to IPFS.
 */

import { generateKey, randomBytes, type SymmetricKey } from '@filemanager/encryptionv2';
import { base58, base64 } from '@scure/base';
import { CID } from 'multiformats/cid';
import { CarBufferWriter } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';

import { asFilePath, type ChunkId } from './branded.ts';
import type { IpfsClient } from './ipfs-client.ts';
import type { ChunkPlan, PlannedFile, PlannedChunkRef } from './chunk-plan.ts';
import type { EncryptedChunk, EncryptedSegmentInfo } from './chunk-encrypt.ts';
import type {
  FileInput,
  FileInfo,
  DirectoryInfo,
  ChunkRef,
  BatchManifest,
  UploadOptions,
  BatchResult,
  RenamedFile,
  UploadProgress,
} from './types.ts';
import type {
  UploadStateForError,
  SegmentStateForError,
} from './errors.ts';

import { ValidationError, SegmentUploadError, ResumeValidationError } from './errors.ts';
import { resolveConflicts } from './conflicts.ts';
import { buildDirectoryTree } from './directories.ts';
import { planChunks } from './chunk-plan.ts';
import { encryptChunks } from './chunk-encrypt.ts';
import { buildCarSegments } from './car-builder.ts';
import { buildManifest, encryptManifest } from './manifest-builder.ts';
import { computeRawCid, computeDagPbCid } from './ipfs-client.ts';
import { basename } from './path-utils.ts';
import { DEFAULT_SEGMENT_SIZE } from './constants.ts';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build FileInfo array from chunk plan and encrypted chunks.
 * Uses chunkCidMap from buildCarSegments as the single source of truth for CIDs.
 */
function buildFileInfoArray(
  files: FileInput[],
  resolvedPaths: string[],
  plan: ChunkPlan,
  encryptedChunks: EncryptedChunk[],
  chunkCidMap: Map<ChunkId, string>,
  created: number
): FileInfo[] {
  const result: FileInfo[] = [];

  // Build a lookup from chunkId to EncryptedChunk for segment info
  const encryptedChunkMap = new Map<string, EncryptedChunk>();
  for (const chunk of encryptedChunks) {
    encryptedChunkMap.set(chunk.chunkId, chunk);
  }

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex]!;
    const resolvedPath = resolvedPaths[fileIndex]!;
    const plannedFile = plan.files[fileIndex]!;

    // Build ChunkRef array
    const chunks: ChunkRef[] = [];

    for (const plannedRef of plannedFile.chunks) {
      const encChunk = encryptedChunkMap.get(plannedRef.chunkId);
      if (!encChunk) {
        throw new Error(`Encrypted chunk not found for chunkId: ${plannedRef.chunkId}`);
      }

      // Find the segment info for this file in this chunk
      const segInfo = encChunk.segments.find((s) => s.fileIndex === fileIndex);
      if (!segInfo) {
        throw new Error(
          `Segment info not found for fileIndex ${fileIndex} in chunk ${plannedRef.chunkId}`
        );
      }

      const cid = chunkCidMap.get(plannedRef.chunkId as ChunkId);
      if (!cid) {
        throw new Error(`CID not found for chunkId: ${plannedRef.chunkId}`);
      }

      chunks.push({
        chunkId: plannedRef.chunkId,
        cid,
        offset: segInfo.encryptedOffset,
        length: segInfo.plaintextLength,
        encryption: plannedRef.encryption,
        encryptedLength: segInfo.encryptedLength,
      });
    }

    result.push({
      path: resolvedPath,
      name: basename(asFilePath(resolvedPath)),
      size: file.file.size,
      contentHash: file.contentHash,
      chunks,
      created: file.created ?? created,
    });
  }

  return result;
}

/**
 * Count how many files have been fully encrypted.
 * A file is fully encrypted when all its chunks have been processed.
 */
function countFilesEncrypted(
  encryptedChunks: EncryptedChunk[],
  plan: ChunkPlan
): number {
  // Track which chunks have been encrypted (by index)
  const encryptedChunkIds = new Set<string>();
  for (const chunk of encryptedChunks) {
    encryptedChunkIds.add(chunk.chunkId);
  }

  // Count files where all chunks are encrypted
  let count = 0;
  for (const plannedFile of plan.files) {
    // Empty files are always "fully encrypted"
    if (plannedFile.chunks.length === 0) {
      count++;
      continue;
    }

    // Check if all chunks for this file have been encrypted
    const allChunksEncrypted = plannedFile.chunks.every((ref) =>
      encryptedChunkIds.has(ref.chunkId)
    );
    if (allChunksEncrypted) {
      count++;
    }
  }

  return count;
}

/**
 * Build a minimal CAR for batches with no chunks (all empty files).
 * Creates a root directory containing only manifest links.
 */
async function buildEmptyBatchCar(
  manifest: Uint8Array,
  subManifests: Uint8Array[]
): Promise<{
  rootCid: string;
  manifestCid: string;
  subManifestCids: string[];
  carBytes: Uint8Array;
}> {
  // Compute manifest CID (raw codec)
  const manifestCid = await computeRawCid(manifest);

  // Compute sub-manifest CIDs
  const subManifestCids: CID[] = [];
  for (const subManifest of subManifests) {
    subManifestCids.push(await computeRawCid(subManifest));
  }

  // Build root directory links
  const links: dagPb.PBLink[] = [];

  // Add manifest link
  links.push({
    Name: 'm',
    Tsize: manifest.length,
    Hash: manifestCid,
  });

  // Add sub-manifest links
  for (let i = 0; i < subManifests.length; i++) {
    links.push({
      Name: `m_${i}`,
      Tsize: subManifests[i]!.length,
      Hash: subManifestCids[i]!,
    });
  }

  // Sort links by name (byte-wise)
  links.sort((a, b) => {
    const aName = a.Name ?? '';
    const bName = b.Name ?? '';
    return aName < bName ? -1 : aName > bName ? 1 : 0;
  });

  // Create root directory node
  const rootNode = dagPb.createNode(new Uint8Array(0), links);
  const rootBytes = dagPb.encode(rootNode);
  const rootCid = await computeDagPbCid(rootBytes);

  // Build CAR with all blocks
  const blocks: Array<{ cid: CID; bytes: Uint8Array }> = [];

  // Add manifest block
  blocks.push({ cid: manifestCid, bytes: manifest });

  // Add sub-manifest blocks
  for (let i = 0; i < subManifests.length; i++) {
    blocks.push({ cid: subManifestCids[i]!, bytes: subManifests[i]! });
  }

  // Add root directory block
  blocks.push({ cid: rootCid, bytes: rootBytes });

  // Estimate CAR size
  let estimatedSize = 1024; // header
  for (const block of blocks) {
    estimatedSize += block.bytes.length + 50; // block + CID overhead
  }

  // Create CAR
  const buffer = new ArrayBuffer(estimatedSize);
  const writer = CarBufferWriter.createWriter(buffer, {
    roots: [rootCid],
  });
  for (const block of blocks) {
    writer.write(block);
  }
  const carBytes = writer.close();

  return {
    rootCid: rootCid.toString(),
    manifestCid: manifestCid.toString(),
    subManifestCids: subManifestCids.map((cid) => cid.toString()),
    carBytes,
  };
}

/**
 * Check if abort signal is triggered and throw if so.
 */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Upload aborted', 'AbortError');
  }
}

// ============================================================================
// Resume Validation Helpers (Phase 11)
// ============================================================================

/**
 * Validate the structure of a resume state object.
 * Throws ValidationError if the structure is malformed.
 */
function assertValidResumeState(state: unknown): asserts state is UploadStateForError {
  if (!state || typeof state !== 'object') {
    throw new ValidationError('resumeState must be an object');
  }
  const s = state as Record<string, unknown>;

  // Required string fields
  if (typeof s.batchId !== 'string' || !s.batchId) {
    throw new ValidationError('resumeState.batchId must be a non-empty string');
  }
  if (typeof s.manifestCid !== 'string' || !s.manifestCid) {
    throw new ValidationError('resumeState.manifestCid must be a non-empty string');
  }
  if (typeof s.rootCid !== 'string' || !s.rootCid) {
    throw new ValidationError('resumeState.rootCid must be a non-empty string');
  }
  if (typeof s.manifestKeyBase64 !== 'string') {
    throw new ValidationError('resumeState.manifestKeyBase64 must be a string');
  }

  // Validate manifestKey is valid base64 and 32 bytes
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64.decode(s.manifestKeyBase64 as string);
  } catch {
    throw new ValidationError('resumeState.manifestKeyBase64 is not valid base64');
  }
  if (keyBytes.length !== 32) {
    throw new ValidationError('resumeState.manifestKeyBase64 must decode to 32 bytes');
  }

  // Validate segments array
  if (!Array.isArray(s.segments) || s.segments.length === 0) {
    throw new ValidationError('resumeState.segments must be a non-empty array');
  }

  const validStatuses = new Set(['pending', 'uploading', 'complete', 'failed']);
  for (let i = 0; i < s.segments.length; i++) {
    const seg = s.segments[i] as Record<string, unknown>;
    if (typeof seg !== 'object' || seg === null) {
      throw new ValidationError(`resumeState.segments[${i}] must be an object`);
    }
    if (seg.index !== i) {
      throw new ValidationError(`resumeState.segments[${i}].index must equal ${i}`);
    }
    if (!validStatuses.has(seg.status as string)) {
      throw new ValidationError(
        `resumeState.segments[${i}].status must be pending|uploading|complete|failed`
      );
    }
    if (typeof seg.chunkCids !== 'object' || seg.chunkCids === null) {
      throw new ValidationError(`resumeState.segments[${i}].chunkCids must be an object`);
    }
  }
}

/**
 * Validate resume state segment count matches the current upload.
 *
 * NOTE: We do NOT skip segments or validate CIDs. Encryption uses random nonces,
 * so CIDs are non-deterministic across sessions. The manifestKey is decoded
 * earlier in the upload flow (Phase 5) to ensure consistent file key derivation.
 *
 * @throws ResumeValidationError if segment count mismatches
 */
function validateResumeState(
  resumeState: UploadStateForError,
  expectedSegmentCount: number
): void {
  if (resumeState.segments.length !== expectedSegmentCount) {
    throw new ResumeValidationError(
      'segmentCount',
      String(expectedSegmentCount),
      String(resumeState.segments.length)
    );
  }
}

// ============================================================================
// Main Upload Function
// ============================================================================

/**
 * Upload a batch of files to IPFS.
 *
 * Orchestrates the complete upload flow:
 * 1. Validates inputs
 * 2. Resolves duplicate paths
 * 3. Plans chunks using aggregation engine
 * 4. Generates manifest key
 * 5. Encrypts all chunks
 * 6. Builds CAR segments
 * 7. Uploads segments sequentially
 * 8. Returns BatchResult with manifest
 *
 * @param files - Files to upload
 * @param options - Upload options
 * @param ipfsClient - IPFS client implementation
 * @returns BatchResult with CID, manifest, and upload stats
 * @throws ValidationError for invalid inputs
 * @throws SegmentUploadError for upload failures (contains resume state)
 * @throws AbortError if signal is aborted
 */
export async function uploadBatch(
  files: FileInput[],
  options: UploadOptions,
  ipfsClient: IpfsClient
): Promise<BatchResult> {
  const { signal, onProgress, onSegmentComplete } = options;
  const segmentSize = options.segmentSize ?? DEFAULT_SEGMENT_SIZE;

  // === PHASE 1: VALIDATION ===
  if (files.length === 0) {
    throw new ValidationError('Cannot upload empty batch');
  }
  if (options.recipients.length === 0) {
    throw new ValidationError('At least one recipient is required');
  }
  if (!Number.isFinite(segmentSize) || segmentSize <= 0 || !Number.isInteger(segmentSize)) {
    throw new ValidationError(
      `segmentSize must be a positive integer, got: ${segmentSize}`
    );
  }

  // === PHASE 1.5: RESUME STATE STRUCTURE VALIDATION ===
  if (options.resumeState) {
    assertValidResumeState(options.resumeState);
  }

  // === PHASE 2: CONFLICT RESOLUTION ===
  const resolvedPaths = resolveConflicts(files);

  // Track renamed files
  const renamed: RenamedFile[] = [];
  for (let i = 0; i < files.length; i++) {
    if (files[i]!.path !== resolvedPaths[i]!) {
      renamed.push({
        originalPath: files[i]!.path,
        newPath: resolvedPaths[i]!,
      });
    }
  }

  // === PHASE 3: DIRECTORY BUILDING ===
  // Use timestamp from resume state if present, otherwise generate new one
  const created = options.resumeState?.created ?? Date.now();
  const directories = buildDirectoryTree(resolvedPaths, options.directories, {
    defaultCreated: created,
  });

  // === PHASE 4: CHUNK PLANNING ===
  const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);

  onProgress?.({
    phase: 'planning',
    filesProcessed: 0,
    totalFiles: files.length,
    bytesProcessed: 0,
    totalBytes,
  });

  checkAbort(signal);

  const chunkPlan = await planChunks(files, resolvedPaths);

  // === PHASE 5: MANIFEST KEY (GENERATE OR USE FROM RESUME STATE) ===
  const manifestKey = options.resumeState
    ? (base64.decode(options.resumeState.manifestKeyBase64) as SymmetricKey)
    : await generateKey();

  // === PHASE 6: CHUNK ENCRYPTION ===
  checkAbort(signal);

  const encryptedChunks: EncryptedChunk[] = [];
  let bytesProcessed = 0;

  // Count empty files upfront (they're "encrypted" immediately)
  const emptyFileCount = files.filter((f) => f.file.size === 0).length;

  for await (const chunk of encryptChunks(chunkPlan, files, manifestKey, {
    signal,
  })) {
    encryptedChunks.push(chunk);
    bytesProcessed += chunk.encryptedSize;

    checkAbort(signal);

    onProgress?.({
      phase: 'encrypting',
      filesProcessed: countFilesEncrypted(encryptedChunks, chunkPlan),
      totalFiles: files.length,
      bytesProcessed,
      totalBytes,
    });
  }

  // === PHASE 7: HANDLE EMPTY BATCH SPECIAL CASE ===
  if (encryptedChunks.length === 0) {
    // All files are empty - build minimal CAR with manifest only
    onProgress?.({
      phase: 'building',
      filesProcessed: files.length,
      totalFiles: files.length,
      bytesProcessed: 0,
      totalBytes: 0,
    });

    // Build FileInfo with empty chunks
    const fileInfos: FileInfo[] = files.map((file, i) => ({
      path: resolvedPaths[i]!,
      name: basename(asFilePath(resolvedPaths[i]!)),
      size: 0,
      contentHash: file.contentHash,
      chunks: [],
      created: file.created ?? created,
    }));

    // Build and encrypt manifest
    const manifestResult = buildManifest({
      files: fileInfos,
      directories,
      created,
    });

    const { envelope, encryptedSubManifests } = await encryptManifest({
      manifest: manifestResult,
      recipients: options.recipients,
      senderKeyPair: options.senderKeyPair,
      manifestKey,
    });

    // Build minimal CAR
    const emptyCarResult = await buildEmptyBatchCar(envelope, encryptedSubManifests);

    // Initialize upload state
    const emptyBatchId = options.resumeState?.batchId ?? base58.encode(await randomBytes(16));
    const uploadState: UploadStateForError = {
      batchId: emptyBatchId,
      segments: [
        {
          index: 0,
          status: 'pending',
          chunkCids: {},
        },
      ],
      manifestCid: emptyCarResult.manifestCid,
      rootCid: emptyCarResult.rootCid,
      manifestKeyBase64: base64.encode(manifestKey),
      created,
    };

    // === EMPTY BATCH RESUME VALIDATION ===
    // Validate segment count if resuming. We always re-upload because encryption
    // uses random nonces, making CIDs non-deterministic.
    if (options.resumeState) {
      if (options.resumeState.segments.length !== 1) {
        throw new ResumeValidationError(
          'segmentCount',
          '1',
          String(options.resumeState.segments.length)
        );
      }
      // Note: We do NOT skip upload even if segment is "complete" in resumeState.
      // Re-encryption produces different CIDs, so we must re-upload.
    }

    // Upload single segment
    checkAbort(signal);

    onProgress?.({
      phase: 'uploading',
      filesProcessed: files.length,
      totalFiles: files.length,
      bytesProcessed: 0,
      totalBytes: 0,
      currentSegment: 1,
      totalSegments: 1,
      chunksSkipped: 0,
    });

    uploadState.segments[0]!.status = 'uploading';

    try {
      // Create async iterable from carBytes
      async function* carGenerator(): AsyncIterable<Uint8Array> {
        yield emptyCarResult.carBytes;
      }

      await ipfsClient.uploadCar(carGenerator());
      uploadState.segments[0]!.status = 'complete';

      onSegmentComplete?.({
        index: 0,
        chunksUploaded: 0,
        chunksSkipped: 0,
        totalSegments: 1,
        state: { ...uploadState },
      });
    } catch (error) {
      uploadState.segments[0]!.status = 'failed';
      uploadState.segments[0]!.error =
        error instanceof Error ? error.message : String(error);
      throw new SegmentUploadError(
        0,
        uploadState,
        error instanceof Error ? error : undefined
      );
    }

    // Build result
    onProgress?.({
      phase: 'finalizing',
      filesProcessed: files.length,
      totalFiles: files.length,
      bytesProcessed: 0,
      totalBytes: 0,
      currentSegment: 1,
      totalSegments: 1,
      chunksSkipped: 0,
    });

    const batchManifest: BatchManifest = {
      cid: emptyCarResult.rootCid,
      manifestKey,
      senderPublicKey: options.senderKeyPair.publicKey,
      directories,
      files: fileInfos,
      created,
    };

    return {
      cid: emptyCarResult.rootCid,
      manifest: batchManifest,
      totalSize: emptyCarResult.carBytes.length,
      chunkCount: 0,
      manifestCount: 1 + encryptedSubManifests.length,
      segmentsUploaded: 1,
      renamed: renamed.length > 0 ? renamed : undefined,
    };
  }

  // === PHASE 8: FIRST CAR BUILD - GET CID MAP ===
  onProgress?.({
    phase: 'building',
    filesProcessed: files.length,
    totalFiles: files.length,
    bytesProcessed,
    totalBytes,
  });

  // Use a placeholder manifest to get chunk CIDs
  const placeholderManifest = new Uint8Array(1); // Minimal placeholder
  const firstCarResult = await buildCarSegments({
    chunks: encryptedChunks,
    manifest: placeholderManifest,
    subManifests: [],
    segmentSize,
  });

  // === PHASE 9: BUILD FILE INFO WITH CIDS ===
  const fileInfos = buildFileInfoArray(
    files,
    resolvedPaths,
    chunkPlan,
    encryptedChunks,
    firstCarResult.chunkCidMap as Map<ChunkId, string>,
    created
  );

  // === PHASE 10: MANIFEST ENCRYPTION ===
  const manifestResult = buildManifest({
    files: fileInfos,
    directories,
    created,
  });

  const { envelope, encryptedSubManifests } = await encryptManifest({
    manifest: manifestResult,
    recipients: options.recipients,
    senderKeyPair: options.senderKeyPair,
    manifestKey,
  });

  // === PHASE 11: FINAL CAR BUILD ===
  const carResult = await buildCarSegments({
    chunks: encryptedChunks,
    manifest: envelope,
    subManifests: encryptedSubManifests,
    segmentSize,
  });

  // === PHASE 12: INITIALIZE UPLOAD STATE ===
  const batchId = options.resumeState?.batchId ?? base58.encode(await randomBytes(16));
  const uploadState: UploadStateForError = {
    batchId,
    segments: carResult.segments.map((seg) => ({
      index: seg.segmentIndex,
      status: 'pending' as const,
      chunkCids: Object.fromEntries(
        seg.chunkIds.map((id) => [id, carResult.chunkCidMap.get(id)!])
      ),
    })),
    manifestCid: carResult.manifestCid,
    rootCid: carResult.rootCid,
    manifestKeyBase64: base64.encode(manifestKey),
    created,
  };

  // === PHASE 12.5: RESUME VALIDATION ===
  // Validate segment count matches if resuming
  if (options.resumeState) {
    validateResumeState(options.resumeState, carResult.segmentCount);
  }

  // === PHASE 13: UPLOAD SEGMENTS ===
  // NOTE: We always upload ALL segments, even when resuming with "complete" segments.
  // This is because encryption uses random nonces, so re-encryption produces different
  // chunk CIDs. Skipping "complete" segments would leave the manifest referencing
  // non-existent blocks, causing batch corruption.
  //
  // True segment skipping requires either:
  // 1. Deterministic encryption (derive nonces from content)
  // 2. Storing encrypted chunk bytes in resume state
  // Neither is currently implemented.
  let segmentsUploaded = 0;
  let totalBytesUploaded = 0;

  for (const segment of carResult.segments) {
    checkAbort(signal);

    uploadState.segments[segment.segmentIndex]!.status = 'uploading';

    onProgress?.({
      phase: 'uploading',
      filesProcessed: files.length,
      totalFiles: files.length,
      bytesProcessed,
      totalBytes,
      currentSegment: segment.segmentIndex + 1,
      totalSegments: carResult.segmentCount,
    });

    try {
      // Wrap generator to track bytes uploaded
      let segmentBytes = 0;
      async function* trackingGenerator(): AsyncIterable<Uint8Array> {
        for await (const chunk of segment.generate()) {
          segmentBytes += chunk.length;
          yield chunk;
        }
      }

      // uploadCar may return '' for non-final segments (empty roots) - that's OK
      await ipfsClient.uploadCar(trackingGenerator());
      totalBytesUploaded += segmentBytes;

      uploadState.segments[segment.segmentIndex]!.status = 'complete';
      segmentsUploaded++;

      onSegmentComplete?.({
        index: segment.segmentIndex,
        chunksUploaded: segment.chunkCount,
        chunksSkipped: 0,
        totalSegments: carResult.segmentCount,
        state: { ...uploadState },
      });
    } catch (error) {
      uploadState.segments[segment.segmentIndex]!.status = 'failed';
      uploadState.segments[segment.segmentIndex]!.error =
        error instanceof Error ? error.message : String(error);

      throw new SegmentUploadError(
        segment.segmentIndex,
        uploadState,
        error instanceof Error ? error : undefined
      );
    }
  }

  // === PHASE 14: BUILD RESULT ===
  onProgress?.({
    phase: 'finalizing',
    filesProcessed: files.length,
    totalFiles: files.length,
    bytesProcessed,
    totalBytes,
    currentSegment: carResult.segmentCount,
    totalSegments: carResult.segmentCount,
  });

  const batchManifest: BatchManifest = {
    cid: carResult.rootCid,
    manifestKey,
    senderPublicKey: options.senderKeyPair.publicKey,
    directories,
    files: fileInfos,
    created,
  };

  return {
    cid: carResult.rootCid,
    manifest: batchManifest,
    totalSize: totalBytesUploaded,
    chunkCount: encryptedChunks.length,
    manifestCount: 1 + encryptedSubManifests.length,
    segmentsUploaded,
    renamed: renamed.length > 0 ? renamed : undefined,
  };
}

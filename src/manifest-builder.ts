/**
 * Manifest Construction & Encryption (Phase 9)
 *
 * Builds, splits, and encrypts manifests for IPFS batch storage.
 */

import type { SymmetricKey } from "./crypto-primitives.ts";

import { MANIFEST_VERSION_SUPPORTED, SUB_MANIFEST_SIZE } from "./constants.ts";
import { ValidationError } from "./errors.ts";
import { encodeRootManifest, encodeSubManifest } from "./serialization.ts";
import { padManifestPlaintext } from "./manifest-padding.ts";
import { encryptVaultManifestRecord } from "./vault-aead.ts";
import type {
  DirectoryInfo,
  FileInfo,
  RootManifestData,
  SubManifestData,
  SubManifestIndexEntry,
} from "./types.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Options for building manifests.
 */
export interface BuildManifestOptions {
  /** Maximum size per sub-manifest in bytes (default: SUB_MANIFEST_SIZE = 1MB) */
  maxSubManifestSize?: number;
}

/**
 * Input for building a manifest.
 */
export interface BuildManifestInput {
  /** Files to include in the manifest */
  files: FileInfo[];
  /** Directories to include in the manifest */
  directories: DirectoryInfo[];
  /** Batch creation timestamp (Unix ms) */
  created: number;
  /** Build options */
  options?: BuildManifestOptions;
}

/**
 * Result of building a manifest (before encryption).
 */
export interface ManifestBuildResult {
  /** Serialized root manifest (RootManifestData encoded to Protobuf) */
  rootManifest: Uint8Array;
  /** Serialized sub-manifests (SubManifestData encoded to Protobuf) */
  subManifests: Uint8Array[];
  /** Sub-manifest index entries (for reference) */
  subManifestIndex: SubManifestIndexEntry[];
}

/**
 * Input for encrypting a manifest.
 */
export interface EncryptManifestInput {
  /** Built manifest result from buildManifest() */
  manifest: ManifestBuildResult;
  /** Caller-derived manifest key */
  manifestKey: SymmetricKey;
  /** Caller-supplied batch id for locator prefix and AAD */
  batchId: Uint8Array;
}

/**
 * Result of encrypting manifests.
 */
export interface EncryptedManifestResult {
  /** Root manifest blob: 16-byte batch_id locator prefix + AEAD record */
  envelope: Uint8Array;
  /** Encrypted sub-manifests as pure AEAD records */
  encryptedSubManifests: Uint8Array[];
  /** The manifest key (returned to caller for storage) */
  manifestKey: SymmetricKey;
}

/**
 * Input for build + encrypt in one call.
 */
export interface BuildAndEncryptManifestInput {
  /** Files to include in the manifest */
  files: FileInfo[];
  /** Directories to include in the manifest */
  directories: DirectoryInfo[];
  /** Batch creation timestamp (Unix ms) */
  created: number;
  /** Caller-derived manifest key */
  manifestKey: SymmetricKey;
  /** Caller-supplied batch id for locator prefix and AAD */
  batchId: Uint8Array;
  /** Build options */
  options?: BuildManifestOptions;
}

// ============================================================================
// Sorting
// ============================================================================

const textEncoder = new TextEncoder();

/**
 * Compare two strings by their UTF-8 byte representation.
 * This is locale-independent and produces deterministic ordering
 * that matches byte-wise comparison across implementations.
 */
function compareByteWise(a: string, b: string): number {
  const aBytes = textEncoder.encode(a);
  const bBytes = textEncoder.encode(b);
  const minLen = Math.min(aBytes.length, bBytes.length);

  for (let i = 0; i < minLen; i++) {
    const diff = aBytes[i]! - bBytes[i]!;
    if (diff !== 0) return diff;
  }

  return aBytes.length - bBytes.length;
}

/**
 * Sort files by path using true UTF-8 byte-wise comparison.
 * This is locale-independent and produces deterministic ordering
 * that matches byte-wise comparison across implementations.
 *
 * @param files - Files to sort
 * @returns New array of files sorted by path
 */
export function sortFilesByPath(files: FileInfo[]): FileInfo[] {
  return [...files].sort((a, b) => compareByteWise(a.path, b.path));
}

// ============================================================================
// Splitting
// ============================================================================

interface SplitResult {
  groups: FileInfo[][];
  index: SubManifestIndexEntry[];
}

/**
 * Split sorted files into groups that each fit within maxSize when serialized.
 * Each group will become a sub-manifest.
 */
function splitFilesIntoGroups(files: FileInfo[], maxSize: number): SplitResult {
  const groups: FileInfo[][] = [];
  const index: SubManifestIndexEntry[] = [];

  let currentGroup: FileInfo[] = [];
  let manifestIndex = 0;

  for (const file of files) {
    // Add file to current group
    currentGroup.push(file);

    // Check if serialized size exceeds limit
    const testSerialized = encodeSubManifest({ files: currentGroup });

    if (testSerialized.length > maxSize && currentGroup.length > 1) {
      // Remove the file that pushed us over
      currentGroup.pop();

      // Finalize current group
      groups.push(currentGroup);
      index.push({
        manifestId: `m_${manifestIndex}`,
        startPath: currentGroup[0]!.path,
        endPath: currentGroup[currentGroup.length - 1]!.path,
        fileCount: currentGroup.length,
      });
      manifestIndex++;

      // Start new group with the file we removed
      currentGroup = [file];
    }
  }

  // Finalize last group if not empty
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
    index.push({
      manifestId: `m_${manifestIndex}`,
      startPath: currentGroup[0]!.path,
      endPath: currentGroup[currentGroup.length - 1]!.path,
      fileCount: currentGroup.length,
    });
  }

  return { groups, index };
}

// ============================================================================
// Building
// ============================================================================

/**
 * Build manifest data with optional splitting.
 *
 * If the serialized manifest exceeds maxSubManifestSize (default 1MB),
 * files are split into sub-manifests. Directories always remain in the
 * root manifest (never split).
 *
 * @param input - Build input with files, directories, created timestamp
 * @returns Built manifest result with serialized root and sub-manifests
 */
export function buildManifest(input: BuildManifestInput): ManifestBuildResult {
  const { files, directories, created, options = {} } = input;
  const maxSize = options.maxSubManifestSize ?? SUB_MANIFEST_SIZE;

  // Validate maxSubManifestSize
  if (maxSize <= 0) {
    throw new ValidationError(
      `maxSubManifestSize must be positive, got ${maxSize}`,
    );
  }

  // Sort files by path (byte-wise) for deterministic output
  const sortedFiles = sortFilesByPath(files);

  // Try building without splitting first
  const testManifest: RootManifestData = {
    manifestVersion: MANIFEST_VERSION_SUPPORTED,
    directories,
    files: sortedFiles,
    subManifests: [],
    created,
  };
  const testSerialized = encodeRootManifest(testManifest);

  // If small enough, no files, or only one file, return as-is
  // (splitting only makes sense with multiple files)
  if (testSerialized.length <= maxSize || sortedFiles.length <= 1) {
    return {
      rootManifest: testSerialized,
      subManifests: [],
      subManifestIndex: [],
    };
  }

  // Need splitting - group files into sub-manifests
  const { groups, index } = splitFilesIntoGroups(sortedFiles, maxSize);

  // Build sub-manifests
  const subManifests = groups.map((group) => encodeSubManifest({ files: group }));

  // Build root manifest (directories only, files are in sub-manifests)
  const rootManifest: RootManifestData = {
    manifestVersion: MANIFEST_VERSION_SUPPORTED,
    directories,
    files: [], // Files are in sub-manifests
    subManifests: index,
    created,
  };

  return {
    rootManifest: encodeRootManifest(rootManifest),
    subManifests,
    subManifestIndex: index,
  };
}

// ============================================================================
// Encryption
// ============================================================================

/**
 * Encrypt manifest with the caller-provided manifest key.
 *
 * Root gets the Vault plaintext batch_id locator prefix. Sub-manifests are
 * stored as pure Vault AEAD records with sequential manifest_node_id >= 1.
 *
 * @param input - Encrypt input with manifest and manifest key
 * @returns Encrypted envelope, sub-manifests, and manifest key
 */
export async function encryptManifest(
  input: EncryptManifestInput,
): Promise<EncryptedManifestResult> {
  const { manifest, manifestKey, batchId } = input;

  const encryptedRoot = await encryptVaultManifestRecord({
    plaintext: padManifestPlaintext(manifest.rootManifest),
    manifestKey,
    batchId,
    manifestNodeId: 0,
  });

  const encryptedSubManifests = await Promise.all(
    manifest.subManifests.map((subManifest, index) => {
      return encryptVaultManifestRecord({
        plaintext: padManifestPlaintext(subManifest),
        manifestKey,
        batchId,
        manifestNodeId: index + 1,
      });
    }),
  );

  const rootBlob = new Uint8Array(batchId.length + encryptedRoot.length);
  rootBlob.set(batchId, 0);
  rootBlob.set(encryptedRoot, batchId.length);

  return {
    envelope: rootBlob,
    encryptedSubManifests,
    manifestKey,
  };
}

/**
 * Build and encrypt manifest in one call.
 *
 * Convenience function that combines buildManifest() and encryptManifest().
 *
 * @param input - Combined build and encrypt input
 * @returns Encrypted envelope, sub-manifests, and manifest key
 */
export async function buildAndEncryptManifest(
  input: BuildAndEncryptManifestInput,
): Promise<EncryptedManifestResult> {
  const manifest = buildManifest({
    files: input.files,
    directories: input.directories,
    created: input.created,
    options: input.options,
  });

  return encryptManifest({
    manifest,
    manifestKey: input.manifestKey,
    batchId: input.batchId,
  });
}

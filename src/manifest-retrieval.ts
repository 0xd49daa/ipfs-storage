/**
 * Manifest retrieval and decryption (Phase 13).
 *
 * Implements getManifest() for fetching and decrypting batch manifests from IPFS.
 */

import type { SymmetricKey } from "@0xd49daa/safecrypt";

import { ManifestError, ValidationError } from "./errors.ts";
import {
  decryptVaultManifestRecord,
  VAULT_AES_256_KEY_SIZE,
  VAULT_BATCH_ID_SIZE,
} from "./vault-aead.ts";
import { decodeRootManifest, decodeSubManifest } from "./serialization.ts";
import { unpadManifestPlaintext } from "./manifest-padding.ts";
import type { IpfsClient } from "./ipfs-client.ts";
import type { BatchManifest, FileInfo, GetManifestOptions } from "./types.ts";

/**
 * Check if abort signal is triggered and throw AbortError if so.
 */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException(
      signal.reason instanceof Error
        ? signal.reason.message
        : String(signal.reason ?? "Aborted"),
      "AbortError",
    );
  }
}

/**
 * Collect all bytes from an async iterable into a single Uint8Array.
 * Checks abort signal between each chunk for responsiveness.
 *
 * Note: This buffers the entire content in memory. For manifests this is acceptable
 * since they're typically < 1MB (split threshold). Streaming decryption would require
 * architectural changes since XChaCha20-Poly1305 needs the full ciphertext for auth.
 */
async function collectBytes(
  iterable: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    checkAbort(signal);
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Parse the plaintext batch_id locator prefix from a root manifest IPFS blob.
 *
 * This is intentionally a pure parser: it performs no crypto and does not
 * validate that the remaining bytes decrypt successfully.
 */
export function getBatchIdFromManifestBlob(blob: Uint8Array): Uint8Array {
  if (blob.length < VAULT_BATCH_ID_SIZE) {
    throw new ValidationError(
      `Root manifest blob too short: expected at least ${VAULT_BATCH_ID_SIZE} bytes, got ${blob.length}`,
    );
  }

  return blob.slice(0, VAULT_BATCH_ID_SIZE);
}

/**
 * Decrypt a Vault manifest AEAD record using the manifest key and batch_id AAD.
 */
async function decryptManifestRecord(
  record: Uint8Array,
  manifestKey: SymmetricKey,
  batchId: Uint8Array,
  manifestNodeId: number,
  batchCid: string,
  label: string,
): Promise<Uint8Array> {
  try {
    return await decryptVaultManifestRecord({
      record,
      manifestKey,
      batchId,
      manifestNodeId,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to decrypt ${label}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Fetch and decrypt a single sub-manifest.
 *
 * @param batchCid - Batch root CID
 * @param manifestId - Sub-manifest ID from index (e.g., "m_0")
 * @param manifestKey - Symmetric key for decryption
 * @param ipfsClient - IPFS client for fetching
 * @param signal - Optional abort signal
 * @returns Array of FileInfo from the sub-manifest
 */
async function fetchAndDecryptSubManifest(
  batchCid: string,
  manifestId: string,
  manifestKey: SymmetricKey,
  batchId: Uint8Array,
  manifestNodeId: number,
  ipfsClient: IpfsClient,
  signal?: AbortSignal,
): Promise<FileInfo[]> {
  checkAbort(signal);

  // Fetch sub-manifest bytes
  let encryptedBytes: Uint8Array;
  try {
    encryptedBytes = await collectBytes(
      ipfsClient.cat(batchCid, `/${manifestId}`),
      signal,
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to fetch sub-manifest ${manifestId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Decrypt as a pure Vault AEAD record. Sub-manifests use sequential
  // manifest_node_id values starting at 1.
  let decryptedBytes: Uint8Array;
  try {
    decryptedBytes = await decryptManifestRecord(
      encryptedBytes,
      manifestKey,
      batchId,
      manifestNodeId,
      batchCid,
      `sub-manifest ${manifestId}`,
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    // Re-throw ManifestError as-is to avoid nested "Manifest error..." prefixes
    if (error instanceof ManifestError) {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to decrypt sub-manifest ${manifestId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Parse sub-manifest
  try {
    const subManifest = decodeSubManifest(unpadManifestPlaintext(decryptedBytes));
    return subManifest.files;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to parse sub-manifest ${manifestId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Retrieve and decrypt a batch manifest from IPFS.
 *
 * @param batchCid - Root CID of the batch
 * @param options - Retrieval options including keys and IPFS client
 * @returns Decrypted BatchManifest with all files and directories
 * @throws ValidationError - Empty batchCid
 * @throws ManifestError - Manifest parsing or decryption failure
 * @throws IpfsFetchError - IPFS retrieval failures (wrapped in ManifestError)
 */
export async function getManifest(
  batchCid: string,
  options: GetManifestOptions,
): Promise<BatchManifest> {
  if (!options || typeof options !== "object") {
    throw new ValidationError("options must be an object");
  }
  const { ipfsClient, manifestKey, signal } = options;

  // 1. Validate inputs
  if (!batchCid || typeof batchCid !== "string" || batchCid.trim() === "") {
    throw new ValidationError("batchCid must be a non-empty string");
  }
  if (!manifestKey) {
    throw new ValidationError("manifestKey is required");
  }
  if (manifestKey.length !== VAULT_AES_256_KEY_SIZE) {
    throw new ValidationError(
      `manifestKey must be ${VAULT_AES_256_KEY_SIZE} bytes, got ${manifestKey.length}`,
    );
  }

  // 2. Check abort signal
  checkAbort(signal);

  // 3. Fetch manifest envelope
  let envelopeBytes: Uint8Array;
  try {
    envelopeBytes = await collectBytes(ipfsClient.cat(batchCid, "/m"), signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to fetch manifest: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // 4. Parse plaintext batch_id locator prefix and root AEAD record
  let batchId: Uint8Array;
  try {
    batchId = getBatchIdFromManifestBlob(envelopeBytes);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to parse manifest batch_id prefix: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const encryptedRootRecord = envelopeBytes.slice(VAULT_BATCH_ID_SIZE);

  // 5. Decrypt root manifest
  const decryptedRootBytes = await decryptManifestRecord(
    encryptedRootRecord,
    manifestKey,
    batchId,
    0,
    batchCid,
    "root manifest",
  );

  // 6. Parse root manifest
  let rootManifest;
  try {
    rootManifest = decodeRootManifest(unpadManifestPlaintext(decryptedRootBytes));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to parse root manifest: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // 7. Check abort signal
  checkAbort(signal);

  // 8. Fetch sub-manifests (if any)
  const allFiles: FileInfo[] = [...rootManifest.files];

  for (let i = 0; i < rootManifest.subManifests.length; i++) {
    const subManifestEntry = rootManifest.subManifests[i]!;
    const subManifestFiles = await fetchAndDecryptSubManifest(
      batchCid,
      subManifestEntry.manifestId,
      manifestKey,
      batchId,
      i + 1,
      ipfsClient,
      signal,
    );
    allFiles.push(...subManifestFiles);
  }

  // 9. Build and return BatchManifest
  return {
    cid: batchCid,
    manifestVersion: rootManifest.manifestVersion,
    directories: rootManifest.directories,
    files: allFiles,
    created: rootManifest.created,
  };
}

/**
 * Manifest retrieval and decryption (Phase 13).
 *
 * Implements getManifest() for fetching and decrypting batch manifests from IPFS.
 */

import {
  decrypt,
  unwrapKeyAuthenticated,
  constantTimeEqual,
  type SymmetricKey,
  type X25519PublicKey,
  type Nonce,
} from '@filemanager/encryptionv2';

import { MANIFEST_DOMAIN, NONCE_SIZE } from './constants.ts';
import { ManifestError, ValidationError } from './errors.ts';
import {
  decodeManifestEnvelope,
  decodeRootManifest,
  decodeSubManifest,
} from './serialization.ts';
import type { IpfsClient } from './ipfs-client.ts';
import type {
  BatchManifest,
  RecipientKeyInfo,
  FileInfo,
  SubManifestIndexEntry,
  GetManifestOptions,
} from './types.ts';

/**
 * Check if abort signal is triggered and throw AbortError if so.
 */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException(
      signal.reason instanceof Error
        ? signal.reason.message
        : String(signal.reason ?? 'Aborted'),
      'AbortError'
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
  signal?: AbortSignal
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
 * Find the recipient record matching the given public key.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @returns The matching RecipientKeyInfo or null if not found
 */
async function findMatchingRecipient(
  recipients: RecipientKeyInfo[],
  recipientPublicKey: X25519PublicKey
): Promise<RecipientKeyInfo | null> {
  for (const recipient of recipients) {
    const isMatch = await constantTimeEqual(
      recipient.recipientPublicKey,
      recipientPublicKey
    );
    if (isMatch) {
      return recipient;
    }
  }
  return null;
}

/**
 * Decrypt encrypted manifest bytes using the manifest key.
 * Handles nonce extraction from combined format: nonce (24 bytes) || ciphertext.
 *
 * @param encryptedManifest - Combined nonce + ciphertext bytes
 * @param manifestKey - Symmetric key for decryption
 * @param domain - Domain context (ROOT or SUB)
 * @param batchCid - Batch CID for error context
 * @returns Decrypted plaintext bytes
 * @throws ManifestError if decryption fails
 */
async function decryptManifestBytes(
  encryptedManifest: Uint8Array,
  manifestKey: SymmetricKey,
  domain: string,
  batchCid: string
): Promise<Uint8Array> {
  if (encryptedManifest.length < NONCE_SIZE) {
    throw new ManifestError(
      batchCid,
      `Encrypted manifest too short: expected at least ${NONCE_SIZE} bytes, got ${encryptedManifest.length}`
    );
  }

  // Cast to Nonce - we've validated the length above
  const nonce = encryptedManifest.slice(0, NONCE_SIZE) as Nonce;
  const ciphertext = encryptedManifest.slice(NONCE_SIZE);
  const context = new TextEncoder().encode(domain);

  try {
    return await decrypt(ciphertext, nonce, manifestKey, context);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to decrypt manifest: ${error instanceof Error ? error.message : String(error)}`
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
  ipfsClient: IpfsClient,
  signal?: AbortSignal
): Promise<FileInfo[]> {
  checkAbort(signal);

  // Fetch sub-manifest bytes
  let encryptedBytes: Uint8Array;
  try {
    encryptedBytes = await collectBytes(
      ipfsClient.cat(batchCid, `/${manifestId}`),
      signal
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to fetch sub-manifest ${manifestId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Decrypt with SUB domain context
  let decryptedBytes: Uint8Array;
  try {
    decryptedBytes = await decryptManifestBytes(
      encryptedBytes,
      manifestKey,
      MANIFEST_DOMAIN.SUB,
      batchCid
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    // Re-throw ManifestError as-is to avoid nested "Manifest error..." prefixes
    if (error instanceof ManifestError) {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to decrypt sub-manifest ${manifestId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Parse sub-manifest
  try {
    const subManifest = decodeSubManifest(decryptedBytes);
    return subManifest.files;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to parse sub-manifest ${manifestId}: ${error instanceof Error ? error.message : String(error)}`
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
 * @throws ManifestError - Manifest parsing, decryption, or recipient mismatch
 * @throws IpfsFetchError - IPFS retrieval failures (wrapped in ManifestError)
 */
export async function getManifest(
  batchCid: string,
  options: GetManifestOptions
): Promise<BatchManifest> {
  const { ipfsClient, recipientKeyPair, expectedSenderPublicKey, signal } =
    options;

  // 1. Validate inputs
  if (!batchCid || typeof batchCid !== 'string' || batchCid.trim() === '') {
    throw new ValidationError('batchCid must be a non-empty string');
  }

  // 2. Check abort signal
  checkAbort(signal);

  // 3. Fetch manifest envelope
  let envelopeBytes: Uint8Array;
  try {
    envelopeBytes = await collectBytes(ipfsClient.cat(batchCid, '/m'), signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to fetch manifest: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 4. Parse envelope
  let envelope;
  try {
    envelope = decodeManifestEnvelope(envelopeBytes);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to parse manifest envelope: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 5. Find matching recipient
  const matchingRecipient = await findMatchingRecipient(
    envelope.recipients,
    recipientKeyPair.publicKey
  );
  if (!matchingRecipient) {
    throw new ManifestError(
      batchCid,
      'No matching recipient found for provided key'
    );
  }

  // 6. Verify sender key matches expected
  const senderMatches = await constantTimeEqual(
    matchingRecipient.senderPublicKey,
    expectedSenderPublicKey
  );
  if (!senderMatches) {
    throw new ManifestError(batchCid, 'Sender public key mismatch');
  }

  // 7. Unwrap manifest key
  let manifestKey: SymmetricKey;
  try {
    manifestKey = await unwrapKeyAuthenticated(
      {
        nonce: matchingRecipient.nonce,
        ciphertext: matchingRecipient.ciphertext,
        senderPublicKey: matchingRecipient.senderPublicKey,
      },
      expectedSenderPublicKey,
      recipientKeyPair
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to unwrap manifest key: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 8. Decrypt root manifest
  const decryptedRootBytes = await decryptManifestBytes(
    envelope.encryptedManifest,
    manifestKey,
    MANIFEST_DOMAIN.ROOT,
    batchCid
  );

  // 9. Parse root manifest
  let rootManifest;
  try {
    rootManifest = decodeRootManifest(decryptedRootBytes);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ManifestError(
      batchCid,
      `Failed to parse root manifest: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 10. Check abort signal
  checkAbort(signal);

  // 11. Fetch sub-manifests (if any)
  const allFiles: FileInfo[] = [...rootManifest.files];

  for (const subManifestEntry of rootManifest.subManifests) {
    const subManifestFiles = await fetchAndDecryptSubManifest(
      batchCid,
      subManifestEntry.manifestId,
      manifestKey,
      ipfsClient,
      signal
    );
    allFiles.push(...subManifestFiles);
  }

  // 12-13. Build and return BatchManifest
  return {
    cid: batchCid,
    manifestKey,
    senderPublicKey: expectedSenderPublicKey,
    directories: rootManifest.directories,
    files: allFiles,
    created: rootManifest.created,
  };
}

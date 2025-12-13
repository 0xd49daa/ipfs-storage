import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import { asContentHash, SIZES } from '@filemanager/encryptionv2';
import type { X25519PublicKey, ContentHash } from '@filemanager/encryptionv2';
import { ValidationError } from './errors.ts';

import {
  ManifestEnvelopeSchema,
  RootManifestSchema,
  SubManifestSchema,
  RecipientKeySchema,
  DirectoryRecordSchema,
  FileRecordSchema,
  FileChunkSchema,
  SubManifestIndexSchema,
  type ManifestEnvelope,
  type RootManifest,
  type SubManifest,
  type RecipientKey,
  type DirectoryRecord,
  type FileRecord,
  type FileChunk,
  type SubManifestIndex,
} from './gen/manifest_pb.ts';

import type {
  ManifestEnvelopeData,
  RootManifestData,
  SubManifestData,
  RecipientKeyInfo,
  DirectoryInfo,
  FileInfo,
  ChunkRef,
  SubManifestIndexEntry,
} from './types.ts';

// ============================================================================
// Local validation helpers
// ============================================================================

/** Expected nonce size for crypto_box (24 bytes) */
const NONCE_SIZE = 24;

/** Expected ciphertext size for wrapped key (32 key + 16 auth tag = 48 bytes) */
const WRAPPED_KEY_CIPHERTEXT_SIZE = 48;

function validateX25519PublicKey(bytes: Uint8Array): X25519PublicKey {
  if (bytes.length !== SIZES.X25519_PUBLIC_KEY) {
    throw new ValidationError(
      `Invalid X25519 public key: expected ${SIZES.X25519_PUBLIC_KEY} bytes, got ${bytes.length}`
    );
  }
  return bytes as X25519PublicKey;
}

function validateNonce(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== NONCE_SIZE) {
    throw new ValidationError(
      `Invalid nonce: expected ${NONCE_SIZE} bytes, got ${bytes.length}`
    );
  }
  return bytes;
}

function validateWrappedKeyCiphertext(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== WRAPPED_KEY_CIPHERTEXT_SIZE) {
    throw new ValidationError(
      `Invalid wrapped key ciphertext: expected ${WRAPPED_KEY_CIPHERTEXT_SIZE} bytes, got ${bytes.length}`
    );
  }
  return bytes;
}

/**
 * Safely convert bigint to number, throwing if precision would be lost.
 */
function bigintToNumber(value: bigint, fieldName: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ValidationError(
      `${fieldName} value ${value} exceeds MAX_SAFE_INTEGER and cannot be safely converted to number`
    );
  }
  if (value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new ValidationError(
      `${fieldName} value ${value} is below MIN_SAFE_INTEGER and cannot be safely converted to number`
    );
  }
  return Number(value);
}

// ============================================================================
// Encoding Functions
// ============================================================================

/**
 * Encode ManifestEnvelopeData to binary protobuf.
 */
export function encodeManifestEnvelope(data: ManifestEnvelopeData): Uint8Array {
  const envelope = create(ManifestEnvelopeSchema, {
    encryptedManifest: data.encryptedManifest,
    recipients: data.recipients.map(recipientKeyInfoToProto),
  });
  return toBinary(ManifestEnvelopeSchema, envelope);
}

/**
 * Encode RootManifestData to binary protobuf.
 */
export function encodeRootManifest(data: RootManifestData): Uint8Array {
  const manifest = create(RootManifestSchema, {
    directories: data.directories.map(directoryInfoToProto),
    files: data.files.map(fileInfoToProto),
    subManifests: data.subManifests.map(subManifestIndexToProto),
    created: BigInt(data.created),
  });
  return toBinary(RootManifestSchema, manifest);
}

/**
 * Encode SubManifestData to binary protobuf.
 */
export function encodeSubManifest(data: SubManifestData): Uint8Array {
  const manifest = create(SubManifestSchema, {
    files: data.files.map(fileInfoToProto),
  });
  return toBinary(SubManifestSchema, manifest);
}

// ============================================================================
// Decoding Functions
// ============================================================================

/**
 * Decode binary protobuf to ManifestEnvelopeData.
 */
export function decodeManifestEnvelope(bytes: Uint8Array): ManifestEnvelopeData {
  const envelope = fromBinary(ManifestEnvelopeSchema, bytes);
  return {
    encryptedManifest: envelope.encryptedManifest,
    recipients: envelope.recipients.map(recipientKeyProtoToInfo),
  };
}

/**
 * Decode binary protobuf to RootManifestData.
 */
export function decodeRootManifest(bytes: Uint8Array): RootManifestData {
  const manifest = fromBinary(RootManifestSchema, bytes);
  return {
    directories: manifest.directories.map(directoryProtoToInfo),
    files: manifest.files.map(fileProtoToInfo),
    subManifests: manifest.subManifests.map(subManifestIndexProtoToEntry),
    created: bigintToNumber(manifest.created, 'created'),
  };
}

/**
 * Decode binary protobuf to SubManifestData.
 */
export function decodeSubManifest(bytes: Uint8Array): SubManifestData {
  const manifest = fromBinary(SubManifestSchema, bytes);
  return {
    files: manifest.files.map(fileProtoToInfo),
  };
}

// ============================================================================
// Internal Converters: TypeScript -> Protobuf
// ============================================================================

function recipientKeyInfoToProto(info: RecipientKeyInfo): RecipientKey {
  // Validate all byte field sizes on encode
  validateX25519PublicKey(info.recipientPublicKey);
  validateNonce(info.nonce);
  validateWrappedKeyCiphertext(info.ciphertext);
  validateX25519PublicKey(info.senderPublicKey);
  return create(RecipientKeySchema, {
    recipientPublicKey: info.recipientPublicKey,
    nonce: info.nonce,
    ciphertext: info.ciphertext,
    senderPublicKey: info.senderPublicKey,
    label: info.label ?? '',
  });
}

function directoryInfoToProto(info: DirectoryInfo): DirectoryRecord {
  return create(DirectoryRecordSchema, {
    path: info.path,
    name: info.name,
    created: BigInt(info.created),
  });
}

function fileInfoToProto(info: FileInfo): FileRecord {
  return create(FileRecordSchema, {
    path: info.path,
    name: info.name,
    size: BigInt(info.size),
    contentHash: info.contentHash,
    chunks: info.chunks.map(chunkRefToProto),
    created: BigInt(info.created),
  });
}

function chunkRefToProto(ref: ChunkRef): FileChunk {
  return create(FileChunkSchema, {
    chunkId: ref.chunkId,
    cid: ref.cid,
    offset: ref.offset,
    length: ref.length,
    encryption: ref.encryption,
    encryptedLength: ref.encryptedLength,
  });
}

function subManifestIndexToProto(entry: SubManifestIndexEntry): SubManifestIndex {
  return create(SubManifestIndexSchema, {
    manifestId: entry.manifestId,
    startPath: entry.startPath,
    endPath: entry.endPath,
    fileCount: entry.fileCount,
  });
}

// ============================================================================
// Internal Converters: Protobuf -> TypeScript
// ============================================================================

function recipientKeyProtoToInfo(proto: RecipientKey): RecipientKeyInfo {
  return {
    recipientPublicKey: validateX25519PublicKey(proto.recipientPublicKey),
    nonce: validateNonce(proto.nonce),
    ciphertext: validateWrappedKeyCiphertext(proto.ciphertext),
    senderPublicKey: validateX25519PublicKey(proto.senderPublicKey),
    label: proto.label || undefined,
  };
}

function directoryProtoToInfo(proto: DirectoryRecord): DirectoryInfo {
  return {
    path: proto.path,
    name: proto.name,
    created: bigintToNumber(proto.created, 'directory.created'),
  };
}

function fileProtoToInfo(proto: FileRecord): FileInfo {
  return {
    path: proto.path,
    name: proto.name,
    size: bigintToNumber(proto.size, 'file.size'),
    contentHash: asContentHash(proto.contentHash),
    chunks: proto.chunks.map(chunkProtoToRef),
    created: bigintToNumber(proto.created, 'file.created'),
  };
}

function chunkProtoToRef(proto: FileChunk): ChunkRef {
  return {
    chunkId: proto.chunkId,
    cid: proto.cid,
    offset: proto.offset,
    length: proto.length,
    encryption: proto.encryption,
    encryptedLength: proto.encryptedLength,
  };
}

function subManifestIndexProtoToEntry(proto: SubManifestIndex): SubManifestIndexEntry {
  return {
    manifestId: proto.manifestId,
    startPath: proto.startPath,
    endPath: proto.endPath,
    fileCount: proto.fileCount,
  };
}

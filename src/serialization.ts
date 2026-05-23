import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { asContentHash } from "./crypto-primitives.ts";
import { ValidationError } from "./errors.ts";
import { MANIFEST_VERSION_SUPPORTED } from "./constants.ts";

import {
  type DirectoryRecord,
  DirectoryRecordSchema,
  type FileChunk,
  FileChunkSchema,
  type FileRecord,
  FileRecordSchema,
  type RootManifest,
  RootManifestSchema,
  type SubManifest,
  type SubManifestIndex,
  SubManifestIndexSchema,
  SubManifestSchema,
} from "./gen/manifest_pb.ts";

import type {
  ChunkRef,
  DirectoryInfo,
  FileInfo,
  RootManifestData,
  SubManifestData,
  SubManifestIndexEntry,
} from "./types.ts";

/**
 * Safely convert bigint to number, throwing if precision would be lost.
 */
function bigintToNumber(value: bigint, fieldName: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ValidationError(
      `${fieldName} value ${value} exceeds MAX_SAFE_INTEGER and cannot be safely converted to number`,
    );
  }
  if (value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new ValidationError(
      `${fieldName} value ${value} is below MIN_SAFE_INTEGER and cannot be safely converted to number`,
    );
  }
  return Number(value);
}

// ============================================================================
// Encoding Functions
// ============================================================================

/**
 * Encode RootManifestData to binary protobuf.
 */
export function encodeRootManifest(data: RootManifestData): Uint8Array {
  validateManifestVersion(data.manifestVersion);
  const manifest = create(RootManifestSchema, {
    directories: data.directories.map(directoryInfoToProto),
    files: data.files.map(fileInfoToProto),
    subManifests: data.subManifests.map(subManifestIndexToProto),
    created: BigInt(data.created),
    manifestVersion: data.manifestVersion,
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
 * Decode binary protobuf to RootManifestData.
 */
export function decodeRootManifest(bytes: Uint8Array): RootManifestData {
  const manifest = fromBinary(RootManifestSchema, bytes);
  validateManifestVersion(manifest.manifestVersion);
  return {
    manifestVersion: manifest.manifestVersion,
    directories: manifest.directories.map(directoryProtoToInfo),
    files: manifest.files.map(fileProtoToInfo),
    subManifests: manifest.subManifests.map(subManifestIndexProtoToEntry),
    created: bigintToNumber(manifest.created, "created"),
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

function validateManifestVersion(version: number): void {
  if (version !== MANIFEST_VERSION_SUPPORTED) {
    throw new ValidationError(
      `Unsupported manifest version ${version}; supported version is ${MANIFEST_VERSION_SUPPORTED}`,
    );
  }
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

function subManifestIndexToProto(
  entry: SubManifestIndexEntry,
): SubManifestIndex {
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

function directoryProtoToInfo(proto: DirectoryRecord): DirectoryInfo {
  return {
    path: proto.path,
    name: proto.name,
    created: bigintToNumber(proto.created, "directory.created"),
  };
}

function fileProtoToInfo(proto: FileRecord): FileInfo {
  return {
    path: proto.path,
    name: proto.name,
    size: bigintToNumber(proto.size, "file.size"),
    contentHash: asContentHash(proto.contentHash),
    chunks: proto.chunks.map(chunkProtoToRef),
    created: bigintToNumber(proto.created, "file.created"),
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

function subManifestIndexProtoToEntry(
  proto: SubManifestIndex,
): SubManifestIndexEntry {
  return {
    manifestId: proto.manifestId,
    startPath: proto.startPath,
    endPath: proto.endPath,
    fileCount: proto.fileCount,
  };
}

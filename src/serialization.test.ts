import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  decodeRootManifest,
  decodeSubManifest,
  encodeRootManifest,
  encodeSubManifest,
} from "./serialization.ts";
import { RootManifestSchema } from "./gen/manifest_pb.ts";
import { MANIFEST_VERSION_SUPPORTED } from "./constants.ts";
import {
  ChunkEncryption,
  type FileInfo,
  type RootManifestData,
  type SubManifestData,
} from "./types.ts";
import { type ContentHash, hashContent } from "./crypto-primitives.ts";

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

// Helper to create a content hash
async function mockContentHash(): Promise<ContentHash> {
  return hashContent(randomBytes(32));
}

describe("Phase 1: Serialization", () => {
  describe("RootManifest", () => {
    test("round-trip with directories and files", async () => {
      const contentHash = await mockContentHash();

      const original: RootManifestData = {
        manifestVersion: MANIFEST_VERSION_SUPPORTED,
        directories: [
          { path: "/photos", name: "photos", created: 1700000000000 },
          { path: "/photos/2024", name: "2024", created: 1700000000000 },
        ],
        files: [
          {
            path: "/photos/2024/img.jpg",
            name: "img.jpg",
            size: 1024 * 1024, // 1MB
            contentHash,
            chunks: [
              {
                chunkId: "6Bv7HnWcL4mT9Rp2QsXx3a",
                cid:
                  "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
                offset: 0,
                length: 1024 * 1024,
                encryption: ChunkEncryption.SINGLE_SHOT,
                encryptedLength: 1024 * 1024 + 30,
              },
            ],
            created: 1700000000000,
          },
        ],
        subManifests: [],
        created: 1700000000000,
      };

      const encoded = encodeRootManifest(original);
      const decoded = decodeRootManifest(encoded);

      expect(decoded.directories.length).toBe(2);
      expect(decoded.directories[0]!.path).toBe("/photos");
      expect(decoded.directories[1]!.path).toBe("/photos/2024");

      expect(decoded.files.length).toBe(1);
      expect(decoded.files[0]!.path).toBe("/photos/2024/img.jpg");
      expect(decoded.files[0]!.size).toBe(1024 * 1024);
      expect(decoded.files[0]!.contentHash).toEqual(contentHash);
      expect(decoded.files[0]!.chunks[0]!.encryptedLength).toBe(
        1024 * 1024 + 30,
      );
      expect(decoded.files[0]!.chunks.length).toBe(1);
      expect(decoded.files[0]!.chunks[0]!.chunkId).toBe(
        "6Bv7HnWcL4mT9Rp2QsXx3a",
      );
      expect(decoded.files[0]!.chunks[0]!.encryption).toBe(
        ChunkEncryption.SINGLE_SHOT,
      );

      expect(decoded.created).toBe(1700000000000);
    });

    test("round-trip with sub-manifests", async () => {
      const original: RootManifestData = {
        manifestVersion: MANIFEST_VERSION_SUPPORTED,
        directories: [],
        files: [],
        subManifests: [
          {
            manifestId: "m_0",
            startPath: "/a/file1.txt",
            endPath: "/m/file999.txt",
            fileCount: 500,
          },
          {
            manifestId: "m_1",
            startPath: "/n/file1000.txt",
            endPath: "/z/file2000.txt",
            fileCount: 500,
          },
        ],
        created: 1700000000000,
      };

      const encoded = encodeRootManifest(original);
      const decoded = decodeRootManifest(encoded);

      expect(decoded.subManifests.length).toBe(2);
      expect(decoded.subManifests[0]!.manifestId).toBe("m_0");
      expect(decoded.subManifests[0]!.fileCount).toBe(500);
      expect(decoded.subManifests[1]!.manifestId).toBe("m_1");
    });

    test("handles empty arrays", async () => {
      const original: RootManifestData = {
        manifestVersion: MANIFEST_VERSION_SUPPORTED,
        directories: [],
        files: [],
        subManifests: [],
        created: 1700000000000,
      };

      const encoded = encodeRootManifest(original);
      const decoded = decodeRootManifest(encoded);

      expect(decoded.directories).toEqual([]);
      expect(decoded.files).toEqual([]);
      expect(decoded.subManifests).toEqual([]);
    });

    test("handles file spanning multiple chunks", async () => {
      const contentHash = await mockContentHash();

      const original: RootManifestData = {
        manifestVersion: MANIFEST_VERSION_SUPPORTED,
        directories: [],
        files: [
          {
            path: "/large-file.bin",
            name: "large-file.bin",
            size: 25 * 1024 * 1024, // 25 MiB
            contentHash,
            chunks: [
              {
                chunkId: "chunk1chunk1chunk1chun",
                cid: "cid1",
                offset: 0,
                length: 16 * 1024 * 1024,
                encryption: ChunkEncryption.SINGLE_SHOT,
                encryptedLength: 16 * 1024 * 1024 + 30,
              },
              {
                chunkId: "chunk2chunk2chunk2chun",
                cid: "cid2",
                offset: 0,
                length: 9 * 1024 * 1024,
                encryption: ChunkEncryption.SINGLE_SHOT,
                encryptedLength: 9 * 1024 * 1024 + 30,
              },
              {
                chunkId: "chunk3chunk3chunk3chun",
                cid: "cid3",
                offset: 0,
                length: 5 * 1024 * 1024,
                encryption: ChunkEncryption.SINGLE_SHOT,
                encryptedLength: 5 * 1024 * 1024 + 30,
              },
            ],
            created: 1700000000000,
          },
        ],
        subManifests: [],
        created: 1700000000000,
      };

      const encoded = encodeRootManifest(original);
      const decoded = decodeRootManifest(encoded);

      expect(decoded.files[0]!.chunks.length).toBe(3);
    });

    test("handles STREAMING encryption enum", async () => {
      const contentHash = await mockContentHash();

      const original: RootManifestData = {
        manifestVersion: MANIFEST_VERSION_SUPPORTED,
        directories: [],
        files: [
          {
            path: "/file.bin",
            name: "file.bin",
            size: 100,
            contentHash,
            chunks: [
              {
                chunkId: "streamchunkstreamchunk",
                cid: "cidstream",
                offset: 0,
                length: 100,
                encryption: ChunkEncryption.STREAMING,
                encryptedLength: 130,
              },
            ],
            created: 1700000000000,
          },
        ],
        subManifests: [],
        created: 1700000000000,
      };

      const encoded = encodeRootManifest(original);
      const decoded = decodeRootManifest(encoded);

      expect(decoded.files[0]!.chunks[0]!.encryption).toBe(
        ChunkEncryption.STREAMING,
      );
    });

    test("handles large timestamps", () => {
      const futureTimestamp = 4102444800000; // Year 2100

      const original: RootManifestData = {
        manifestVersion: MANIFEST_VERSION_SUPPORTED,
        directories: [
          { path: "/test", name: "test", created: futureTimestamp },
        ],
        files: [],
        subManifests: [],
        created: futureTimestamp,
      };

      const encoded = encodeRootManifest(original);
      const decoded = decodeRootManifest(encoded);

      expect(decoded.created).toBe(futureTimestamp);
      expect(decoded.directories[0]!.created).toBe(futureTimestamp);
    });
  });

  describe("SubManifest", () => {
    test("round-trip with multiple files", async () => {
      const files: FileInfo[] = [];

      for (let i = 0; i < 100; i++) {
        const contentHash = await mockContentHash();
        files.push({
          path: `/dir/file_${i.toString().padStart(3, "0")}.txt`,
          name: `file_${i.toString().padStart(3, "0")}.txt`,
          size: 1000 + i,
          contentHash,
          chunks: [
            {
              chunkId: `chunk${i.toString().padStart(17, "0")}`,
              cid: `cid${i}`,
              offset: 0,
              length: 1000 + i,
              encryption: ChunkEncryption.SINGLE_SHOT,
              encryptedLength: 1000 + i + 30,
            },
          ],
          created: 1700000000000 + i,
        });
      }

      const original: SubManifestData = { files };

      const encoded = encodeSubManifest(original);
      const decoded = decodeSubManifest(encoded);

      expect(decoded.files.length).toBe(100);
      expect(decoded.files[50]!.path).toBe("/dir/file_050.txt");
      expect(decoded.files[50]!.size).toBe(1050);
    });
  });

  describe("empty file handling", () => {
    test("handles empty file (size 0, no chunks)", async () => {
      const contentHash = await hashContent(new Uint8Array(0));

      const original: RootManifestData = {
        manifestVersion: MANIFEST_VERSION_SUPPORTED,
        directories: [],
        files: [
          {
            path: "/empty.txt",
            name: "empty.txt",
            size: 0,
            contentHash,
            chunks: [],
            created: 1700000000000,
          },
        ],
        subManifests: [],
        created: 1700000000000,
      };

      const encoded = encodeRootManifest(original);
      const decoded = decodeRootManifest(encoded);

      expect(decoded.files[0]!.size).toBe(0);
      expect(decoded.files[0]!.chunks).toEqual([]);
    });
  });

  describe("serialization efficiency", () => {
    test("large file count serializes efficiently", async () => {
      const contentHash = await mockContentHash();
      const files: FileInfo[] = [];

      for (let i = 0; i < 1000; i++) {
        files.push({
          path: `/file_${i}.txt`,
          name: `file_${i}.txt`,
          size: 100,
          contentHash,
          chunks: [
            {
              chunkId: `id${i.toString().padStart(18, "0")}`,
              cid:
                "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
              offset: 0,
              length: 100,
              encryption: ChunkEncryption.SINGLE_SHOT,
              encryptedLength: 130,
            },
          ],
          created: 1700000000000,
        });
      }

      const original: SubManifestData = { files };

      const start = performance.now();
      const encoded = encodeSubManifest(original);
      const encodeTime = performance.now() - start;

      const decodeStart = performance.now();
      const decoded = decodeSubManifest(encoded);
      const decodeTime = performance.now() - decodeStart;

      expect(decoded.files.length).toBe(1000);
      // Encoding and decoding should be reasonably fast (< 100ms for 1000 files)
      expect(encodeTime).toBeLessThan(100);
      expect(decodeTime).toBeLessThan(100);
    });
  });

  describe("validation", () => {
    test("throws on unsupported manifest version in encode", () => {
      expect(() =>
        encodeRootManifest({
          manifestVersion: MANIFEST_VERSION_SUPPORTED + 1,
          directories: [],
          files: [],
          subManifests: [],
          created: 1700000000000,
        })
      ).toThrow(/Unsupported manifest version/);
    });

    test("throws on unsupported manifest version in decode", () => {
      const unsupported = create(RootManifestSchema, {
        manifestVersion: MANIFEST_VERSION_SUPPORTED + 1,
        directories: [],
        files: [],
        subManifests: [],
        created: 1700000000000n,
      });
      const encoded = toBinary(RootManifestSchema, unsupported);

      expect(() => decodeRootManifest(encoded)).toThrow(
        /Unsupported manifest version/,
      );
    });
  });
});

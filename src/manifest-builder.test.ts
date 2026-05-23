import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  buildAndEncryptManifest,
  buildManifest,
  encryptManifest,
  sortFilesByPath,
} from "./manifest-builder.ts";
import { decodeRootManifest, decodeSubManifest } from "./serialization.ts";
import { unpadManifestPlaintext } from "./manifest-padding.ts";
import { padme } from "./padme.ts";
import { ChunkEncryption } from "./types.ts";
import type { DirectoryInfo, FileInfo } from "./types.ts";
import { SUB_MANIFEST_SIZE } from "./constants.ts";
import { ValidationError } from "./errors.ts";
import { decryptVaultManifestRecord } from "./vault-aead.ts";
import {
  asContentHash,
  generateKey,
  hashBlake2b,
  preloadSodium,
  randomBytes,
} from "@0xd49daa/safecrypt";
import type { ContentHash, SymmetricKey } from "@0xd49daa/safecrypt";

const batchId = new Uint8Array(16).fill(7);

// Helper to create a content hash
async function mockContentHash(): Promise<ContentHash> {
  const data = await randomBytes(32);
  return asContentHash(await hashBlake2b(data, 32));
}

// Helper to create a FileInfo for testing
async function makeFileInfo(
  path: string,
  size = 1000,
  chunkCount = 1,
): Promise<FileInfo> {
  const contentHash = await mockContentHash();
  const chunks = [];
  for (let i = 0; i < chunkCount; i++) {
    chunks.push({
      chunkId: `chunk${i.toString().padStart(17, "0")}`,
      cid: `bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi`,
      offset: 0,
      length: Math.floor(size / chunkCount),
      encryption: ChunkEncryption.SINGLE_SHOT,
      encryptedLength: Math.floor(size / chunkCount) + 40,
    });
  }
  const name = path.split("/").pop() || path;
  return {
    path,
    name,
    size,
    contentHash,
    chunks,
    created: 1700000000000,
  };
}

// Helper to create a DirectoryInfo
function makeDirectoryInfo(path: string): DirectoryInfo {
  const name = path.split("/").pop() || path;
  return {
    path,
    name,
    created: 1700000000000,
  };
}

function rootRecordFromBlob(blob: Uint8Array): Uint8Array {
  expect(blob.slice(0, batchId.length)).toEqual(batchId);
  return blob.slice(batchId.length);
}

// Helper to decrypt Vault manifest AEAD records.
async function decryptManifestBytes(
  record: Uint8Array,
  key: SymmetricKey,
  manifestNodeId: number,
): Promise<Uint8Array> {
  const padded = await decryptPaddedManifestBytes(record, key, manifestNodeId);
  return unpadManifestPlaintext(padded);
}

async function decryptPaddedManifestBytes(
  record: Uint8Array,
  key: SymmetricKey,
  manifestNodeId: number,
): Promise<Uint8Array> {
  return decryptVaultManifestRecord({
    record,
    manifestKey: key,
    batchId,
    manifestNodeId,
  });
}

describe("Phase 9: Manifest Construction & Encryption", () => {
  beforeAll(async () => {
    await preloadSodium();
  });

  describe("sortFilesByPath()", () => {
    test("sorts by byte-wise comparison", async () => {
      const files = [
        await makeFileInfo("/z.txt"),
        await makeFileInfo("/a.txt"),
        await makeFileInfo("/A.txt"), // uppercase comes before lowercase in byte order
      ];
      const sorted = sortFilesByPath(files);
      expect(sorted.map((f) => f.path)).toEqual(["/A.txt", "/a.txt", "/z.txt"]);
    });

    test("handles paths with special characters", async () => {
      const files = [
        await makeFileInfo("/a_1.txt"),
        await makeFileInfo("/a-1.txt"),
        await makeFileInfo("/a1.txt"),
      ];
      const sorted = sortFilesByPath(files);
      // Byte order: '-' (45) < '1' (49) < '_' (95)
      expect(sorted.map((f) => f.path)).toEqual([
        "/a-1.txt",
        "/a1.txt",
        "/a_1.txt",
      ]);
    });

    test("returns empty array for empty input", () => {
      expect(sortFilesByPath([])).toEqual([]);
    });

    test("single file returns unchanged", async () => {
      const files = [await makeFileInfo("/test.txt")];
      const sorted = sortFilesByPath(files);
      expect(sorted.map((f) => f.path)).toEqual(["/test.txt"]);
    });

    test("deterministic: same input produces same output", async () => {
      const files = [
        await makeFileInfo("/b.txt"),
        await makeFileInfo("/a.txt"),
        await makeFileInfo("/c.txt"),
      ];
      const sorted1 = sortFilesByPath(files);
      const sorted2 = sortFilesByPath(files);
      expect(sorted1.map((f) => f.path)).toEqual(sorted2.map((f) => f.path));
    });

    test("nested paths sort correctly", async () => {
      const files = [
        await makeFileInfo("/z/file.txt"),
        await makeFileInfo("/a/file.txt"),
        await makeFileInfo("/a/b/file.txt"),
      ];
      const sorted = sortFilesByPath(files);
      expect(sorted.map((f) => f.path)).toEqual([
        "/a/b/file.txt",
        "/a/file.txt",
        "/z/file.txt",
      ]);
    });

    test("does not mutate original array", async () => {
      const files = [
        await makeFileInfo("/b.txt"),
        await makeFileInfo("/a.txt"),
      ];
      const original = [...files];
      sortFilesByPath(files);
      expect(files.map((f) => f.path)).toEqual(original.map((f) => f.path));
    });

    test("sorts by UTF-8 bytes, not UTF-16 code units", async () => {
      // Test with characters outside BMP (surrogate pairs in UTF-16)
      // U+1F600 (😀) = F0 9F 98 80 in UTF-8
      // U+00E9 (é) = C3 A9 in UTF-8
      // UTF-8 byte order: é (C3 A9) comes before 😀 (F0 9F 98 80)
      const files = [
        await makeFileInfo("/😀.txt"), // F0 9F 98 80
        await makeFileInfo("/é.txt"), // C3 A9
      ];
      const sorted = sortFilesByPath(files);
      // é (0xC3 0xA9) < 😀 (0xF0 0x9F...)
      expect(sorted.map((f) => f.path)).toEqual(["/é.txt", "/😀.txt"]);
    });

    test("handles multi-byte UTF-8 sequences correctly", async () => {
      // Various Unicode characters with different UTF-8 byte lengths
      const files = [
        await makeFileInfo("/日本語.txt"), // CJK characters (3 bytes each in UTF-8)
        await makeFileInfo("/abc.txt"), // ASCII (1 byte each)
        await makeFileInfo("/Ω.txt"), // Greek omega (2 bytes in UTF-8: CE A9)
      ];
      const sorted = sortFilesByPath(files);
      // ASCII 'a' (0x61) < Greek Ω (0xCE 0xA9) < CJK 日 (0xE6 0x97...)
      expect(sorted.map((f) => f.path)).toEqual([
        "/abc.txt",
        "/Ω.txt",
        "/日本語.txt",
      ]);
    });
  });

  describe("buildManifest()", () => {
    test("small batch: no splitting", async () => {
      const files = [
        await makeFileInfo("/file1.txt"),
        await makeFileInfo("/file2.txt"),
      ];
      const result = buildManifest({
        files,
        directories: [makeDirectoryInfo("/photos")],
        created: 1700000000000,
      });

      expect(result.subManifests).toHaveLength(0);
      expect(result.subManifestIndex).toHaveLength(0);

      // Verify root manifest contains files
      const decoded = decodeRootManifest(result.rootManifest);
      expect(decoded.files).toHaveLength(2);
      expect(decoded.subManifests).toHaveLength(0);
      expect(decoded.created).toBe(1700000000000);
    });

    test("directories only: valid manifest", () => {
      const result = buildManifest({
        files: [],
        directories: [makeDirectoryInfo("/photos"), makeDirectoryInfo("/docs")],
        created: 1700000000000,
      });

      const decoded = decodeRootManifest(result.rootManifest);
      expect(decoded.files).toHaveLength(0);
      expect(decoded.directories).toHaveLength(2);
      expect(decoded.subManifests).toHaveLength(0);
    });

    test("files sorted by path in result", async () => {
      const files = [
        await makeFileInfo("/z/file.txt"),
        await makeFileInfo("/a/file.txt"),
        await makeFileInfo("/m/file.txt"),
      ];

      const result = buildManifest({
        files,
        directories: [],
        created: 1700000000000,
      });

      const decoded = decodeRootManifest(result.rootManifest);
      expect(decoded.files.map((f) => f.path)).toEqual([
        "/a/file.txt",
        "/m/file.txt",
        "/z/file.txt",
      ]);
    });

    test("large batch: triggers splitting", async () => {
      // Create enough files to exceed a small threshold when serialized
      // Each FileInfo with chunk is roughly 150-200 bytes serialized
      const files: FileInfo[] = [];
      for (let i = 0; i < 100; i++) {
        files.push(
          await makeFileInfo(`/dir/file_${i.toString().padStart(3, "0")}.txt`),
        );
      }

      const result = buildManifest({
        files,
        directories: [],
        created: 1700000000000,
        options: { maxSubManifestSize: 2 * 1024 }, // 2KB for testing - forces splitting
      });

      expect(result.subManifests.length).toBeGreaterThan(1);
      expect(result.subManifestIndex.length).toBe(result.subManifests.length);

      // Root manifest should have no files, only index
      const decoded = decodeRootManifest(result.rootManifest);
      expect(decoded.files).toHaveLength(0);
      expect(decoded.subManifests.length).toBeGreaterThan(0);

      // Directories should still be in root (never split)
      expect(decoded.directories).toHaveLength(0); // We didn't provide any
    });

    test("directories stay in root manifest when splitting", async () => {
      const files: FileInfo[] = [];
      for (let i = 0; i < 50; i++) {
        files.push(await makeFileInfo(`/photos/file_${i}.txt`));
      }

      const result = buildManifest({
        files,
        directories: [makeDirectoryInfo("/photos"), makeDirectoryInfo("/docs")],
        created: 1700000000000,
        options: { maxSubManifestSize: 2 * 1024 }, // Force splitting
      });

      const decoded = decodeRootManifest(result.rootManifest);
      // Directories must be in root, not split
      expect(decoded.directories).toHaveLength(2);
      expect(decoded.files).toHaveLength(0); // Files are in sub-manifests
    });

    test("sub-manifest index has correct path ranges", async () => {
      const files: FileInfo[] = [];
      for (let i = 0; i < 100; i++) {
        files.push(
          await makeFileInfo(`/file_${i.toString().padStart(3, "0")}.txt`),
        );
      }

      const result = buildManifest({
        files,
        directories: [],
        created: 1700000000000,
        options: { maxSubManifestSize: 2 * 1024 }, // Very small to force many splits
      });

      // Each sub-manifest index should have valid start/end paths
      for (let i = 0; i < result.subManifestIndex.length; i++) {
        const entry = result.subManifestIndex[i]!;
        expect(entry.manifestId).toBe(`m_${i}`);
        expect(entry.fileCount).toBeGreaterThan(0);
        // Start path should be <= end path (byte-wise)
        expect(entry.startPath <= entry.endPath).toBe(true);
      }

      // Verify consecutive ranges don't overlap
      for (let i = 1; i < result.subManifestIndex.length; i++) {
        const prev = result.subManifestIndex[i - 1]!;
        const curr = result.subManifestIndex[i]!;
        // Previous end should be < current start (sorted, no overlap)
        expect(prev.endPath < curr.startPath).toBe(true);
      }
    });

    test("sub-manifests contain only files, correctly distributed", async () => {
      const files: FileInfo[] = [];
      for (let i = 0; i < 50; i++) {
        files.push(
          await makeFileInfo(`/file_${i.toString().padStart(3, "0")}.txt`),
        );
      }

      const result = buildManifest({
        files,
        directories: [],
        created: 1700000000000,
        options: { maxSubManifestSize: 3 * 1024 },
      });

      // Count total files across all sub-manifests
      let totalFiles = 0;
      for (const subManifestBytes of result.subManifests) {
        const sub = decodeSubManifest(subManifestBytes);
        totalFiles += sub.files.length;
        // Verify each file has expected structure
        for (const file of sub.files) {
          expect(file.path).toMatch(/^\/file_\d{3}\.txt$/);
        }
      }

      expect(totalFiles).toBe(50);
    });

    test("single file never splits", async () => {
      const result = buildManifest({
        files: [await makeFileInfo("/single.txt")],
        directories: [],
        created: 1700000000000,
        options: { maxSubManifestSize: 10 }, // Very small
      });

      // Even with tiny maxSize, single file stays in root
      const decoded = decodeRootManifest(result.rootManifest);
      expect(decoded.files).toHaveLength(1);
      expect(result.subManifests).toHaveLength(0);
    });

    test("empty files array produces valid manifest", () => {
      const result = buildManifest({
        files: [],
        directories: [makeDirectoryInfo("/empty")],
        created: 1700000000000,
      });

      const decoded = decodeRootManifest(result.rootManifest);
      expect(decoded.files).toHaveLength(0);
      expect(decoded.directories).toHaveLength(1);
    });

    test("determinism: same input produces same output", async () => {
      const files = [
        await makeFileInfo("/b.txt"),
        await makeFileInfo("/a.txt"),
      ];
      const directories = [makeDirectoryInfo("/test")];
      const created = 1700000000000;

      const result1 = buildManifest({ files, directories, created });
      const result2 = buildManifest({ files, directories, created });

      expect(result1.rootManifest).toEqual(result2.rootManifest);
    });

    test("uses SUB_MANIFEST_SIZE as default", async () => {
      // Create files that would fit in 1MB but not split
      const files = [
        await makeFileInfo("/file1.txt"),
        await makeFileInfo("/file2.txt"),
      ];

      const result = buildManifest({
        files,
        directories: [],
        created: 1700000000000,
        // No options - should use SUB_MANIFEST_SIZE default
      });

      // Small files should not split with 1MB default
      expect(result.subManifests).toHaveLength(0);
    });

    test("throws ValidationError for zero maxSubManifestSize", async () => {
      expect(() =>
        buildManifest({
          files: [],
          directories: [],
          created: 1700000000000,
          options: { maxSubManifestSize: 0 },
        })
      ).toThrow(ValidationError);

      expect(() =>
        buildManifest({
          files: [],
          directories: [],
          created: 1700000000000,
          options: { maxSubManifestSize: 0 },
        })
      ).toThrow("maxSubManifestSize must be positive");
    });

    test("throws ValidationError for negative maxSubManifestSize", async () => {
      expect(() =>
        buildManifest({
          files: [],
          directories: [],
          created: 1700000000000,
          options: { maxSubManifestSize: -100 },
        })
      ).toThrow(ValidationError);

      expect(() =>
        buildManifest({
          files: [],
          directories: [],
          created: 1700000000000,
          options: { maxSubManifestSize: -100 },
        })
      ).toThrow("maxSubManifestSize must be positive, got -100");
    });
  });

  describe("encryptManifest()", () => {
    test("round-trip: encrypt then decrypt", async () => {
      const manifestKey = await generateKey();
      const files = [await makeFileInfo("/test.txt")];
      const manifest = buildManifest({
        files,
        directories: [],
        created: 1700000000000,
      });

      const result = await encryptManifest({
        manifest,
        manifestKey,
        batchId,
      });

      const decrypted = await decryptManifestBytes(
        rootRecordFromBlob(result.envelope),
        manifestKey,
        0,
      );

      const decoded = decodeRootManifest(decrypted);
      expect(result.manifestKey).toEqual(manifestKey);
      expect(decoded.files).toHaveLength(1);
      expect(decoded.files[0]!.path).toBe("/test.txt");
    });

    test("PADME-pads root manifest plaintext before encryption", async () => {
      const manifestKey = await generateKey();
      const manifest = buildManifest({
        files: [await makeFileInfo("/padding-root.txt")],
        directories: [],
        created: 1700000000000,
      });

      const result = await encryptManifest({ manifest, manifestKey, batchId });
      const padded = await decryptPaddedManifestBytes(
        rootRecordFromBlob(result.envelope),
        manifestKey,
        0,
      );

      expect(padded.length).toBe(padme(4 + manifest.rootManifest.length));
      expect(unpadManifestPlaintext(padded)).toEqual(manifest.rootManifest);
    });

    test("sub-manifests encrypted with sequential manifest node ids", async () => {
      const manifestKey = await generateKey();

      // Create large manifest that splits
      const files: FileInfo[] = [];
      for (let i = 0; i < 100; i++) {
        files.push(await makeFileInfo(`/file${i}.txt`));
      }

      const manifest = buildManifest({
        files,
        directories: [],
        created: 1700000000000,
        options: { maxSubManifestSize: 2 * 1024 },
      });

      const result = await encryptManifest({
        manifest,
        manifestKey,
        batchId,
      });

      expect(result.encryptedSubManifests.length).toBeGreaterThan(0);

      // Each sub-manifest should decrypt correctly with manifest_node_id >= 1
      for (let i = 0; i < result.encryptedSubManifests.length; i++) {
        const decrypted = await decryptManifestBytes(
          result.encryptedSubManifests[i]!,
          result.manifestKey,
          i + 1,
        );
        const decoded = decodeSubManifest(decrypted);
        expect(decoded.files.length).toBeGreaterThan(0);
      }

      // Verify root manifest decrypts with manifest_node_id = 0
      const rootDecrypted = await decryptManifestBytes(
        rootRecordFromBlob(result.envelope),
        result.manifestKey,
        0,
      );
      const root = decodeRootManifest(rootDecrypted);
      expect(root.subManifests.length).toBe(
        result.encryptedSubManifests.length,
      );
    });

    test("PADME-pads sub-manifest plaintext before encryption", async () => {
      const manifestKey = await generateKey();
      const files: FileInfo[] = [];
      for (let i = 0; i < 60; i++) {
        files.push(await makeFileInfo(`/padding-sub-${i}.txt`));
      }
      const manifest = buildManifest({
        files,
        directories: [],
        created: 1700000000000,
        options: { maxSubManifestSize: 2 * 1024 },
      });

      const result = await encryptManifest({ manifest, manifestKey, batchId });
      expect(result.encryptedSubManifests.length).toBeGreaterThan(0);

      for (let i = 0; i < result.encryptedSubManifests.length; i++) {
        const padded = await decryptPaddedManifestBytes(
          result.encryptedSubManifests[i]!,
          manifestKey,
          i + 1,
        );
        expect(padded.length).toBe(padme(4 + manifest.subManifests[i]!.length));
        expect(unpadManifestPlaintext(padded)).toEqual(manifest.subManifests[i]);
      }
    });

    test("uses provided manifest key", async () => {
      const providedKey = await generateKey();

      const manifest = buildManifest({
        files: [await makeFileInfo("/test.txt")],
        directories: [],
        created: 1700000000000,
      });

      const result = await encryptManifest({
        manifest,
        manifestKey: providedKey,
        batchId,
      });

      expect(result.manifestKey).toEqual(providedKey);

      // Verify we can decrypt with the provided key
      const decrypted = await decryptManifestBytes(
        rootRecordFromBlob(result.envelope),
        providedKey,
        0,
      );
      const decoded = decodeRootManifest(decrypted);
      expect(decoded.files).toHaveLength(1);
    });
  });

  describe("buildAndEncryptManifest()", () => {
    test("combines build and encrypt", async () => {
      const manifestKey = await generateKey();

      const files = [
        await makeFileInfo("/photos/img1.jpg"),
        await makeFileInfo("/photos/img2.jpg"),
        await makeFileInfo("/docs/readme.txt"),
      ];

      const directories = [
        makeDirectoryInfo("/photos"),
        makeDirectoryInfo("/docs"),
      ];

      const result = await buildAndEncryptManifest({
        files,
        directories,
        created: 1700000000000,
        manifestKey,
        batchId,
      });

      // Decrypt and verify
      const decrypted = await decryptManifestBytes(
        rootRecordFromBlob(result.envelope),
        manifestKey,
        0,
      );

      const decoded = decodeRootManifest(decrypted);

      // Verify content
      expect(decoded.created).toBe(1700000000000);
      expect(decoded.directories).toHaveLength(2);
      expect(decoded.files).toHaveLength(3);

      // Files should be sorted
      expect(decoded.files.map((f) => f.path)).toEqual([
        "/docs/readme.txt",
        "/photos/img1.jpg",
        "/photos/img2.jpg",
      ]);
    });

    test("passes options to buildManifest", async () => {
      const manifestKey = await generateKey();

      const files: FileInfo[] = [];
      for (let i = 0; i < 50; i++) {
        files.push(await makeFileInfo(`/file${i}.txt`));
      }

      const result = await buildAndEncryptManifest({
        files,
        directories: [],
        created: 1700000000000,
        manifestKey,
        batchId,
        options: { maxSubManifestSize: 2 * 1024 }, // Force splitting
      });

      // Should have sub-manifests due to small maxSize
      expect(result.encryptedSubManifests.length).toBeGreaterThan(0);
    });
  });

  describe("integration: large manifest with splitting round-trips correctly", () => {
    test("full round-trip with sub-manifests", async () => {
      const manifestKey = await generateKey();

      // Create many files to force splitting
      const files: FileInfo[] = [];
      for (let i = 0; i < 100; i++) {
        files.push(
          await makeFileInfo(`/dir${Math.floor(i / 10)}/file${i}.txt`),
        );
      }

      const directories = [
        makeDirectoryInfo("/dir0"),
        makeDirectoryInfo("/dir1"),
        makeDirectoryInfo("/dir2"),
      ];

      const result = await buildAndEncryptManifest({
        files,
        directories,
        created: 1700000000000,
        manifestKey,
        batchId,
        options: { maxSubManifestSize: 3 * 1024 },
      });

      // Verify we got sub-manifests
      expect(result.encryptedSubManifests.length).toBeGreaterThan(0);

      // Decrypt root manifest
      const rootDecrypted = await decryptManifestBytes(
        rootRecordFromBlob(result.envelope),
        manifestKey,
        0,
      );
      const root = decodeRootManifest(rootDecrypted);

      // Root should have directories but no files
      expect(root.directories).toHaveLength(3);
      expect(root.files).toHaveLength(0);
      expect(root.subManifests.length).toBe(
        result.encryptedSubManifests.length,
      );

      // Decrypt all sub-manifests and count files
      let totalFiles = 0;
      for (let i = 0; i < result.encryptedSubManifests.length; i++) {
        const decSub = await decryptManifestBytes(
          result.encryptedSubManifests[i]!,
          manifestKey,
          i + 1,
        );
        const sub = decodeSubManifest(decSub);
        totalFiles += sub.files.length;
      }

      expect(totalFiles).toBe(100);
    });
  });

  describe("edge cases", () => {
    test("unicode paths sort correctly (byte-wise)", async () => {
      const files = [
        await makeFileInfo("/\u00e9.txt"), // e-acute
        await makeFileInfo("/e.txt"),
        await makeFileInfo("/\u00c9.txt"), // E-acute
      ];

      const result = buildManifest({
        files,
        directories: [],
        created: 1700000000000,
      });

      const decoded = decodeRootManifest(result.rootManifest);
      const paths = decoded.files.map((f) => f.path);

      // Verify byte-wise ordering
      for (let i = 1; i < paths.length; i++) {
        expect(paths[i - 1]! < paths[i]!).toBe(true);
      }
    });

    test("files with many chunks work correctly", async () => {
      const file = await makeFileInfo("/large-file.bin", 100 * 1024 * 1024, 10); // 100MB, 10 chunks

      const result = buildManifest({
        files: [file],
        directories: [],
        created: 1700000000000,
      });

      const decoded = decodeRootManifest(result.rootManifest);
      expect(decoded.files[0]!.chunks).toHaveLength(10);
    });

    test("empty file (size 0, no chunks) works correctly", async () => {
      const emptyFile: FileInfo = {
        path: "/empty.txt",
        name: "empty.txt",
        size: 0,
        contentHash: await mockContentHash(),
        chunks: [],
        created: 1700000000000,
      };

      const result = buildManifest({
        files: [emptyFile],
        directories: [],
        created: 1700000000000,
      });

      const decoded = decodeRootManifest(result.rootManifest);
      expect(decoded.files[0]!.size).toBe(0);
      expect(decoded.files[0]!.chunks).toHaveLength(0);
    });

    test("manifest with only empty directories", () => {
      const result = buildManifest({
        files: [],
        directories: [
          makeDirectoryInfo("/empty1"),
          makeDirectoryInfo("/empty2"),
          makeDirectoryInfo("/empty1/nested"),
        ],
        created: 1700000000000,
      });

      const decoded = decodeRootManifest(result.rootManifest);
      expect(decoded.files).toHaveLength(0);
      expect(decoded.directories).toHaveLength(3);
      expect(decoded.subManifests).toHaveLength(0);
    });

    test("very long paths work correctly", async () => {
      const longPath = "/" + "a".repeat(200) + "/file.txt";
      const file = await makeFileInfo(longPath);

      const result = buildManifest({
        files: [file],
        directories: [],
        created: 1700000000000,
      });

      const decoded = decodeRootManifest(result.rootManifest);
      expect(decoded.files[0]!.path).toBe(longPath);
    });
  });
});

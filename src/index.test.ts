import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  ChunkUnavailableError,
  CidMismatchError,
  IntegrityError,
  IpfsStorageError,
  ManifestError,
  ValidationError,
} from "./index.ts";
import { CHUNK_SIZE } from "./constants.ts";
import { asBatchCid, asChunkId, asFilePath } from "./branded.ts";
import { hashContent } from "./crypto-primitives.ts";

describe("Phase 0: Foundation", () => {
  describe("constants", () => {
    test("CHUNK_SIZE is 16 MiB", () => {
      expect(CHUNK_SIZE).toBe(16 * 1024 * 1024);
    });
  });

  describe("branded types", () => {
    test("asChunkId validates 22 character strings", () => {
      const validId = "6Bv7HnWcL4mT9Rp2QsXx3a";
      expect(validId.length).toBe(22);
      expect(() => asChunkId(validId)).not.toThrow();
      // Branded type is still the same string value
      expect(asChunkId(validId) as string).toBe(validId);
    });

    test("asChunkId rejects invalid length", () => {
      expect(() => asChunkId("short")).toThrow(/expected 22 characters/);
      expect(() => asChunkId("toolongstringthatexceeds22chars")).toThrow(
        /expected 22 characters/,
      );
    });

    test("asBatchCid rejects empty strings", () => {
      expect(() => asBatchCid("")).toThrow(/cannot be empty/);
    });

    test("asBatchCid accepts valid CID", () => {
      const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
      expect(() => asBatchCid(cid)).not.toThrow();
    });

    test("asFilePath requires leading slash", () => {
      expect(() => asFilePath("photos/img.jpg")).toThrow(/must start with/);
      expect(() => asFilePath("/photos/img.jpg")).not.toThrow();
    });

    test("asFilePath rejects double slashes", () => {
      expect(() => asFilePath("/photos//img.jpg")).toThrow(/double slashes/);
    });
  });

  describe("error hierarchy", () => {
    test("all errors extend IpfsStorageError", () => {
      expect(new ValidationError("test")).toBeInstanceOf(IpfsStorageError);
      expect(new ManifestError("cid", "test")).toBeInstanceOf(IpfsStorageError);
      expect(new ChunkUnavailableError("cid", "chunk")).toBeInstanceOf(
        IpfsStorageError,
      );
      expect(new CidMismatchError("a", "b")).toBeInstanceOf(IpfsStorageError);
    });

    test("all errors extend Error", () => {
      expect(new IpfsStorageError("test")).toBeInstanceOf(Error);
      expect(new ValidationError("test")).toBeInstanceOf(Error);
    });

    test("IntegrityError contains path and hashes", async () => {
      const expected = await hashContent(new Uint8Array([1]));
      const actual = await hashContent(new Uint8Array([2]));
      const err = new IntegrityError("/test.txt", expected, actual);

      expect(err.path).toBe("/test.txt");
      expect(err.expected).toBe(expected);
      expect(err.actual).toBe(actual);
      expect(err.message).toContain("/test.txt");
    });

    test("ManifestError contains batchCid", () => {
      const err = new ManifestError("bafytest", "decrypt failed");
      expect(err.batchCid).toBe("bafytest");
      expect(err.message).toContain("bafytest");
      expect(err.message).toContain("decrypt failed");
    });

    test("ChunkUnavailableError contains batchCid and chunkId", () => {
      const err = new ChunkUnavailableError("bafytest", "chunk123");
      expect(err.batchCid).toBe("bafytest");
      expect(err.chunkId).toBe("chunk123");
    });

    test("CidMismatchError contains expected and actual", () => {
      const err = new CidMismatchError("expected-cid", "actual-cid");
      expect(err.expected).toBe("expected-cid");
      expect(err.actual).toBe("actual-cid");
    });
  });
});

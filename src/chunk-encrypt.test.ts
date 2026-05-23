import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { computeEncryptedLength } from "./chunk-encrypt.ts";
import { ChunkEncryption } from "./gen/manifest_pb.ts";

const KB = 1024;
const MB = 1024 * 1024;

describe("Chunk Encryption Length Utilities", () => {
  describe("computeEncryptedLength()", () => {
    test("SINGLE_SHOT: returns length + 40", () => {
      expect(computeEncryptedLength(0, ChunkEncryption.SINGLE_SHOT)).toBe(40);
      expect(computeEncryptedLength(100, ChunkEncryption.SINGLE_SHOT)).toBe(
        140,
      );
      expect(computeEncryptedLength(1000, ChunkEncryption.SINGLE_SHOT)).toBe(
        1040,
      );
      expect(computeEncryptedLength(10 * MB, ChunkEncryption.SINGLE_SHOT)).toBe(
        10 * MB + 40,
      );
    });

    test("STREAMING: returns correct formula result", () => {
      // Formula: plaintextLength + 24 + ceil(plaintextLength / 64KB) * 17

      // 1 byte = 1 chunk
      expect(computeEncryptedLength(1, ChunkEncryption.STREAMING)).toBe(
        1 + 24 + 17,
      );

      // Exactly 64KB = 1 chunk
      expect(computeEncryptedLength(64 * KB, ChunkEncryption.STREAMING)).toBe(
        64 * KB + 24 + 17,
      );

      // 64KB + 1 byte = 2 chunks
      expect(computeEncryptedLength(64 * KB + 1, ChunkEncryption.STREAMING))
        .toBe(
          64 * KB + 1 + 24 + 2 * 17,
        );

      // 128KB = 2 chunks
      expect(computeEncryptedLength(128 * KB, ChunkEncryption.STREAMING)).toBe(
        128 * KB + 24 + 2 * 17,
      );

      // 10MB = ceil(10MB / 64KB) = 160 chunks
      const tenMB = 10 * MB;
      const numChunks = Math.ceil(tenMB / (64 * KB));
      expect(computeEncryptedLength(tenMB, ChunkEncryption.STREAMING)).toBe(
        tenMB + 24 + numChunks * 17,
      );
    });

    test("edge case: 0 length", () => {
      // 0 bytes = 0 chunks for streaming
      expect(computeEncryptedLength(0, ChunkEncryption.STREAMING)).toBe(
        0 + 24 + 0,
      );
    });

    test("edge case: exact chunk boundary", () => {
      // Exactly N * 64KB should be N chunks
      expect(computeEncryptedLength(64 * KB * 3, ChunkEncryption.STREAMING))
        .toBe(
          64 * KB * 3 + 24 + 3 * 17,
        );
    });
  });
});

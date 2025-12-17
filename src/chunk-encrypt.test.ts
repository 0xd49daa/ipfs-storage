import { describe, test, expect, beforeAll } from 'bun:test';
import {
  preloadSodium,
  generateKey,
  encrypt,
  createEncryptStream,
} from '@0xd49daa/safecrypt';
import type { SymmetricKey } from '@0xd49daa/safecrypt';
import {
  computeEncryptedLength,
  decryptSingleShot,
  decryptStreaming,
} from './chunk-encrypt.ts';
import { ChunkEncryption } from './gen/manifest_pb.ts';
import {
  NONCE_SIZE,
  SINGLE_SHOT_OVERHEAD,
  STREAM_HEADER_SIZE,
  STREAM_CHUNK_OVERHEAD,
  STREAM_CHUNK_SIZE,
} from './constants.ts';

const KB = 1024;
const MB = 1024 * 1024;

beforeAll(async () => {
  await preloadSodium();
});

describe('Chunk Decryption Utilities', () => {
  describe('computeEncryptedLength()', () => {
    test('SINGLE_SHOT: returns length + 40', () => {
      expect(computeEncryptedLength(0, ChunkEncryption.SINGLE_SHOT)).toBe(40);
      expect(computeEncryptedLength(100, ChunkEncryption.SINGLE_SHOT)).toBe(140);
      expect(computeEncryptedLength(1000, ChunkEncryption.SINGLE_SHOT)).toBe(1040);
      expect(computeEncryptedLength(10 * MB, ChunkEncryption.SINGLE_SHOT)).toBe(
        10 * MB + 40
      );
    });

    test('STREAMING: returns correct formula result', () => {
      // Formula: plaintextLength + 24 + ceil(plaintextLength / 64KB) * 17

      // 1 byte = 1 chunk
      expect(computeEncryptedLength(1, ChunkEncryption.STREAMING)).toBe(1 + 24 + 17);

      // Exactly 64KB = 1 chunk
      expect(computeEncryptedLength(64 * KB, ChunkEncryption.STREAMING)).toBe(
        64 * KB + 24 + 17
      );

      // 64KB + 1 byte = 2 chunks
      expect(computeEncryptedLength(64 * KB + 1, ChunkEncryption.STREAMING)).toBe(
        64 * KB + 1 + 24 + 2 * 17
      );

      // 128KB = 2 chunks
      expect(computeEncryptedLength(128 * KB, ChunkEncryption.STREAMING)).toBe(
        128 * KB + 24 + 2 * 17
      );

      // 10MB = ceil(10MB / 64KB) = 160 chunks
      const tenMB = 10 * MB;
      const numChunks = Math.ceil(tenMB / (64 * KB));
      expect(computeEncryptedLength(tenMB, ChunkEncryption.STREAMING)).toBe(
        tenMB + 24 + numChunks * 17
      );
    });

    test('edge case: 0 length', () => {
      // 0 bytes = 0 chunks for streaming
      expect(computeEncryptedLength(0, ChunkEncryption.STREAMING)).toBe(0 + 24 + 0);
    });

    test('edge case: exact chunk boundary', () => {
      // Exactly N * 64KB should be N chunks
      expect(computeEncryptedLength(64 * KB * 3, ChunkEncryption.STREAMING)).toBe(
        64 * KB * 3 + 24 + 3 * 17
      );
    });
  });

  describe('decryptSingleShot()', () => {
    test('round-trip: encrypt → decrypt → verify', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array(256);
      for (let i = 0; i < 256; i++) plaintext[i] = i;

      // Encrypt using wire format: [nonce][ciphertext]
      const { nonce, ciphertext } = await encrypt(plaintext, key);
      const encrypted = new Uint8Array(NONCE_SIZE + ciphertext.length);
      encrypted.set(nonce, 0);
      encrypted.set(ciphertext, NONCE_SIZE);

      // Decrypt
      const decrypted = await decryptSingleShot(encrypted, key);

      expect(decrypted).toEqual(plaintext);
    });

    test('decrypts empty plaintext', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array(0);

      const { nonce, ciphertext } = await encrypt(plaintext, key);
      const encrypted = new Uint8Array(NONCE_SIZE + ciphertext.length);
      encrypted.set(nonce, 0);
      encrypted.set(ciphertext, NONCE_SIZE);

      const decrypted = await decryptSingleShot(encrypted, key);

      expect(decrypted).toEqual(plaintext);
    });

    test('decrypts 10MB plaintext', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array(10 * MB);
      for (let i = 0; i < plaintext.length; i++) plaintext[i] = i % 256;

      const { nonce, ciphertext } = await encrypt(plaintext, key);
      const encrypted = new Uint8Array(NONCE_SIZE + ciphertext.length);
      encrypted.set(nonce, 0);
      encrypted.set(ciphertext, NONCE_SIZE);

      const decrypted = await decryptSingleShot(encrypted, key);

      expect(decrypted).toEqual(plaintext);
    });
  });

  describe('decryptStreaming()', () => {
    // Helper to encrypt using streaming mode
    async function encryptStreaming(plaintext: Uint8Array, key: SymmetricKey): Promise<Uint8Array> {
      const stream = await createEncryptStream(key);
      try {
        const numChunks = Math.ceil(plaintext.length / STREAM_CHUNK_SIZE);
        const outputSize = STREAM_HEADER_SIZE + plaintext.length + numChunks * STREAM_CHUNK_OVERHEAD;
        const result = new Uint8Array(outputSize);
        let writeOffset = 0;

        // Write header
        result.set(stream.header, 0);
        writeOffset = STREAM_HEADER_SIZE;

        // Process in chunks
        let readOffset = 0;
        while (readOffset < plaintext.length) {
          const remaining = plaintext.length - readOffset;
          const chunkLen = Math.min(STREAM_CHUNK_SIZE, remaining);
          const isFinal = readOffset + chunkLen >= plaintext.length;

          const chunk = plaintext.subarray(readOffset, readOffset + chunkLen);
          const encrypted = stream.push(chunk, isFinal);

          result.set(encrypted, writeOffset);
          writeOffset += encrypted.length;
          readOffset += chunkLen;
        }

        return result.subarray(0, writeOffset);
      } finally {
        stream.dispose();
      }
    }

    test('round-trip: encrypt → decrypt → verify', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array(100 * KB);
      for (let i = 0; i < plaintext.length; i++) plaintext[i] = i % 256;

      const encrypted = await encryptStreaming(plaintext, key);
      const decrypted = await decryptStreaming(encrypted, key);

      expect(decrypted).toEqual(plaintext);
    });

    test('decrypts exact 64KB (1 chunk)', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array(64 * KB);
      for (let i = 0; i < plaintext.length; i++) plaintext[i] = i % 256;

      const encrypted = await encryptStreaming(plaintext, key);
      const decrypted = await decryptStreaming(encrypted, key);

      expect(decrypted).toEqual(plaintext);
    });

    test('decrypts 128KB (2 chunks)', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array(128 * KB);
      for (let i = 0; i < plaintext.length; i++) plaintext[i] = i % 256;

      const encrypted = await encryptStreaming(plaintext, key);
      const decrypted = await decryptStreaming(encrypted, key);

      expect(decrypted).toEqual(plaintext);
    });

    test('decrypts small plaintext (< 64KB)', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array(1000);
      for (let i = 0; i < plaintext.length; i++) plaintext[i] = i % 256;

      const encrypted = await encryptStreaming(plaintext, key);
      const decrypted = await decryptStreaming(encrypted, key);

      expect(decrypted).toEqual(plaintext);
    });

    test('decrypts 1 byte plaintext', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array([42]);

      const encrypted = await encryptStreaming(plaintext, key);
      const decrypted = await decryptStreaming(encrypted, key);

      expect(decrypted).toEqual(plaintext);
    });
  });
});

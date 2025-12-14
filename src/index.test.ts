import { describe, test, expect } from 'bun:test';
import {
  IpfsStorageError,
  ValidationError,
  IntegrityError,
  ManifestError,
  ChunkUnavailableError,
  SegmentUploadError,
  CidMismatchError,
} from './index.ts';
import { DOMAIN, CHUNK_SIZE } from './constants.ts';
import { deriveFileKey } from './crypto.ts';
import { asChunkId, asBatchCid, asFilePath } from './branded.ts';
import {
  generateKey,
  hashBlake2b,
  preloadSodium,
  asContentHash,
} from '@filemanager/encryptionv2';

describe('Phase 0: Foundation', () => {
  describe('constants', () => {
    test('DOMAIN.FILE_KEY is correct', () => {
      expect(DOMAIN.FILE_KEY).toBe('ipfs-storage:file-key:v1');
    });

    test('DOMAIN.FILE_KEY encodes to 24 bytes UTF-8', () => {
      const encoded = new TextEncoder().encode(DOMAIN.FILE_KEY);
      expect(encoded.length).toBe(24);
    });

    test('CHUNK_SIZE is 10MB', () => {
      expect(CHUNK_SIZE).toBe(10 * 1024 * 1024);
    });
  });

  describe('branded types', () => {
    test('asChunkId validates 22 character strings', () => {
      const validId = '6Bv7HnWcL4mT9Rp2QsXx3a';
      expect(validId.length).toBe(22);
      expect(() => asChunkId(validId)).not.toThrow();
      // Branded type is still the same string value
      expect(asChunkId(validId) as string).toBe(validId);
    });

    test('asChunkId rejects invalid length', () => {
      expect(() => asChunkId('short')).toThrow(/expected 22 characters/);
      expect(() => asChunkId('toolongstringthatexceeds22chars')).toThrow(
        /expected 22 characters/
      );
    });

    test('asBatchCid rejects empty strings', () => {
      expect(() => asBatchCid('')).toThrow(/cannot be empty/);
    });

    test('asBatchCid accepts valid CID', () => {
      const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
      expect(() => asBatchCid(cid)).not.toThrow();
    });

    test('asFilePath requires leading slash', () => {
      expect(() => asFilePath('photos/img.jpg')).toThrow(/must start with/);
      expect(() => asFilePath('/photos/img.jpg')).not.toThrow();
    });

    test('asFilePath rejects double slashes', () => {
      expect(() => asFilePath('/photos//img.jpg')).toThrow(/double slashes/);
    });
  });

  describe('error hierarchy', () => {
    test('all errors extend IpfsStorageError', () => {
      expect(new ValidationError('test')).toBeInstanceOf(IpfsStorageError);
      expect(new ManifestError('cid', 'test')).toBeInstanceOf(IpfsStorageError);
      expect(new ChunkUnavailableError('cid', 'chunk')).toBeInstanceOf(
        IpfsStorageError
      );
      expect(new CidMismatchError('a', 'b')).toBeInstanceOf(IpfsStorageError);
    });

    test('all errors extend Error', () => {
      expect(new IpfsStorageError('test')).toBeInstanceOf(Error);
      expect(new ValidationError('test')).toBeInstanceOf(Error);
    });

    test('IntegrityError contains path and hashes', async () => {
      await preloadSodium();
      const expected = asContentHash(await hashBlake2b(new Uint8Array([1]), 32));
      const actual = asContentHash(await hashBlake2b(new Uint8Array([2]), 32));
      const err = new IntegrityError('/test.txt', expected, actual);

      expect(err.path).toBe('/test.txt');
      expect(err.expected).toBe(expected);
      expect(err.actual).toBe(actual);
      expect(err.message).toContain('/test.txt');
    });

    test('ManifestError contains batchCid', () => {
      const err = new ManifestError('bafytest', 'decrypt failed');
      expect(err.batchCid).toBe('bafytest');
      expect(err.message).toContain('bafytest');
      expect(err.message).toContain('decrypt failed');
    });

    test('ChunkUnavailableError contains batchCid and chunkId', () => {
      const err = new ChunkUnavailableError('bafytest', 'chunk123');
      expect(err.batchCid).toBe('bafytest');
      expect(err.chunkId).toBe('chunk123');
    });

    test('SegmentUploadError contains segmentIndex and state', () => {
      const state = {
        batchId: 'batch1',
        segments: [],
        manifestCid: 'bafyreimani',
        rootCid: 'bafybeiroot',
        manifestKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      };
      const err = new SegmentUploadError(2, state);
      expect(err.segmentIndex).toBe(2);
      expect(err.state).toBe(state);
    });

    test('CidMismatchError contains expected and actual', () => {
      const err = new CidMismatchError('expected-cid', 'actual-cid');
      expect(err.expected).toBe('expected-cid');
      expect(err.actual).toBe('actual-cid');
    });
  });

  describe('deriveFileKey', () => {
    test('produces deterministic output for same inputs', async () => {
      await preloadSodium();

      const manifestKey = await generateKey();
      const contentHash = asContentHash(
        await hashBlake2b(new Uint8Array([1, 2, 3]), 32)
      );

      const key1 = await deriveFileKey(manifestKey, contentHash);
      const key2 = await deriveFileKey(manifestKey, contentHash);

      expect(key1).toEqual(key2);
    });

    test('produces different output for different content hashes', async () => {
      await preloadSodium();

      const manifestKey = await generateKey();
      const hash1 = asContentHash(
        await hashBlake2b(new Uint8Array([1, 2, 3]), 32)
      );
      const hash2 = asContentHash(
        await hashBlake2b(new Uint8Array([4, 5, 6]), 32)
      );

      const key1 = await deriveFileKey(manifestKey, hash1);
      const key2 = await deriveFileKey(manifestKey, hash2);

      expect(key1).not.toEqual(key2);
    });

    test('produces different output for different manifest keys', async () => {
      await preloadSodium();

      const manifestKey1 = await generateKey();
      const manifestKey2 = await generateKey();
      const contentHash = asContentHash(
        await hashBlake2b(new Uint8Array([1, 2, 3]), 32)
      );

      const key1 = await deriveFileKey(manifestKey1, contentHash);
      const key2 = await deriveFileKey(manifestKey2, contentHash);

      expect(key1).not.toEqual(key2);
    });

    test('produces 32-byte key', async () => {
      await preloadSodium();

      const manifestKey = await generateKey();
      const contentHash = asContentHash(
        await hashBlake2b(new Uint8Array([1, 2, 3]), 32)
      );

      const fileKey = await deriveFileKey(manifestKey, contentHash);

      expect(fileKey.length).toBe(32);
    });
  });
});

import { describe, test, expect, beforeAll } from 'bun:test';
import { preloadSodium } from '@0xd49daa/safecrypt';
import { generateChunkId, chunkIdToPath } from './chunk-id.ts';
import {
  dirname,
  basename,
  extname,
  isValidPath,
  normalizePath,
} from './path-utils.ts';
import { asChunkId, asFilePath } from './branded.ts';

const BASE58_REGEX = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

beforeAll(async () => {
  await preloadSodium();
});

describe('Phase 3: Chunk ID Generation & Path Utilities', () => {
  describe('generateChunkId()', () => {
    test('returns exactly 22 characters', async () => {
      const id = await generateChunkId();
      expect(id.length).toBe(22);
    });

    test('contains only valid base58 characters', async () => {
      const id = await generateChunkId();
      expect(BASE58_REGEX.test(id)).toBe(true);
    });

    test('produces unique IDs on repeated calls', async () => {
      const ids = await Promise.all([
        generateChunkId(),
        generateChunkId(),
        generateChunkId(),
        generateChunkId(),
        generateChunkId(),
      ]);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(5);
    });

    test('passes asChunkId validation', async () => {
      const id = await generateChunkId();
      expect(() => asChunkId(id)).not.toThrow();
    });
  });

  describe('chunkIdToPath()', () => {
    test('correctly splits ID into hierarchy', () => {
      const id = asChunkId('6Bv7HnWcL4mT9Rp2QsXx3a');
      const path = chunkIdToPath(id);
      expect(path).toBe('6B/v7/6Bv7HnWcL4mT9Rp2QsXx3a');
    });

    test('format matches {2}/{2}/{22}', () => {
      const id = asChunkId('ABCDEFGHJKLMNPQRSTUVWx');
      const path = chunkIdToPath(id);
      const parts = path.split('/');
      expect(parts.length).toBe(3);
      expect(parts[0]!.length).toBe(2);
      expect(parts[1]!.length).toBe(2);
      expect(parts[2]!.length).toBe(22);
    });

    test('works with IDs starting with numbers', () => {
      const id = asChunkId('123456789ABCDEFGHJKLMN');
      const path = chunkIdToPath(id);
      expect(path).toBe('12/34/123456789ABCDEFGHJKLMN');
    });

    test('works with IDs starting with letters', () => {
      const id = asChunkId('ABCDEFGHJKLMNPQRSTUVWx');
      const path = chunkIdToPath(id);
      expect(path).toBe('AB/CD/ABCDEFGHJKLMNPQRSTUVWx');
    });
  });

  describe('dirname()', () => {
    test('extracts parent directory', () => {
      const path = asFilePath('/foo/bar/baz.txt');
      expect(dirname(path)).toBe(asFilePath('/foo/bar'));
    });

    test('handles file directly under root', () => {
      const path = asFilePath('/file.txt');
      expect(dirname(path)).toBe(asFilePath('/'));
    });

    test('handles root path', () => {
      const path = asFilePath('/');
      expect(dirname(path)).toBe(asFilePath('/'));
    });

    test('handles deeply nested path', () => {
      const path = asFilePath('/a/b/c/d/e/file.txt');
      expect(dirname(path)).toBe(asFilePath('/a/b/c/d/e'));
    });
  });

  describe('basename()', () => {
    test('extracts filename', () => {
      const path = asFilePath('/foo/bar/baz.txt');
      expect(basename(path)).toBe('baz.txt');
    });

    test('handles file directly under root', () => {
      const path = asFilePath('/file.txt');
      expect(basename(path)).toBe('file.txt');
    });

    test('handles root path (returns empty)', () => {
      const path = asFilePath('/');
      expect(basename(path)).toBe('');
    });

    test('handles file without extension', () => {
      const path = asFilePath('/dir/README');
      expect(basename(path)).toBe('README');
    });
  });

  describe('extname()', () => {
    test('extracts extension', () => {
      const path = asFilePath('/foo/bar/baz.txt');
      expect(extname(path)).toBe('.txt');
    });

    test('returns empty for no extension', () => {
      const path = asFilePath('/foo/bar/file');
      expect(extname(path)).toBe('');
    });

    test('handles multiple dots (returns last)', () => {
      const path = asFilePath('/dir/file.tar.gz');
      expect(extname(path)).toBe('.gz');
    });

    test('handles dotfiles correctly (no extension)', () => {
      const path = asFilePath('/dir/.hidden');
      expect(extname(path)).toBe('');
    });

    test('handles dotfiles with extension', () => {
      const path = asFilePath('/dir/.hidden.txt');
      expect(extname(path)).toBe('.txt');
    });

    test('handles root path', () => {
      const path = asFilePath('/');
      expect(extname(path)).toBe('');
    });
  });

  describe('isValidPath()', () => {
    test('accepts valid paths', () => {
      expect(isValidPath('/')).toBe(true);
      expect(isValidPath('/file.txt')).toBe(true);
      expect(isValidPath('/dir/file.txt')).toBe(true);
    });

    test('rejects paths not starting with /', () => {
      expect(isValidPath('file.txt')).toBe(false);
      expect(isValidPath('dir/file.txt')).toBe(false);
    });

    test('rejects paths with double slashes', () => {
      expect(isValidPath('//file.txt')).toBe(false);
      expect(isValidPath('/dir//file.txt')).toBe(false);
    });
  });

  describe('normalizePath()', () => {
    test('validates and returns FilePath', () => {
      const path = normalizePath('/foo/bar');
      expect(path).toBe(asFilePath('/foo/bar'));
    });

    test('removes trailing slashes', () => {
      const path = normalizePath('/foo/bar/');
      expect(path).toBe(asFilePath('/foo/bar'));
    });

    test('preserves root path', () => {
      const path = normalizePath('/');
      expect(path).toBe(asFilePath('/'));
    });

    test('throws on invalid path', () => {
      expect(() => normalizePath('not/valid')).toThrow();
    });
  });
});

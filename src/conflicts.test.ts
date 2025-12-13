import { describe, test, expect } from 'bun:test';
import { resolveConflicts } from './conflicts.ts';
import { ValidationError } from './errors.ts';
import type { FileInput } from './types.ts';
import type { ContentHash } from '@filemanager/encryptionv2';

// Helper to create mock FileInput with only path (other fields unused by resolveConflicts)
function mockFileInput(path: string): FileInput {
  return {
    file: new Blob() as unknown as File,
    path,
    contentHash: new Uint8Array(32) as ContentHash,
  };
}

describe('Phase 4: Duplicate Path Resolution', () => {
  describe('resolveConflicts()', () => {
    test('returns unchanged paths when no conflicts', () => {
      const files = [
        mockFileInput('/a.txt'),
        mockFileInput('/b.txt'),
        mockFileInput('/c.txt'),
      ];
      const resolved = resolveConflicts(files);
      expect(resolved).toEqual(['/a.txt', '/b.txt', '/c.txt']);
    });

    test('renames single duplicate with _1 suffix', () => {
      const files = [
        mockFileInput('/photo.jpg'),
        mockFileInput('/photo.jpg'),
      ];
      const resolved = resolveConflicts(files);
      expect(resolved).toEqual(['/photo.jpg', '/photo_1.jpg']);
    });

    test('renames multiple duplicates with incrementing suffixes', () => {
      const files = [
        mockFileInput('/photo.jpg'),
        mockFileInput('/photo.jpg'),
        mockFileInput('/photo.jpg'),
      ];
      const resolved = resolveConflicts(files);
      // Each file gets its own resolved path
      expect(resolved).toEqual(['/photo.jpg', '/photo_1.jpg', '/photo_2.jpg']);
    });

    test('counter skips existing _N suffixes', () => {
      const files = [
        mockFileInput('/photo.jpg'),
        mockFileInput('/photo_1.jpg'),
        mockFileInput('/photo.jpg'), // Should become photo_2.jpg, not photo_1.jpg
      ];
      const resolved = resolveConflicts(files);
      expect(resolved).toEqual(['/photo.jpg', '/photo_1.jpg', '/photo_2.jpg']);
    });

    test('handles files without extension', () => {
      const files = [
        mockFileInput('/README'),
        mockFileInput('/README'),
      ];
      const resolved = resolveConflicts(files);
      expect(resolved).toEqual(['/README', '/README_1']);
    });

    test('handles files with multiple dots correctly', () => {
      const files = [
        mockFileInput('/file.tar.gz'),
        mockFileInput('/file.tar.gz'),
      ];
      const resolved = resolveConflicts(files);
      // extname returns ".gz", so base is "file.tar"
      expect(resolved).toEqual(['/file.tar.gz', '/file.tar_1.gz']);
    });

    test('handles dotfiles correctly', () => {
      const files = [
        mockFileInput('/.gitignore'),
        mockFileInput('/.gitignore'),
      ];
      const resolved = resolveConflicts(files);
      // .gitignore has no extension (dot is first char), so base is ".gitignore"
      expect(resolved).toEqual(['/.gitignore', '/.gitignore_1']);
    });

    test('handles nested paths correctly', () => {
      const files = [
        mockFileInput('/a/b/c.txt'),
        mockFileInput('/a/b/c.txt'),
      ];
      const resolved = resolveConflicts(files);
      expect(resolved).toEqual(['/a/b/c.txt', '/a/b/c_1.txt']);
    });

    test('different directories do not conflict', () => {
      const files = [
        mockFileInput('/a/photo.jpg'),
        mockFileInput('/b/photo.jpg'),
      ];
      const resolved = resolveConflicts(files);
      expect(resolved).toEqual(['/a/photo.jpg', '/b/photo.jpg']);
    });

    test('input order determines result (deterministic)', () => {
      const files1 = [
        mockFileInput('/a.txt'),
        mockFileInput('/a.txt'),
        mockFileInput('/a.txt'),
      ];
      const files2 = [
        mockFileInput('/a.txt'),
        mockFileInput('/a.txt'),
        mockFileInput('/a.txt'),
      ];
      const resolved1 = resolveConflicts(files1);
      const resolved2 = resolveConflicts(files2);

      expect(resolved1).toEqual(resolved2);
      expect(resolved1).toEqual(['/a.txt', '/a_1.txt', '/a_2.txt']);
    });

    test('handles large batch with many duplicates', () => {
      const files = Array.from({ length: 105 }, () => mockFileInput('/file.txt'));
      const resolved = resolveConflicts(files);

      expect(resolved.length).toBe(105);
      expect(resolved[0]).toBe('/file.txt');
      expect(resolved[1]).toBe('/file_1.txt');
      expect(resolved[104]).toBe('/file_104.txt');

      // All paths should be unique
      const unique = new Set(resolved);
      expect(unique.size).toBe(105);
    });

    test('root-level duplicates produce valid paths (no //)', () => {
      const files = [
        mockFileInput('/file.txt'),
        mockFileInput('/file.txt'),
      ];
      const resolved = resolveConflicts(files);
      expect(resolved).toEqual(['/file.txt', '/file_1.txt']);
      expect(resolved[1]).not.toContain('//');
    });

    test('throws ValidationError for path without leading slash', () => {
      const files = [mockFileInput('invalid/path.txt')];
      expect(() => resolveConflicts(files)).toThrow(ValidationError);
    });

    test('throws ValidationError for path with double slashes', () => {
      const files = [mockFileInput('/a//b.txt')];
      expect(() => resolveConflicts(files)).toThrow(ValidationError);
    });

    test('returns array aligned with input', () => {
      const files = [
        mockFileInput('/unique.txt'),
        mockFileInput('/dup.txt'),
        mockFileInput('/another.txt'),
        mockFileInput('/dup.txt'),
      ];
      const resolved = resolveConflicts(files);

      // Verify alignment: resolved[i] corresponds to files[i]
      expect(resolved.length).toBe(files.length);
      expect(resolved[0]).toBe('/unique.txt');   // unchanged
      expect(resolved[1]).toBe('/dup.txt');       // first dup unchanged
      expect(resolved[2]).toBe('/another.txt');   // unchanged
      expect(resolved[3]).toBe('/dup_1.txt');     // second dup renamed
    });
  });
});

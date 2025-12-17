import { describe, test, expect } from 'bun:test';
import { resolveConflicts } from './conflicts.ts';
import { ValidationError } from './errors.ts';

// Helper to create mock path container (only path is used by resolveConflicts)
function mockPathContainer(path: string): { path: string } {
  return { path };
}

describe('Phase 4: Duplicate Path Resolution', () => {
  describe('resolveConflicts()', () => {
    test('returns unchanged paths when no conflicts', () => {
      const files = [
        mockPathContainer('/a.txt'),
        mockPathContainer('/b.txt'),
        mockPathContainer('/c.txt'),
      ];
      const resolved = resolveConflicts(files);
      expect(resolved).toEqual(['/a.txt', '/b.txt', '/c.txt']);
    });

    test('renames single duplicate with _1 suffix', () => {
      const files = [
        mockPathContainer('/photo.jpg'),
        mockPathContainer('/photo.jpg'),
      ];
      const resolved = resolveConflicts(files);
      expect(resolved).toEqual(['/photo.jpg', '/photo_1.jpg']);
    });

    test('renames multiple duplicates with incrementing suffixes', () => {
      const files = [
        mockPathContainer('/photo.jpg'),
        mockPathContainer('/photo.jpg'),
        mockPathContainer('/photo.jpg'),
      ];
      const resolved = resolveConflicts(files);
      // Each file gets its own resolved path
      expect(resolved).toEqual(['/photo.jpg', '/photo_1.jpg', '/photo_2.jpg']);
    });

    test('counter skips existing _N suffixes', () => {
      const files = [
        mockPathContainer('/photo.jpg'),
        mockPathContainer('/photo_1.jpg'),
        mockPathContainer('/photo.jpg'), // Should become photo_2.jpg, not photo_1.jpg
      ];
      const resolved = resolveConflicts(files);
      expect(resolved).toEqual(['/photo.jpg', '/photo_1.jpg', '/photo_2.jpg']);
    });

    test('handles files without extension', () => {
      const files = [
        mockPathContainer('/README'),
        mockPathContainer('/README'),
      ];
      const resolved = resolveConflicts(files);
      expect(resolved).toEqual(['/README', '/README_1']);
    });

    test('handles files with multiple dots correctly', () => {
      const files = [
        mockPathContainer('/file.tar.gz'),
        mockPathContainer('/file.tar.gz'),
      ];
      const resolved = resolveConflicts(files);
      // extname returns ".gz", so base is "file.tar"
      expect(resolved).toEqual(['/file.tar.gz', '/file.tar_1.gz']);
    });

    test('handles dotfiles correctly', () => {
      const files = [
        mockPathContainer('/.gitignore'),
        mockPathContainer('/.gitignore'),
      ];
      const resolved = resolveConflicts(files);
      // .gitignore has no extension (dot is first char), so base is ".gitignore"
      expect(resolved).toEqual(['/.gitignore', '/.gitignore_1']);
    });

    test('handles nested paths correctly', () => {
      const files = [
        mockPathContainer('/a/b/c.txt'),
        mockPathContainer('/a/b/c.txt'),
      ];
      const resolved = resolveConflicts(files);
      expect(resolved).toEqual(['/a/b/c.txt', '/a/b/c_1.txt']);
    });

    test('different directories do not conflict', () => {
      const files = [
        mockPathContainer('/a/photo.jpg'),
        mockPathContainer('/b/photo.jpg'),
      ];
      const resolved = resolveConflicts(files);
      expect(resolved).toEqual(['/a/photo.jpg', '/b/photo.jpg']);
    });

    test('input order determines result (deterministic)', () => {
      const files1 = [
        mockPathContainer('/a.txt'),
        mockPathContainer('/a.txt'),
        mockPathContainer('/a.txt'),
      ];
      const files2 = [
        mockPathContainer('/a.txt'),
        mockPathContainer('/a.txt'),
        mockPathContainer('/a.txt'),
      ];
      const resolved1 = resolveConflicts(files1);
      const resolved2 = resolveConflicts(files2);

      expect(resolved1).toEqual(resolved2);
      expect(resolved1).toEqual(['/a.txt', '/a_1.txt', '/a_2.txt']);
    });

    test('handles large batch with many duplicates', () => {
      const files = Array.from({ length: 105 }, () => mockPathContainer('/file.txt'));
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
        mockPathContainer('/file.txt'),
        mockPathContainer('/file.txt'),
      ];
      const resolved = resolveConflicts(files);
      expect(resolved).toEqual(['/file.txt', '/file_1.txt']);
      expect(resolved[1]).not.toContain('//');
    });

    test('throws ValidationError for path without leading slash', () => {
      const files = [mockPathContainer('invalid/path.txt')];
      expect(() => resolveConflicts(files)).toThrow(ValidationError);
    });

    test('throws ValidationError for path with double slashes', () => {
      const files = [mockPathContainer('/a//b.txt')];
      expect(() => resolveConflicts(files)).toThrow(ValidationError);
    });

    test('returns array aligned with input', () => {
      const files = [
        mockPathContainer('/unique.txt'),
        mockPathContainer('/dup.txt'),
        mockPathContainer('/another.txt'),
        mockPathContainer('/dup.txt'),
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

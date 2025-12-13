import { describe, test, expect } from 'bun:test';
import { buildDirectoryTree, type BuildDirectoryTreeOptions } from './directories.ts';
import type { DirectoryInput } from './types.ts';
import { ValidationError } from './errors.ts';

describe('Phase 5: Directory Inference & Validation', () => {
  describe('buildDirectoryTree()', () => {
    const fixedTimestamp = 1700000000000;
    const opts: BuildDirectoryTreeOptions = { defaultCreated: fixedTimestamp };

    // === Basic Inference ===

    test('infers single directory from file path', () => {
      const dirs = buildDirectoryTree(['/photos/img.jpg'], undefined, opts);
      expect(dirs).toEqual([
        { path: '/photos', name: 'photos', created: fixedTimestamp },
      ]);
    });

    test('infers nested directories from file path', () => {
      const dirs = buildDirectoryTree(
        ['/photos/2024/vacation/img.jpg'],
        undefined,
        opts
      );
      expect(dirs).toEqual([
        { path: '/photos', name: 'photos', created: fixedTimestamp },
        { path: '/photos/2024', name: '2024', created: fixedTimestamp },
        {
          path: '/photos/2024/vacation',
          name: 'vacation',
          created: fixedTimestamp,
        },
      ]);
    });

    test('deduplicates directories from multiple files', () => {
      const dirs = buildDirectoryTree(
        ['/photos/a.jpg', '/photos/b.jpg', '/photos/2024/c.jpg'],
        undefined,
        opts
      );
      expect(dirs).toEqual([
        { path: '/photos', name: 'photos', created: fixedTimestamp },
        { path: '/photos/2024', name: '2024', created: fixedTimestamp },
      ]);
    });

    test('excludes root directory from output', () => {
      const dirs = buildDirectoryTree(['/file.txt'], undefined, opts);
      expect(dirs).toEqual([]);
    });

    test('handles empty file list', () => {
      const dirs = buildDirectoryTree([], undefined, opts);
      expect(dirs).toEqual([]);
    });

    // === Explicit Directories ===

    test('explicit directory overrides inferred timestamp', () => {
      const explicitTimestamp = 1600000000000;
      const dirs = buildDirectoryTree(
        ['/photos/img.jpg'],
        [{ path: '/photos', created: explicitTimestamp }],
        opts
      );
      expect(dirs).toEqual([
        { path: '/photos', name: 'photos', created: explicitTimestamp },
      ]);
    });

    test('explicit directory adds empty directory', () => {
      const dirs = buildDirectoryTree(
        ['/photos/img.jpg'],
        [{ path: '/photos/empty-album' }],
        opts
      );
      expect(dirs).toEqual([
        { path: '/photos', name: 'photos', created: fixedTimestamp },
        {
          path: '/photos/empty-album',
          name: 'empty-album',
          created: fixedTimestamp,
        },
      ]);
    });

    test('explicit directory infers ancestors with defaultCreated', () => {
      const explicitTimestamp = 1600000000000;
      const dirs = buildDirectoryTree(
        [],
        [{ path: '/a/b/c', created: explicitTimestamp }],
        opts
      );
      // Ancestors use defaultCreated, only explicit /a/b/c uses explicit timestamp
      expect(dirs).toEqual([
        { path: '/a', name: 'a', created: fixedTimestamp },
        { path: '/a/b', name: 'b', created: fixedTimestamp },
        { path: '/a/b/c', name: 'c', created: explicitTimestamp },
      ]);
    });

    test('explicit directory without timestamp uses default', () => {
      const dirs = buildDirectoryTree([], [{ path: '/docs' }], opts);
      expect(dirs).toEqual([
        { path: '/docs', name: 'docs', created: fixedTimestamp },
      ]);
    });

    test('explicit directory with trailing slash is normalized', () => {
      const explicitTimestamp = 1600000000000;
      const dirs = buildDirectoryTree(
        [],
        [{ path: '/photos/', created: explicitTimestamp }],
        opts
      );
      expect(dirs).toEqual([
        { path: '/photos', name: 'photos', created: explicitTimestamp },
      ]);
    });

    // === Sorting ===

    test('directories are sorted by path', () => {
      const dirs = buildDirectoryTree(
        ['/z/file.txt', '/a/file.txt', '/m/file.txt'],
        undefined,
        opts
      );
      expect(dirs.map((d) => d.path)).toEqual(['/a', '/m', '/z']);
    });

    // === Validation Errors - explicitDirs ===

    test('throws ValidationError for empty explicit directory path', () => {
      expect(() => buildDirectoryTree([], [{ path: '' }])).toThrow(
        ValidationError
      );
      expect(() => buildDirectoryTree([], [{ path: '' }])).toThrow(
        'Directory path cannot be empty'
      );
    });

    test('throws ValidationError for explicit path without leading slash', () => {
      expect(() => buildDirectoryTree([], [{ path: 'photos/2024' }])).toThrow(
        ValidationError
      );
      expect(() => buildDirectoryTree([], [{ path: 'photos/2024' }])).toThrow(
        'Invalid directory path'
      );
    });

    test('throws ValidationError for explicit path with double slashes', () => {
      expect(() => buildDirectoryTree([], [{ path: '/photos//2024' }])).toThrow(
        ValidationError
      );
    });

    test('throws ValidationError for explicit root "/"', () => {
      expect(() =>
        buildDirectoryTree([], [{ path: '/', created: 1600000000000 }])
      ).toThrow(ValidationError);
      expect(() =>
        buildDirectoryTree([], [{ path: '/', created: 1600000000000 }])
      ).toThrow('Root directory "/" cannot be declared explicitly');
    });

    // === Validation Errors - resolvedPaths ===

    test('throws ValidationError for invalid path in resolvedPaths (no leading slash)', () => {
      expect(() => buildDirectoryTree(['photos/img.jpg'])).toThrow(
        ValidationError
      );
      expect(() => buildDirectoryTree(['photos/img.jpg'])).toThrow(
        'Invalid file path'
      );
    });

    test('throws ValidationError for invalid path in resolvedPaths (double slashes)', () => {
      expect(() => buildDirectoryTree(['/photos//img.jpg'])).toThrow(
        ValidationError
      );
    });

    // === Default Timestamp Behavior ===

    test('uses Date.now() when defaultCreated not provided', () => {
      const before = Date.now();
      const dirs = buildDirectoryTree(['/photos/img.jpg']);
      const after = Date.now();

      expect(dirs.length).toBe(1);
      expect(dirs[0]!.created).toBeGreaterThanOrEqual(before);
      expect(dirs[0]!.created).toBeLessThanOrEqual(after);
    });

    test('pins timestamp once so all directories have same created', () => {
      const dirs = buildDirectoryTree([
        '/a/file.txt',
        '/b/file.txt',
        '/c/file.txt',
      ]);

      // All directories should have the exact same timestamp
      const timestamps = new Set(dirs.map((d) => d.created));
      expect(timestamps.size).toBe(1);
    });

    // === Complex Scenarios ===

    test('handles mix of inferred and explicit directories', () => {
      const dirs = buildDirectoryTree(
        ['/photos/2024/img.jpg', '/docs/readme.txt'],
        [
          { path: '/photos', created: 1500000000000 },
          { path: '/photos/2024/empty', created: 1600000000000 },
        ],
        opts
      );

      expect(dirs).toEqual([
        { path: '/docs', name: 'docs', created: fixedTimestamp },
        { path: '/photos', name: 'photos', created: 1500000000000 },
        { path: '/photos/2024', name: '2024', created: fixedTimestamp },
        {
          path: '/photos/2024/empty',
          name: 'empty',
          created: 1600000000000,
        },
      ]);
    });

    test('explicit directory without files preserves empty directory', () => {
      const dirs = buildDirectoryTree(
        [],
        [{ path: '/empty-folder', created: 1600000000000 }],
        opts
      );
      expect(dirs).toEqual([
        {
          path: '/empty-folder',
          name: 'empty-folder',
          created: 1600000000000,
        },
      ]);
    });

    test('explicit directory without timestamp uses existing inferred timestamp', () => {
      // File creates /photos with defaultTs, then explicit /photos without timestamp
      // should keep the defaultTs (since explicit.created is undefined)
      const dirs = buildDirectoryTree(
        ['/photos/img.jpg'],
        [{ path: '/photos' }], // No timestamp provided
        opts
      );
      expect(dirs).toEqual([
        { path: '/photos', name: 'photos', created: fixedTimestamp },
      ]);
    });
  });
});

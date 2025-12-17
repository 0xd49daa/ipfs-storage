import type { DirectoryInfo, DirectoryInput } from './types.ts';
import { ValidationError } from './errors.ts';
import { type FilePath, unsafe } from './branded.ts';
import { dirname, basename, normalizePath, isValidPath } from './path-utils.ts';

/**
 * Options for buildDirectoryTree.
 */
export interface BuildDirectoryTreeOptions {
  /** Default timestamp for inferred directories. Defaults to Date.now(). */
  defaultCreated?: number;
}

/**
 * Extract all ancestor directory paths from a file path.
 * "/a/b/c/file.txt" → ["/a", "/a/b", "/a/b/c"]
 * Excludes root "/".
 */
function getAncestors(path: FilePath | string): FilePath[] {
  const ancestors: FilePath[] = [];
  let current = dirname(path as FilePath);

  while (current !== '/') {
    ancestors.push(current);
    current = dirname(current);
  }

  // Return in order from root to leaf (reverse)
  return ancestors.reverse();
}

/**
 * Incremental directory tree builder.
 * Adds directories one file at a time.
 *
 * Use this for streaming scenarios where you want to process files
 * one at a time without collecting all paths upfront.
 */
export class DirectoryTreeBuilder {
  private dirMap = new Map<string, { created: number; isExplicit: boolean }>();
  private defaultCreated: number;

  /**
   * Create a new DirectoryTreeBuilder.
   *
   * @param defaultCreated Default timestamp for inferred directories
   * @param explicitDirs Optional explicit directory declarations to pre-populate
   * @throws ValidationError if any explicit directory is invalid
   */
  constructor(defaultCreated: number, explicitDirs?: DirectoryInput[]) {
    this.defaultCreated = defaultCreated;

    // Pre-populate with explicit directories
    if (explicitDirs) {
      for (const dir of explicitDirs) {
        // Validate path
        if (!dir.path || dir.path.length === 0) {
          throw new ValidationError('Directory path cannot be empty');
        }
        if (!isValidPath(dir.path)) {
          throw new ValidationError(
            `Invalid directory path: must start with "/" and not contain "//", got "${dir.path}"`
          );
        }

        // Normalize (remove trailing slashes)
        const normalized = normalizePath(dir.path);

        // Reject root "/" explicitly
        if (normalized === '/') {
          throw new ValidationError(
            'Root directory "/" cannot be declared explicitly'
          );
        }

        // Add the explicit directory
        const existing = this.dirMap.get(normalized);
        const created = dir.created ?? existing?.created ?? defaultCreated;

        this.dirMap.set(normalized, {
          created,
          isExplicit: true,
        });

        // Also add ancestors (inferred) if not present
        const ancestors = getAncestors(normalized);
        for (const ancestor of ancestors) {
          if (!this.dirMap.has(ancestor)) {
            this.dirMap.set(ancestor, { created: defaultCreated, isExplicit: false });
          }
        }
      }
    }
  }

  /**
   * Add a file path, inferring its ancestor directories.
   *
   * @param resolvedPath The resolved file path (already conflict-resolved)
   * @throws ValidationError if path is invalid
   */
  addFilePath(resolvedPath: string): void {
    // Validate input path
    if (!isValidPath(resolvedPath)) {
      throw new ValidationError(
        `Invalid file path: must start with "/" and not contain "//", got "${resolvedPath}"`
      );
    }

    const filePath = unsafe.asFilePath(resolvedPath);
    const ancestors = getAncestors(filePath);

    for (const ancestor of ancestors) {
      if (!this.dirMap.has(ancestor)) {
        this.dirMap.set(ancestor, { created: this.defaultCreated, isExplicit: false });
      }
    }
  }

  /**
   * Build the final sorted DirectoryInfo array.
   *
   * @returns Sorted array of DirectoryInfo (excludes root "/")
   */
  build(): DirectoryInfo[] {
    const directories: DirectoryInfo[] = [];

    for (const [path, info] of this.dirMap) {
      const filePath = unsafe.asFilePath(path);
      directories.push({
        path,
        name: basename(filePath),
        created: info.created,
      });
    }

    // Sort by path (lexicographic)
    directories.sort((a, b) => a.path.localeCompare(b.path));

    return directories;
  }

  /**
   * Get the count of directories tracked.
   */
  get size(): number {
    return this.dirMap.size;
  }
}

/**
 * Build directory tree from resolved file paths and explicit directories.
 *
 * Infers intermediate directories from file paths, merges with explicit
 * directory declarations, and produces a sorted, deduplicated list.
 *
 * @param resolvedPaths - Already-resolved file paths (from resolveConflicts)
 * @param explicitDirs - Optional explicit directory declarations
 * @param options - Optional configuration
 * @returns Sorted array of DirectoryInfo (excludes root "/")
 * @throws ValidationError if paths are invalid or explicit "/" is provided
 */
export function buildDirectoryTree(
  resolvedPaths: string[],
  explicitDirs?: DirectoryInput[],
  options?: BuildDirectoryTreeOptions
): DirectoryInfo[] {
  // Pin timestamp once at entry for determinism
  const defaultTs = options?.defaultCreated ?? Date.now();

  // Map: path → { created, isExplicit }
  const dirMap = new Map<string, { created: number; isExplicit: boolean }>();

  // Step 1: Infer directories from file paths
  for (const path of resolvedPaths) {
    // Validate input paths
    if (!isValidPath(path)) {
      throw new ValidationError(
        `Invalid file path: must start with "/" and not contain "//", got "${path}"`
      );
    }

    const filePath = unsafe.asFilePath(path);
    const ancestors = getAncestors(filePath);

    for (const ancestor of ancestors) {
      if (!dirMap.has(ancestor)) {
        dirMap.set(ancestor, { created: defaultTs, isExplicit: false });
      }
    }
  }

  // Step 2: Merge explicit directories
  if (explicitDirs) {
    for (const dir of explicitDirs) {
      // Validate path
      if (!dir.path || dir.path.length === 0) {
        throw new ValidationError('Directory path cannot be empty');
      }
      if (!isValidPath(dir.path)) {
        throw new ValidationError(
          `Invalid directory path: must start with "/" and not contain "//", got "${dir.path}"`
        );
      }

      // Normalize (remove trailing slashes)
      const normalized = normalizePath(dir.path);

      // Reject root "/" explicitly
      if (normalized === '/') {
        throw new ValidationError(
          'Root directory "/" cannot be declared explicitly'
        );
      }

      // Add or update directory
      const existing = dirMap.get(normalized);
      const created = dir.created ?? existing?.created ?? defaultTs;

      dirMap.set(normalized, {
        created,
        isExplicit: true,
      });

      // Also add ancestors (inferred) if not present
      const ancestors = getAncestors(normalized);
      for (const ancestor of ancestors) {
        if (!dirMap.has(ancestor)) {
          dirMap.set(ancestor, { created: defaultTs, isExplicit: false });
        }
      }
    }
  }

  // Step 3: Convert to DirectoryInfo[] and sort
  const directories: DirectoryInfo[] = [];

  for (const [path, info] of dirMap) {
    const filePath = unsafe.asFilePath(path);
    directories.push({
      path,
      name: basename(filePath),
      created: info.created,
    });
  }

  // Sort by path (lexicographic)
  directories.sort((a, b) => a.path.localeCompare(b.path));

  return directories;
}

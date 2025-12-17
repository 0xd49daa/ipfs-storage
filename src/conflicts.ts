import { ValidationError } from './errors.ts';
import { asFilePath, type FilePath } from './branded.ts';
import { dirname, basename, extname } from './path-utils.ts';

/**
 * Object with a path property for conflict resolution.
 */
interface PathContainer {
  path: string;
}

/**
 * Incremental path conflict resolver.
 * Resolves conflicts one path at a time using a persistent Set.
 *
 * Use this for streaming scenarios where you want to process files
 * one at a time without collecting all paths upfront.
 */
export class PathManager {
  private seen = new Set<string>();

  /**
   * Resolve a single path, auto-renaming if a conflict exists.
   *
   * When a path conflicts with a previously resolved path, it is renamed:
   * - `photo.jpg` (first) → `photo.jpg` (unchanged)
   * - `photo.jpg` (second) → `photo_1.jpg`
   * - `photo.jpg` (third) → `photo_2.jpg`
   *
   * @param path The file path to resolve
   * @returns The resolved path (may be renamed if conflict detected)
   * @throws ValidationError if path is invalid (must start with "/", no "//")
   */
  resolvePath(path: string): string {
    // Validate and brand the path - throws ValidationError on invalid path
    let filePath: FilePath;
    try {
      filePath = asFilePath(path);
    } catch (err) {
      throw new ValidationError(
        `Invalid file path: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    let resolved = path;
    let counter = 1;

    while (this.seen.has(resolved)) {
      // Extract path components
      const ext = extname(filePath); // ".jpg"
      const name = basename(filePath); // "photo.jpg"
      const base = ext ? name.slice(0, name.length - ext.length) : name; // "photo"
      const dir = dirname(filePath); // "/photos"

      // Build new path, handling root-level files specially to avoid "//"
      if (dir === '/') {
        resolved = `/${base}_${counter}${ext}`;
      } else {
        resolved = `${dir}/${base}_${counter}${ext}`;
      }
      counter++;
    }

    this.seen.add(resolved);
    return resolved;
  }

  /**
   * Check if a path has already been resolved.
   */
  has(path: string): boolean {
    return this.seen.has(path);
  }

  /**
   * Get the count of resolved paths.
   */
  get size(): number {
    return this.seen.size;
  }
}

/**
 * Resolve duplicate file paths by auto-renaming conflicts.
 *
 * When multiple files have the same path, they are renamed to ensure uniqueness:
 * - `photo.jpg` (first) → `photo.jpg` (unchanged)
 * - `photo.jpg` (second) → `photo_1.jpg`
 * - `photo.jpg` (third) → `photo_2.jpg`
 *
 * If `photo_1.jpg` already exists, the counter skips to `photo_2.jpg`.
 *
 * @param files Array of objects with path property to check for conflicts
 * @returns Array of resolved paths aligned with input (resolvedPaths[i] is the path for files[i])
 * @throws ValidationError if any path is invalid (must start with "/", no "//")
 */
export function resolveConflicts(files: PathContainer[]): string[] {
  const seen = new Set<string>();
  const resolvedPaths: string[] = [];

  for (const file of files) {
    // Validate and brand the path - throws ValidationError on invalid path
    let filePath;
    try {
      filePath = asFilePath(file.path);
    } catch (err) {
      throw new ValidationError(
        `Invalid file path: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    let resolved = file.path;
    let counter = 1;

    while (seen.has(resolved)) {
      // Extract path components
      const ext = extname(filePath); // ".jpg"
      const name = basename(filePath); // "photo.jpg"
      const base = ext ? name.slice(0, name.length - ext.length) : name; // "photo"
      const dir = dirname(filePath); // "/photos"

      // Build new path, handling root-level files specially to avoid "//"
      if (dir === '/') {
        resolved = `/${base}_${counter}${ext}`;
      } else {
        resolved = `${dir}/${base}_${counter}${ext}`;
      }
      counter++;
    }

    seen.add(resolved);
    resolvedPaths.push(resolved);
  }

  return resolvedPaths;
}

import type { FileInput } from './types.ts';
import { ValidationError } from './errors.ts';
import { asFilePath } from './branded.ts';
import { dirname, basename, extname } from './path-utils.ts';

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
 * @param files Array of files to check for conflicts
 * @returns Array of resolved paths aligned with input (resolvedPaths[i] is the path for files[i])
 * @throws ValidationError if any path is invalid (must start with "/", no "//")
 */
export function resolveConflicts(files: FileInput[]): string[] {
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

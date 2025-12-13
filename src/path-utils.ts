import { type FilePath, asFilePath, unsafe } from './branded.ts';

/**
 * Check if a path string is valid.
 * Valid paths must start with "/" and not contain "//".
 */
export function isValidPath(path: string): boolean {
  if (!path.startsWith('/')) {
    return false;
  }
  if (path.includes('//')) {
    return false;
  }
  return true;
}

/**
 * Normalize a path string and return as FilePath.
 * Removes trailing slashes (except for root "/").
 * Throws if path is invalid.
 */
export function normalizePath(path: string): FilePath {
  // Remove trailing slashes (except for root)
  let normalized = path;
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return asFilePath(normalized);
}

/**
 * Extract the directory part of a path.
 * "/foo/bar/baz.txt" → "/foo/bar"
 * "/file.txt" → "/"
 * "/" → "/"
 */
export function dirname(path: FilePath): FilePath {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash === 0) {
    // Root or file directly under root
    return unsafe.asFilePath('/');
  }
  return unsafe.asFilePath(path.slice(0, lastSlash));
}

/**
 * Extract the filename from a path.
 * "/foo/bar/baz.txt" → "baz.txt"
 * "/" → ""
 */
export function basename(path: FilePath): string {
  const lastSlash = path.lastIndexOf('/');
  return path.slice(lastSlash + 1);
}

/**
 * Extract the extension from a path (including the dot).
 * "/foo/bar/baz.txt" → ".txt"
 * "/foo/bar/file.tar.gz" → ".gz"
 * "/foo/bar/.hidden" → "" (dotfile without extension)
 * "/foo/bar/.hidden.txt" → ".txt"
 * "/foo/bar/file" → ""
 */
export function extname(path: FilePath): string {
  const filename = basename(path);
  if (!filename) {
    return '';
  }

  // Find the last dot, but not if it's the first character (dotfile)
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) {
    // No dot, or dot is first character (dotfile without extension)
    return '';
  }

  return filename.slice(lastDot);
}

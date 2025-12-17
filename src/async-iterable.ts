/**
 * Utility for converting arrays to AsyncIterable.
 */

/**
 * Convert an array to an AsyncIterable.
 *
 * Use this helper when calling uploadBatch() with an array of FileInput.
 *
 * @example
 * ```typescript
 * const files = [
 *   { getFile: () => myFile, path: '/doc.pdf', contentHash, size: myFile.size }
 * ];
 * await module.uploadBatch(asAsyncIterable(files), options);
 * ```
 *
 * @param items - Array of items to iterate
 * @returns AsyncIterable that yields each item
 */
export async function* asAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

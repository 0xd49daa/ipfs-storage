/**
 * PADME padding algorithm for hiding file sizes.
 *
 * PADME pads messages to lengths representable as a floating point number
 * whose mantissa is no longer than its exponent. This provides O(log(log(M)))
 * leakage with at most 12% overhead.
 *
 * @see https://lbarman.ch/blog/padme/
 */

/**
 * Result of PADME padding calculation.
 */
export interface PadmeResult {
  /** Original size in bytes */
  originalSize: number;
  /** Padded size in bytes (always >= originalSize) */
  paddedSize: number;
  /** Number of padding bytes added */
  paddingBytes: number;
}

/**
 * Calculate PADME-padded size for a given input size.
 *
 * The algorithm works by masking off the least significant bits of the size,
 * where the number of bits masked depends on the magnitude of the size.
 * This ensures overhead is bounded at ~12% while reducing information leakage.
 *
 * @param size - Original size in bytes (must be >= 0)
 * @returns Padded size in bytes
 *
 * @example
 * ```ts
 * padme(0)    // 0 (no data)
 * padme(5)    // 5 (tiny sizes unchanged)
 * padme(9)    // 10 (first size that gets padded)
 * padme(1000) // 1024
 * ```
 */
export function padme(size: number): number {
  // No padding for zero or tiny sizes (per PADME spec)
  if (size <= 0) return 0;
  if (size <= 8) return size;

  // E = exponent = floor(log2(size))
  // This is the position of the most significant bit
  const E = Math.floor(Math.log2(size));

  // S = number of significant mantissa bits = floor(log2(E)) + 1
  // This determines how many bits we keep
  const S = Math.floor(Math.log2(E)) + 1;

  // Mask the least significant (E - S) bits to zero, rounding up
  const lastBits = E - S;
  const bitMask = (1 << lastBits) - 1;

  // Add bitMask to round up, then mask off the low bits
  return (size + bitMask) & ~bitMask;
}

/**
 * Calculate PADME padding with detailed result.
 *
 * @param size - Original size in bytes (must be >= 0)
 * @returns Object with original size, padded size, and padding bytes
 *
 * @example
 * ```ts
 * padmeWithDetails(1000)
 * // { originalSize: 1000, paddedSize: 1024, paddingBytes: 24 }
 * ```
 */
export function padmeWithDetails(size: number): PadmeResult {
  const paddedSize = padme(size);
  return {
    originalSize: size,
    paddedSize,
    paddingBytes: paddedSize - size,
  };
}

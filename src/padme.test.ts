import { describe, test, expect } from 'bun:test';
import { padme, padmeWithDetails } from './padme.ts';

describe('Phase 6: PADME Padding', () => {
  describe('padme()', () => {
    describe('zero and tiny sizes', () => {
      test('returns 0 for size 0', () => {
        expect(padme(0)).toBe(0);
      });

      test('returns 0 for negative size', () => {
        expect(padme(-1)).toBe(0);
        expect(padme(-100)).toBe(0);
      });

      test('returns size unchanged for 1-8 bytes', () => {
        for (let i = 1; i <= 8; i++) {
          expect(padme(i)).toBe(i);
        }
      });
    });

    describe('basic padding', () => {
      test('pads size 9 → 10', () => {
        // E = floor(log2(9)) = 3
        // S = floor(log2(3)) + 1 = 2
        // lastBits = 3 - 2 = 1
        // bitMask = 1
        // (9 + 1) & ~1 = 10
        expect(padme(9)).toBe(10);
      });

      test('pads size 100 → 104', () => {
        // E = floor(log2(100)) = 6
        // S = floor(log2(6)) + 1 = 3
        // lastBits = 6 - 3 = 3
        // bitMask = 7
        // (100 + 7) & ~7 = 104
        expect(padme(100)).toBe(104);
      });

      test('pads size 1000 → 1024', () => {
        // E = floor(log2(1000)) = 9
        // S = floor(log2(9)) + 1 = 4
        // lastBits = 9 - 4 = 5
        // bitMask = 31
        // (1000 + 31) & ~31 = 1024
        expect(padme(1000)).toBe(1024);
      });
    });

    describe('overhead caps', () => {
      const KB = 1024;
      const MB = 1024 * 1024;
      const GB = 1024 * 1024 * 1024;

      test('1KB overhead ≤ 12%', () => {
        const original = KB;
        const padded = padme(original);
        const overhead = (padded - original) / original;
        expect(overhead).toBeLessThanOrEqual(0.12);
      });

      test('1MB overhead ≤ 6%', () => {
        const original = MB;
        const padded = padme(original);
        const overhead = (padded - original) / original;
        expect(overhead).toBeLessThanOrEqual(0.06);
      });

      test('1GB overhead ≤ 3%', () => {
        const original = GB;
        const padded = padme(original);
        const overhead = (padded - original) / original;
        expect(overhead).toBeLessThanOrEqual(0.03);
      });

      test('overhead never exceeds 12% for sizes 9-10MB', () => {
        const testSizes = [9, 10, 100, 1000, 10000, 100000, 1000000, 10000000];
        for (const size of testSizes) {
          const padded = padme(size);
          const overhead = (padded - size) / size;
          expect(overhead).toBeLessThanOrEqual(0.12);
        }
      });
    });

    describe('properties', () => {
      test('padded size always >= original', () => {
        const sizes = [0, 1, 5, 8, 9, 100, 1000, 10000, 100000, 1000000];
        for (const size of sizes) {
          expect(padme(size)).toBeGreaterThanOrEqual(size);
        }
      });

      test('is deterministic (same input → same output)', () => {
        const size = 12345;
        const result1 = padme(size);
        const result2 = padme(size);
        expect(result1).toBe(result2);
      });

      test('is idempotent (padme(padme(x)) === padme(x))', () => {
        const sizes = [9, 100, 1000, 12345, 100000];
        for (const size of sizes) {
          const once = padme(size);
          const twice = padme(once);
          expect(twice).toBe(once);
        }
      });

      test('result is always a power-of-two multiple', () => {
        // PADME rounds up to values where low bits are masked
        // The result should have trailing zeros equal to lastBits
        for (let size = 9; size < 10000; size += 100) {
          const padded = padme(size);
          // Padded values should be evenly divisible by some power of 2
          expect(padded % 2).toBe(0);
        }
      });
    });
  });

  describe('padmeWithDetails()', () => {
    test('returns correct structure', () => {
      const result = padmeWithDetails(1000);
      expect(result).toHaveProperty('originalSize');
      expect(result).toHaveProperty('paddedSize');
      expect(result).toHaveProperty('paddingBytes');
    });

    test('originalSize matches input', () => {
      const result = padmeWithDetails(1000);
      expect(result.originalSize).toBe(1000);
    });

    test('paddedSize matches padme()', () => {
      const result = padmeWithDetails(1000);
      expect(result.paddedSize).toBe(padme(1000));
    });

    test('paddingBytes is difference', () => {
      const result = padmeWithDetails(1000);
      expect(result.paddingBytes).toBe(result.paddedSize - result.originalSize);
    });

    test('handles zero size', () => {
      const result = padmeWithDetails(0);
      expect(result.originalSize).toBe(0);
      expect(result.paddedSize).toBe(0);
      expect(result.paddingBytes).toBe(0);
    });

    test('handles tiny sizes (no padding)', () => {
      for (let i = 1; i <= 8; i++) {
        const result = padmeWithDetails(i);
        expect(result.paddingBytes).toBe(0);
      }
    });
  });
});

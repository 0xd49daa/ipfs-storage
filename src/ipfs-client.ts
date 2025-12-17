/**
 * IPFS client abstraction layer.
 * Provides interface for IPFS operations and in-memory mock for testing.
 */

import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';
import * as dagPb from '@ipld/dag-pb';
import { CarBufferReader } from '@ipld/car';
import { decode as decodeUnixFS, NodeType } from '@ipld/unixfs';
import { IpfsStorageError } from './errors.ts';

// Local type definitions for UnixFS nodes (not exported from @ipld/unixfs)
// These match the shapes returned by decode()

interface UnixFSMetadata {
  readonly mode?: number;
  readonly mtime?: { readonly secs: number; readonly nsecs?: number };
}

interface SimpleFile {
  readonly type: typeof NodeType.File;
  readonly layout: 'simple';
  readonly content: Uint8Array;
  readonly metadata?: UnixFSMetadata;
}

interface AdvancedFile {
  readonly type: typeof NodeType.File;
  readonly layout: 'advanced';
  readonly parts: ReadonlyArray<FileLink>;
  readonly metadata?: UnixFSMetadata;
}

interface ComplexFile {
  readonly type: typeof NodeType.File;
  readonly layout: 'complex';
  readonly content: Uint8Array;
  readonly parts: ReadonlyArray<FileLink>;
  readonly metadata?: UnixFSMetadata;
}

interface Raw {
  readonly type: typeof NodeType.Raw;
  readonly content: Uint8Array;
}

interface FileLink {
  readonly cid: CID;
  readonly contentByteLength: number;
  readonly dagByteLength: number;
}

type UnixFSNode =
  | SimpleFile
  | AdvancedFile
  | ComplexFile
  | Raw
  | { readonly type: typeof NodeType.Directory }
  | { readonly type: typeof NodeType.HAMTShard }
  | { readonly type: typeof NodeType.Symlink; readonly content: Uint8Array };

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Abstraction layer for IPFS operations.
 *
 * Implementations must satisfy the following contracts:
 * - `uploadCar()` must be atomic: either all blocks are uploaded or none
 * - `cat()` must stream bytes for paths within a UnixFS directory structure
 * - `has()` must return true only for CIDs that have been successfully uploaded
 */
export interface IpfsClient {
  /**
   * Upload a CAR file to IPFS.
   *
   * REQUIREMENT: Must be atomic - either fully uploaded or not at all.
   * Partial uploads must not leave dangling blocks.
   *
   * @param car - AsyncIterable producing CAR file bytes
   * @returns The root CID of the uploaded CAR
   * @throws {IpfsUploadError} If upload fails (after any cleanup)
   */
  uploadCar(car: AsyncIterable<Uint8Array>): Promise<string>;

  /**
   * Retrieve content from IPFS by CID, optionally with path.
   *
   * When a path is provided, traverses the UnixFS directory structure
   * from the root CID to resolve the target file/directory.
   *
   * @param cid - Root CID to start from
   * @param path - Optional path within the UnixFS structure (e.g., "/m" or "/6B/v7/6Bv7...")
   * @returns AsyncIterable of content bytes
   * @throws {IpfsFetchError} If CID not found or path resolution fails
   */
  cat(cid: string, path?: string): AsyncIterable<Uint8Array>;

  /**
   * Check if a CID exists in IPFS.
   *
   * Used for resume support to skip already-uploaded chunks.
   *
   * @param cid - CID to check
   * @returns true if CID exists and is accessible
   */
  has(cid: string): Promise<boolean>;
}

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Error during IPFS upload operation.
 */
export class IpfsUploadError extends IpfsStorageError {
  constructor(message: string, cause?: Error) {
    super(`IPFS upload failed: ${message}`);
    this.name = 'IpfsUploadError';
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Error during IPFS fetch operation.
 */
export class IpfsFetchError extends IpfsStorageError {
  readonly cid: string;
  readonly path?: string;

  constructor(cid: string, message: string, path?: string) {
    super(`IPFS fetch failed for ${cid}${path ? path : ''}: ${message}`);
    this.name = 'IpfsFetchError';
    this.cid = cid;
    this.path = path;
  }
}

// ============================================================================
// CID Utilities
// ============================================================================

/**
 * Compute CID for raw bytes using sha256 and raw codec.
 * This is the simplest CID type - used for raw data blocks.
 */
export async function computeRawCid(bytes: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(bytes);
  return CID.createV1(raw.code, hash);
}

/**
 * Compute CID for dag-pb encoded bytes (UnixFS).
 * Used for directory and file nodes.
 */
export async function computeDagPbCid(bytes: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(bytes);
  return CID.createV1(dagPb.code, hash);
}

/**
 * Parse a CID string to CID object.
 */
export function parseCid(cidStr: string): CID {
  return CID.parse(cidStr);
}

/**
 * Format CID to string representation.
 */
export function formatCid(cid: CID): string {
  return cid.toString();
}

// ============================================================================
// MockIpfsClient
// ============================================================================

/**
 * Options for MockIpfsClient.
 */
export interface MockIpfsClientOptions {
  /** If true, next upload will fail */
  failNextUpload?: boolean;
  /** Delay in ms before upload completes */
  uploadDelay?: number;
  /** Number of uploads to fail before succeeding (for retry testing) */
  failUploadCount?: number;
}

/**
 * In-memory mock IPFS client for testing.
 *
 * Stores uploaded CAR content in memory and correctly computes CIDs.
 * Supports UnixFS directory traversal for path resolution.
 */
export class MockIpfsClient implements IpfsClient {
  /** All stored blocks by CID string */
  private blocks: Map<string, Uint8Array>;

  /** Root CIDs from uploaded CARs */
  private roots: Set<string>;

  /** Failure simulation flag */
  private failNextUpload: boolean;

  /** Upload delay in ms */
  private uploadDelay: number;

  /** Number of remaining uploads to fail (for retry testing) */
  private failUploadCount: number;

  /** Latch function called during uploadCar for abort testing */
  private uploadLatch: (() => Promise<void>) | null = null;

  /** Latch function called during cat for abort testing */
  private catLatch: (() => Promise<void>) | null = null;

  constructor(options?: MockIpfsClientOptions) {
    this.blocks = new Map();
    this.roots = new Set();
    this.failNextUpload = options?.failNextUpload ?? false;
    this.uploadDelay = options?.uploadDelay ?? 0;
    this.failUploadCount = options?.failUploadCount ?? 0;
  }

  /**
   * Upload a CAR file to IPFS (mock implementation).
   * Parses the CAR and stores all blocks in memory.
   */
  async uploadCar(car: AsyncIterable<Uint8Array>): Promise<string> {
    // Collect all bytes from async iterable
    const chunks: Uint8Array[] = [];
    for await (const chunk of car) {
      chunks.push(chunk);
    }

    // Concatenate into single buffer
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const carBytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      carBytes.set(chunk, offset);
      offset += chunk.length;
    }

    // Apply delay if configured
    if (this.uploadDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.uploadDelay));
    }

    // Check for simulated failure (single shot)
    if (this.failNextUpload) {
      this.failNextUpload = false;
      throw new IpfsUploadError('Simulated upload failure');
    }

    // Check for simulated failure (countdown for retry testing)
    if (this.failUploadCount > 0) {
      this.failUploadCount--;
      throw new IpfsUploadError('Simulated transient upload failure');
    }

    // Parse CAR file
    let reader: CarBufferReader;
    try {
      reader = CarBufferReader.fromBytes(carBytes);
    } catch (error) {
      throw new IpfsUploadError(
        'Failed to parse CAR file',
        error instanceof Error ? error : undefined
      );
    }

    // Get roots (may be empty for headless CAR segments)
    const roots = reader.getRoots();

    // Collect all blocks first (for atomicity)
    const newBlocks: Array<{ cidStr: string; bytes: Uint8Array }> = [];
    for (const block of reader.blocks()) {
      newBlocks.push({
        cidStr: block.cid.toString(),
        bytes: block.bytes,
      });
    }

    // Store all blocks atomically
    for (const { cidStr, bytes } of newBlocks) {
      this.blocks.set(cidStr, bytes);
    }

    // Store root CIDs
    for (const root of roots) {
      this.roots.add(root.toString());
    }

    // Call latch if set (for abort testing - allows test to trigger abort after segment completes)
    if (this.uploadLatch) {
      await this.uploadLatch();
    }

    // Return first root CID if present, empty string for headless CARs
    const firstRoot = roots[0];
    return firstRoot ? firstRoot.toString() : '';
  }

  /**
   * Retrieve content from IPFS by CID, optionally with path.
   */
  async *cat(cid: string, path?: string): AsyncIterable<Uint8Array> {
    // Call latch if set (for abort testing - allows test to trigger abort during fetch)
    if (this.catLatch) {
      await this.catLatch();
    }

    if (!path || path === '' || path === '/') {
      // Direct block retrieval
      const bytes = this.blocks.get(cid);
      if (!bytes) {
        throw new IpfsFetchError(cid, 'Block not found');
      }
      yield bytes;
      return;
    }

    // Path resolution through UnixFS directory structure
    const bytes = await this.resolvePath(cid, path);
    yield bytes;
  }

  /**
   * Check if a CID exists in IPFS.
   */
  async has(cid: string): Promise<boolean> {
    return this.blocks.has(cid);
  }

  // ==========================================================================
  // Test Helpers
  // ==========================================================================

  /**
   * Clear all stored blocks and roots.
   */
  clear(): void {
    this.blocks.clear();
    this.roots.clear();
  }

  /**
   * Set whether next upload should fail.
   */
  setFailNextUpload(fail: boolean): void {
    this.failNextUpload = fail;
  }

  /**
   * Set number of uploads to fail before succeeding (for retry testing).
   * Each upload attempt decrements this counter until it reaches 0.
   */
  setFailUploadCount(count: number): void {
    this.failUploadCount = count;
  }

  /**
   * Get a block directly by CID.
   */
  getBlock(cid: string): Uint8Array | undefined {
    return this.blocks.get(cid);
  }

  /**
   * Get the number of stored blocks.
   */
  getBlockCount(): number {
    return this.blocks.size;
  }

  /**
   * Check if a CID is a root.
   */
  isRoot(cid: string): boolean {
    return this.roots.has(cid);
  }

  /**
   * Set a latch function that uploadCar will await after storing blocks.
   * Use this for deterministic abort testing - the latch is called after
   * a segment's blocks are stored, allowing tests to trigger abort between segments.
   *
   * @param latch - Async function to await, or null to clear
   */
  setUploadLatch(latch: (() => Promise<void>) | null): void {
    this.uploadLatch = latch;
  }

  /**
   * Clear the upload latch. Call in afterEach() to prevent test pollution.
   */
  clearUploadLatch(): void {
    this.uploadLatch = null;
  }

  /**
   * Set a latch function that cat will await before yielding data.
   * Use this for deterministic abort testing - the latch is called before
   * data is returned, allowing tests to trigger abort during downloads.
   *
   * @param latch - Async function to await, or null to clear
   */
  setCatLatch(latch: (() => Promise<void>) | null): void {
    this.catLatch = latch;
  }

  /**
   * Clear the cat latch. Call in afterEach() to prevent test pollution.
   */
  clearCatLatch(): void {
    this.catLatch = null;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Resolve a path within a UnixFS directory structure.
   */
  private async resolvePath(rootCid: string, path: string): Promise<Uint8Array> {
    // Split path into segments: "/a/b/c" -> ["a", "b", "c"]
    const segments = path.split('/').filter((s) => s.length > 0);

    let currentCid = parseCid(rootCid);

    for (const segment of segments) {
      const blockBytes = this.blocks.get(currentCid.toString());
      if (!blockBytes) {
        throw new IpfsFetchError(
          currentCid.toString(),
          `Block not found while resolving path`,
          path
        );
      }

      // Check codec to determine how to decode
      if (currentCid.code === dagPb.code) {
        // Decode dag-pb node
        const node = dagPb.decode(blockBytes);

        // Find link with matching name
        const link = node.Links?.find((l) => l.Name === segment);
        if (!link) {
          throw new IpfsFetchError(
            rootCid,
            `Path segment not found: ${segment}`,
            path
          );
        }

        currentCid = link.Hash;
      } else {
        // Can't traverse non-dag-pb nodes
        throw new IpfsFetchError(
          rootCid,
          `Cannot traverse non-directory node at segment: ${segment}`,
          path
        );
      }
    }

    // Get final block
    const finalBytes = this.blocks.get(currentCid.toString());
    if (!finalBytes) {
      throw new IpfsFetchError(
        currentCid.toString(),
        'Final block not found',
        path
      );
    }

    // Extract content based on codec, passing root/path for error context
    return this.extractContent(finalBytes, currentCid, rootCid, path);
  }

  /**
   * Extract file content from a block based on its codec.
   *
   * For raw codec (0x55): returns bytes directly.
   * For dag-pb codec (0x70): decodes UnixFS structure and extracts file content,
   * following links for chunked files (AdvancedFile/ComplexFile layouts).
   *
   * @param bytes - The raw block bytes
   * @param cid - The CID of the block (used to determine codec)
   * @param rootCid - Original root CID for error context
   * @param path - Original path for error context
   */
  private extractContent(
    bytes: Uint8Array,
    cid: CID,
    rootCid?: string,
    path?: string
  ): Uint8Array {
    // If raw codec (0x55), return bytes directly
    if (cid.code === raw.code) {
      return bytes;
    }

    // If dag-pb codec (0x70), decode UnixFS and extract content
    if (cid.code === dagPb.code) {
      // First decode dag-pb to check structure
      const pbNode = dagPb.decode(bytes);

      // Try to decode as UnixFS, with fallback for library bugs
      let node: UnixFSNode;
      try {
        // Cast through unknown since @ipld/unixfs types are not exported
        node = decodeUnixFS(bytes) as unknown as UnixFSNode;
      } catch {
        // Fallback: if decode fails (e.g., AdvancedFile with no inline data),
        // check if this is a file node with links (chunked file)
        if (pbNode.Links && pbNode.Links.length > 0) {
          // This is likely an AdvancedFile (file with data only in links)
          // The decode() bug occurs when UnixFS Data field has no inline bytes
          return this.extractAdvancedFileContent(pbNode, rootCid ?? cid.toString(), path);
        }
        // Re-throw if we can't handle it
        throw new IpfsFetchError(
          rootCid ?? cid.toString(),
          'Failed to decode UnixFS node',
          path
        );
      }

      switch (node.type) {
        case NodeType.File:
          return this.extractFileContent(
            node as SimpleFile | AdvancedFile | ComplexFile,
            rootCid ?? cid.toString(),
            path
          );
        case NodeType.Raw:
          return (node as Raw).content;
        case NodeType.Directory:
        case NodeType.HAMTShard:
          // Directories have no file content
          return new Uint8Array(0);
        case NodeType.Symlink:
          // Return symlink target path as content
          return node.content;
        default:
          return new Uint8Array(0);
      }
    }

    // Unknown codec - return raw bytes
    return bytes;
  }

  /**
   * Extract content from an AdvancedFile that failed decode().
   * This handles the case where the UnixFS Data field is empty/missing.
   */
  private extractAdvancedFileContent(
    pbNode: dagPb.PBNode,
    rootCid: string,
    path?: string
  ): Uint8Array {
    const chunks: Uint8Array[] = [];

    // Follow all links (they are file chunks)
    for (const link of pbNode.Links || []) {
      const linkCid = link.Hash;
      const linkBytes = this.blocks.get(linkCid.toString());
      if (!linkBytes) {
        throw new IpfsFetchError(
          rootCid,
          `Linked block not found: ${linkCid.toString()}`,
          path
        );
      }
      // Recursively extract content from linked block
      const content = this.extractContent(linkBytes, linkCid, rootCid, path);
      chunks.push(content);
    }

    // Concatenate chunks
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0]!;

    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  /**
   * Extract content from a UnixFS file node, handling different layouts:
   * - simple: content is inline in the node
   * - advanced: content is spread across linked blocks (parts)
   * - complex: inline content + linked blocks
   */
  private extractFileContent(
    node: SimpleFile | AdvancedFile | ComplexFile,
    rootCid: string,
    path?: string
  ): Uint8Array {
    const chunks: Uint8Array[] = [];

    // Inline content first (simple/complex layouts have 'content' property)
    // Handle undefined/null content gracefully
    if ('content' in node && node.content && node.content.length > 0) {
      chunks.push(node.content);
    }

    // Follow parts links (advanced/complex layouts have 'parts' property)
    if ('parts' in node && node.parts && node.parts.length > 0) {
      for (const part of node.parts) {
        const linkCid = part.cid;
        const linkBytes = this.blocks.get(linkCid.toString());
        if (!linkBytes) {
          throw new IpfsFetchError(
            rootCid,
            `Linked block not found: ${linkCid.toString()}`,
            path
          );
        }
        // Recursively extract content from linked block
        const content = this.extractContent(linkBytes, linkCid as CID, rootCid, path);
        chunks.push(content);
      }
    }

    // Concatenate chunks
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0]!;

    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}

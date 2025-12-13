/**
 * Tests for IpfsClient interface and MockIpfsClient implementation.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CarBufferWriter } from '@ipld/car';
import * as dagPb from '@ipld/dag-pb';
import * as raw from 'multiformats/codecs/raw';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { encode as encodeUnixFS, NodeType, type FileLink } from '@ipld/unixfs';
import {
  MockIpfsClient,
  IpfsUploadError,
  IpfsFetchError,
  computeRawCid,
  computeDagPbCid,
  parseCid,
  formatCid,
} from './ipfs-client.ts';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a CAR file with raw blocks.
 */
async function createRawBlockCar(
  data: Uint8Array[]
): Promise<{ carBytes: Uint8Array; cids: CID[]; rootCid: CID }> {
  // Compute CIDs for all blocks
  const cids: CID[] = [];
  for (const bytes of data) {
    const cid = await computeRawCid(bytes);
    cids.push(cid);
  }

  // Create CAR with first CID as root
  const rootCid = cids[0]!;
  const buffer = new ArrayBuffer(1024 * 1024);
  const writer = CarBufferWriter.createWriter(buffer, {
    roots: [rootCid],
  });

  for (let i = 0; i < data.length; i++) {
    writer.write({ cid: cids[i]!, bytes: data[i]! });
  }

  const carBytes = writer.close();
  return { carBytes, cids, rootCid };
}

/**
 * Create a CAR with a directory structure.
 */
async function createDirectoryCar(
  files: Array<{ name: string; data: Uint8Array }>
): Promise<{ carBytes: Uint8Array; rootCid: CID; fileCids: Map<string, CID> }> {
  const fileCids = new Map<string, CID>();
  const blocks: Array<{ cid: CID; bytes: Uint8Array }> = [];

  // Create raw blocks for file contents
  for (const file of files) {
    const cid = await computeRawCid(file.data);
    fileCids.set(file.name, cid);
    blocks.push({ cid, bytes: file.data });
  }

  // Create directory node with links
  const links = files.map((file) => ({
    Name: file.name,
    Hash: fileCids.get(file.name)!,
    Tsize: file.data.length,
  }));

  const dirNode = dagPb.createNode(new Uint8Array(0), links);
  const dirBytes = dagPb.encode(dirNode);
  const dirCid = await computeDagPbCid(dirBytes);
  blocks.push({ cid: dirCid, bytes: dirBytes });

  // Create CAR with directory as root
  const buffer = new ArrayBuffer(1024 * 1024);
  const writer = CarBufferWriter.createWriter(buffer, {
    roots: [dirCid],
  });

  for (const block of blocks) {
    writer.write(block);
  }

  const carBytes = writer.close();
  return { carBytes, rootCid: dirCid, fileCids };
}

/**
 * Create nested directory structure.
 */
async function createNestedDirectoryCar(): Promise<{
  carBytes: Uint8Array;
  rootCid: CID;
  leafData: Uint8Array;
}> {
  const blocks: Array<{ cid: CID; bytes: Uint8Array }> = [];

  // Leaf file
  const leafData = new TextEncoder().encode('leaf content');
  const leafCid = await computeRawCid(leafData);
  blocks.push({ cid: leafCid, bytes: leafData });

  // Inner directory (contains leaf as "file.txt")
  const innerLinks = [{ Name: 'file.txt', Hash: leafCid, Tsize: leafData.length }];
  const innerNode = dagPb.createNode(new Uint8Array(0), innerLinks);
  const innerBytes = dagPb.encode(innerNode);
  const innerCid = await computeDagPbCid(innerBytes);
  blocks.push({ cid: innerCid, bytes: innerBytes });

  // Root directory (contains inner as "subdir")
  const rootLinks = [{ Name: 'subdir', Hash: innerCid, Tsize: innerBytes.length }];
  const rootNode = dagPb.createNode(new Uint8Array(0), rootLinks);
  const rootBytes = dagPb.encode(rootNode);
  const rootCid = await computeDagPbCid(rootBytes);
  blocks.push({ cid: rootCid, bytes: rootBytes });

  // Create CAR
  const buffer = new ArrayBuffer(1024 * 1024);
  const writer = CarBufferWriter.createWriter(buffer, {
    roots: [rootCid],
  });

  for (const block of blocks) {
    writer.write(block);
  }

  const carBytes = writer.close();
  return { carBytes, rootCid, leafData };
}

/**
 * Convert Uint8Array to async iterable.
 */
async function* toAsyncIterable(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

/**
 * Collect async iterable to single Uint8Array.
 */
async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// ============================================================================
// Tests
// ============================================================================

describe('Phase 2: IpfsClient', () => {
  describe('CID Utilities', () => {
    test('computeRawCid produces deterministic CID', async () => {
      const data = new TextEncoder().encode('hello world');
      const cid1 = await computeRawCid(data);
      const cid2 = await computeRawCid(data);

      expect(cid1.toString()).toBe(cid2.toString());
    });

    test('computeRawCid produces different CIDs for different content', async () => {
      const data1 = new TextEncoder().encode('hello');
      const data2 = new TextEncoder().encode('world');

      const cid1 = await computeRawCid(data1);
      const cid2 = await computeRawCid(data2);

      expect(cid1.toString()).not.toBe(cid2.toString());
    });

    test('computeRawCid uses raw codec', async () => {
      const data = new TextEncoder().encode('test');
      const cid = await computeRawCid(data);

      expect(cid.code).toBe(raw.code);
    });

    test('computeDagPbCid uses dag-pb codec', async () => {
      const data = new TextEncoder().encode('test');
      const cid = await computeDagPbCid(data);

      expect(cid.code).toBe(dagPb.code);
    });

    test('parseCid correctly parses CID string', async () => {
      const data = new TextEncoder().encode('test');
      const originalCid = await computeRawCid(data);
      const cidStr = originalCid.toString();

      const parsedCid = parseCid(cidStr);

      expect(parsedCid.toString()).toBe(cidStr);
      expect(parsedCid.code).toBe(originalCid.code);
    });

    test('formatCid produces string representation', async () => {
      const data = new TextEncoder().encode('test');
      const cid = await computeRawCid(data);

      const formatted = formatCid(cid);

      expect(typeof formatted).toBe('string');
      expect(formatted.length).toBeGreaterThan(0);
    });
  });

  describe('MockIpfsClient', () => {
    let client: MockIpfsClient;

    beforeEach(() => {
      client = new MockIpfsClient();
    });

    describe('uploadCar()', () => {
      test('returns correct root CID', async () => {
        const data = [new TextEncoder().encode('block 1')];
        const { carBytes, rootCid } = await createRawBlockCar(data);

        const returnedCid = await client.uploadCar(toAsyncIterable(carBytes));

        expect(returnedCid).toBe(rootCid.toString());
      });

      test('stores all blocks from CAR', async () => {
        const data = [
          new TextEncoder().encode('block 1'),
          new TextEncoder().encode('block 2'),
          new TextEncoder().encode('block 3'),
        ];
        const { carBytes, cids } = await createRawBlockCar(data);

        await client.uploadCar(toAsyncIterable(carBytes));

        expect(client.getBlockCount()).toBe(3);
        for (const cid of cids) {
          expect(await client.has(cid.toString())).toBe(true);
        }
      });

      test('is atomic - no blocks stored on failure', async () => {
        const data = [new TextEncoder().encode('test')];
        const { carBytes } = await createRawBlockCar(data);

        client.setFailNextUpload(true);

        await expect(client.uploadCar(toAsyncIterable(carBytes))).rejects.toThrow(
          IpfsUploadError
        );

        expect(client.getBlockCount()).toBe(0);
      });

      test('throws on invalid CAR', async () => {
        const invalidCar = new TextEncoder().encode('not a valid car file');

        await expect(client.uploadCar(toAsyncIterable(invalidCar))).rejects.toThrow(
          IpfsUploadError
        );
      });

      test('handles multi-chunk async iterable', async () => {
        const data = [new TextEncoder().encode('test block')];
        const { carBytes, rootCid } = await createRawBlockCar(data);

        // Split CAR into multiple chunks
        async function* chunkedIterable(): AsyncIterable<Uint8Array> {
          const chunkSize = 100;
          for (let i = 0; i < carBytes.length; i += chunkSize) {
            yield carBytes.slice(i, Math.min(i + chunkSize, carBytes.length));
          }
        }

        const returnedCid = await client.uploadCar(chunkedIterable());

        expect(returnedCid).toBe(rootCid.toString());
      });

      test('respects upload delay', async () => {
        const delayMs = 50;
        const delayedClient = new MockIpfsClient({ uploadDelay: delayMs });
        const data = [new TextEncoder().encode('test')];
        const { carBytes } = await createRawBlockCar(data);

        const startTime = Date.now();
        await delayedClient.uploadCar(toAsyncIterable(carBytes));
        const elapsed = Date.now() - startTime;

        expect(elapsed).toBeGreaterThanOrEqual(delayMs - 10); // Allow small tolerance
      });

      test('marks root CID as root', async () => {
        const data = [new TextEncoder().encode('test')];
        const { carBytes, rootCid } = await createRawBlockCar(data);

        await client.uploadCar(toAsyncIterable(carBytes));

        expect(client.isRoot(rootCid.toString())).toBe(true);
      });
    });

    describe('cat()', () => {
      test('returns correct bytes for direct CID (no path)', async () => {
        const data = [new TextEncoder().encode('hello world')];
        const { carBytes, rootCid } = await createRawBlockCar(data);

        await client.uploadCar(toAsyncIterable(carBytes));
        const content = await collect(client.cat(rootCid.toString()));

        expect(content).toEqual(data[0]!);
      });

      test('returns correct bytes for path within directory', async () => {
        const files = [
          { name: 'file1.txt', data: new TextEncoder().encode('content 1') },
          { name: 'file2.txt', data: new TextEncoder().encode('content 2') },
        ];
        const { carBytes, rootCid } = await createDirectoryCar(files);

        await client.uploadCar(toAsyncIterable(carBytes));

        const content1 = await collect(client.cat(rootCid.toString(), '/file1.txt'));
        expect(content1).toEqual(files[0]!.data);

        const content2 = await collect(client.cat(rootCid.toString(), '/file2.txt'));
        expect(content2).toEqual(files[1]!.data);
      });

      test('handles nested directory paths', async () => {
        const { carBytes, rootCid, leafData } = await createNestedDirectoryCar();

        await client.uploadCar(toAsyncIterable(carBytes));

        const content = await collect(
          client.cat(rootCid.toString(), '/subdir/file.txt')
        );
        expect(content).toEqual(leafData);
      });

      test('throws IpfsFetchError for non-existent CID', async () => {
        const fakeCid = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';

        await expect(collect(client.cat(fakeCid))).rejects.toThrow(IpfsFetchError);
      });

      test('throws IpfsFetchError for invalid path segment', async () => {
        const files = [{ name: 'file.txt', data: new TextEncoder().encode('content') }];
        const { carBytes, rootCid } = await createDirectoryCar(files);

        await client.uploadCar(toAsyncIterable(carBytes));

        await expect(
          collect(client.cat(rootCid.toString(), '/nonexistent.txt'))
        ).rejects.toThrow(IpfsFetchError);
      });

      test('handles empty path same as no path', async () => {
        const data = [new TextEncoder().encode('test content')];
        const { carBytes, rootCid } = await createRawBlockCar(data);

        await client.uploadCar(toAsyncIterable(carBytes));

        const content1 = await collect(client.cat(rootCid.toString()));
        const content2 = await collect(client.cat(rootCid.toString(), ''));
        const content3 = await collect(client.cat(rootCid.toString(), '/'));

        expect(content1).toEqual(data[0]!);
        expect(content2).toEqual(data[0]!);
        expect(content3).toEqual(data[0]!);
      });
    });

    describe('has()', () => {
      test('returns true for uploaded CID', async () => {
        const data = [new TextEncoder().encode('test')];
        const { carBytes, rootCid } = await createRawBlockCar(data);

        await client.uploadCar(toAsyncIterable(carBytes));

        expect(await client.has(rootCid.toString())).toBe(true);
      });

      test('returns false for non-existent CID', async () => {
        const fakeCid = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';

        expect(await client.has(fakeCid)).toBe(false);
      });

      test('returns true for all blocks in multi-block CAR', async () => {
        const data = [
          new TextEncoder().encode('block A'),
          new TextEncoder().encode('block B'),
        ];
        const { carBytes, cids } = await createRawBlockCar(data);

        await client.uploadCar(toAsyncIterable(carBytes));

        for (const cid of cids) {
          expect(await client.has(cid.toString())).toBe(true);
        }
      });
    });

    describe('test helpers', () => {
      test('clear() removes all state', async () => {
        const data = [new TextEncoder().encode('test')];
        const { carBytes, rootCid } = await createRawBlockCar(data);

        await client.uploadCar(toAsyncIterable(carBytes));
        expect(client.getBlockCount()).toBe(1);

        client.clear();

        expect(client.getBlockCount()).toBe(0);
        expect(await client.has(rootCid.toString())).toBe(false);
        expect(client.isRoot(rootCid.toString())).toBe(false);
      });

      test('setFailNextUpload() causes next upload to fail', async () => {
        const data = [new TextEncoder().encode('test')];
        const { carBytes } = await createRawBlockCar(data);

        client.setFailNextUpload(true);

        await expect(client.uploadCar(toAsyncIterable(carBytes))).rejects.toThrow(
          IpfsUploadError
        );

        // Next upload should succeed
        const result = await client.uploadCar(toAsyncIterable(carBytes));
        expect(result).toBeDefined();
      });

      test('getBlock() returns stored block bytes', async () => {
        const data = [new TextEncoder().encode('block content')];
        const { carBytes, rootCid } = await createRawBlockCar(data);

        await client.uploadCar(toAsyncIterable(carBytes));

        const block = client.getBlock(rootCid.toString());
        expect(block).toEqual(data[0]!);
      });

      test('getBlock() returns undefined for non-existent CID', () => {
        const fakeCid = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';

        expect(client.getBlock(fakeCid)).toBeUndefined();
      });

      test('getBlockCount() returns accurate count', async () => {
        expect(client.getBlockCount()).toBe(0);

        const data1 = [new TextEncoder().encode('block 1')];
        const { carBytes: car1 } = await createRawBlockCar(data1);
        await client.uploadCar(toAsyncIterable(car1));

        expect(client.getBlockCount()).toBe(1);

        const data2 = [
          new TextEncoder().encode('block 2'),
          new TextEncoder().encode('block 3'),
        ];
        const { carBytes: car2 } = await createRawBlockCar(data2);
        await client.uploadCar(toAsyncIterable(car2));

        expect(client.getBlockCount()).toBe(3);
      });
    });

    describe('UnixFS file node handling', () => {
      /**
       * Create a CAR with a UnixFS SimpleFile (inline data).
       */
      async function createUnixFsSimpleFileCar(
        fileName: string,
        data: Uint8Array
      ): Promise<{ carBytes: Uint8Array; rootCid: CID; fileData: Uint8Array }> {
        const blocks: Array<{ cid: CID; bytes: Uint8Array }> = [];

        // Create UnixFS SimpleFile node (inline data)
        const simpleFile = {
          type: NodeType.File as const,
          layout: 'simple' as const,
          content: data,
        };
        const fileBytes = encodeUnixFS(simpleFile);
        const fileCid = await computeDagPbCid(fileBytes);
        blocks.push({ cid: fileCid, bytes: fileBytes });

        // Create directory with link to file
        const dirLinks = [{ Name: fileName, Hash: fileCid, Tsize: fileBytes.length }];
        const dirNode = dagPb.createNode(new Uint8Array(0), dirLinks);
        const dirBytes = dagPb.encode(dirNode);
        const dirCid = await computeDagPbCid(dirBytes);
        blocks.push({ cid: dirCid, bytes: dirBytes });

        // Create CAR
        const buffer = new ArrayBuffer(1024 * 1024);
        const writer = CarBufferWriter.createWriter(buffer, { roots: [dirCid] });
        for (const block of blocks) {
          writer.write(block);
        }
        const carBytes = writer.close();

        return { carBytes, rootCid: dirCid, fileData: data };
      }

      /**
       * Create a CAR with a UnixFS AdvancedFile (chunked, data in links).
       */
      async function createUnixFsChunkedFileCar(
        fileName: string,
        chunks: Uint8Array[]
      ): Promise<{ carBytes: Uint8Array; rootCid: CID; fileData: Uint8Array }> {
        const blocks: Array<{ cid: CID; bytes: Uint8Array }> = [];
        const parts: FileLink[] = [];

        // Create chunk blocks (using FileChunk encoding)
        for (const chunk of chunks) {
          const fileChunk = {
            type: NodeType.File as const,
            layout: 'simple' as const,
            content: chunk,
          };
          const chunkBytes = encodeUnixFS(fileChunk);
          const chunkCid = await computeDagPbCid(chunkBytes);
          blocks.push({ cid: chunkCid, bytes: chunkBytes });
          parts.push({
            cid: chunkCid,
            dagByteLength: chunkBytes.length,
            contentByteLength: chunk.length,
          });
        }

        // Create UnixFS AdvancedFile node (links to chunks)
        const advancedFile = {
          type: NodeType.File as const,
          layout: 'advanced' as const,
          parts,
        };
        const fileBytes = encodeUnixFS(advancedFile);
        const fileCid = await computeDagPbCid(fileBytes);
        blocks.push({ cid: fileCid, bytes: fileBytes });

        // Create directory with link to file
        const dirLinks = [{ Name: fileName, Hash: fileCid, Tsize: fileBytes.length }];
        const dirNode = dagPb.createNode(new Uint8Array(0), dirLinks);
        const dirBytes = dagPb.encode(dirNode);
        const dirCid = await computeDagPbCid(dirBytes);
        blocks.push({ cid: dirCid, bytes: dirBytes });

        // Create CAR
        const buffer = new ArrayBuffer(1024 * 1024);
        const writer = CarBufferWriter.createWriter(buffer, { roots: [dirCid] });
        for (const block of blocks) {
          writer.write(block);
        }
        const carBytes = writer.close();

        // Combine original chunks for verification
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const fileData = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          fileData.set(chunk, offset);
          offset += chunk.length;
        }

        return { carBytes, rootCid: dirCid, fileData };
      }

      /**
       * Create nested directory with UnixFS file.
       */
      async function createNestedUnixFsFileCar(): Promise<{
        carBytes: Uint8Array;
        rootCid: CID;
        fileData: Uint8Array;
      }> {
        const blocks: Array<{ cid: CID; bytes: Uint8Array }> = [];
        const fileData = new TextEncoder().encode('nested unixfs file content');

        // Create UnixFS SimpleFile
        const simpleFile = {
          type: NodeType.File as const,
          layout: 'simple' as const,
          content: fileData,
        };
        const fileBytes = encodeUnixFS(simpleFile);
        const fileCid = await computeDagPbCid(fileBytes);
        blocks.push({ cid: fileCid, bytes: fileBytes });

        // Create inner directory containing the file
        const innerLinks = [{ Name: 'data.txt', Hash: fileCid, Tsize: fileBytes.length }];
        const innerNode = dagPb.createNode(new Uint8Array(0), innerLinks);
        const innerBytes = dagPb.encode(innerNode);
        const innerCid = await computeDagPbCid(innerBytes);
        blocks.push({ cid: innerCid, bytes: innerBytes });

        // Create root directory containing inner directory
        const rootLinks = [{ Name: 'subdir', Hash: innerCid, Tsize: innerBytes.length }];
        const rootNode = dagPb.createNode(new Uint8Array(0), rootLinks);
        const rootBytes = dagPb.encode(rootNode);
        const rootCid = await computeDagPbCid(rootBytes);
        blocks.push({ cid: rootCid, bytes: rootBytes });

        // Create CAR
        const buffer = new ArrayBuffer(1024 * 1024);
        const writer = CarBufferWriter.createWriter(buffer, { roots: [rootCid] });
        for (const block of blocks) {
          writer.write(block);
        }
        const carBytes = writer.close();

        return { carBytes, rootCid, fileData };
      }

      test('cat() extracts content from UnixFS SimpleFile node', async () => {
        const originalData = new TextEncoder().encode('inline unixfs file content');
        const { carBytes, rootCid, fileData } = await createUnixFsSimpleFileCar(
          'file.txt',
          originalData
        );

        await client.uploadCar(toAsyncIterable(carBytes));
        const content = await collect(client.cat(rootCid.toString(), '/file.txt'));

        expect(content).toEqual(fileData);
      });

      test('cat() extracts content from UnixFS AdvancedFile (chunked)', async () => {
        const chunk1 = new TextEncoder().encode('first chunk of data');
        const chunk2 = new TextEncoder().encode('second chunk of data');
        const chunk3 = new TextEncoder().encode('third chunk');

        const { carBytes, rootCid, fileData } = await createUnixFsChunkedFileCar(
          'chunked.txt',
          [chunk1, chunk2, chunk3]
        );

        await client.uploadCar(toAsyncIterable(carBytes));
        const content = await collect(client.cat(rootCid.toString(), '/chunked.txt'));

        expect(content).toEqual(fileData);
      });

      test('cat() resolves nested path and extracts UnixFS file content', async () => {
        const { carBytes, rootCid, fileData } = await createNestedUnixFsFileCar();

        await client.uploadCar(toAsyncIterable(carBytes));
        const content = await collect(client.cat(rootCid.toString(), '/subdir/data.txt'));

        expect(content).toEqual(fileData);
      });

      test('cat() throws IpfsFetchError for missing linked chunk', async () => {
        // Create a file that references a non-existent chunk
        const blocks: Array<{ cid: CID; bytes: Uint8Array }> = [];

        // Create a fake CID for a chunk that won't exist
        const fakeChunkData = new TextEncoder().encode('fake chunk');
        const fakeChunkCid = await computeDagPbCid(fakeChunkData);
        // Note: we don't add this block to the CAR

        // Create AdvancedFile referencing the missing chunk
        const parts: FileLink[] = [
          {
            cid: fakeChunkCid,
            dagByteLength: 100,
            contentByteLength: 50,
          },
        ];
        const advancedFile = {
          type: NodeType.File as const,
          layout: 'advanced' as const,
          parts,
        };
        const fileBytes = encodeUnixFS(advancedFile);
        const fileCid = await computeDagPbCid(fileBytes);
        blocks.push({ cid: fileCid, bytes: fileBytes });

        // Create directory
        const dirLinks = [{ Name: 'broken.txt', Hash: fileCid, Tsize: fileBytes.length }];
        const dirNode = dagPb.createNode(new Uint8Array(0), dirLinks);
        const dirBytes = dagPb.encode(dirNode);
        const dirCid = await computeDagPbCid(dirBytes);
        blocks.push({ cid: dirCid, bytes: dirBytes });

        // Create CAR (without the chunk block)
        const buffer = new ArrayBuffer(1024 * 1024);
        const writer = CarBufferWriter.createWriter(buffer, { roots: [dirCid] });
        for (const block of blocks) {
          writer.write(block);
        }
        const carBytes = writer.close();

        await client.uploadCar(toAsyncIterable(carBytes));

        await expect(
          collect(client.cat(dirCid.toString(), '/broken.txt'))
        ).rejects.toThrow(IpfsFetchError);
      });

      test('cat() handles empty UnixFS file', async () => {
        const { carBytes, rootCid, fileData } = await createUnixFsSimpleFileCar(
          'empty.txt',
          new Uint8Array(0)
        );

        await client.uploadCar(toAsyncIterable(carBytes));
        const content = await collect(client.cat(rootCid.toString(), '/empty.txt'));

        expect(content).toEqual(fileData);
        expect(content.length).toBe(0);
      });
    });
  });
});

import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { asAsyncIterable } from "./async-iterable.ts";
import { downloadFiles } from "./download-files.ts";
import { getManifest } from "./manifest-retrieval.ts";
import { MockIpfsClient } from "./ipfs-client.ts";
import { uploadBatch } from "./streaming-upload.ts";
import { ValidationError } from "./errors.ts";
import type { FileDownloadRef, MultiDownloadProgress, StreamingFileInput } from "./types.ts";
import { type ContentHash, hashContent, type SymmetricKey } from "./crypto-primitives.ts";

const manifestKey = new Uint8Array(32).fill(1) as SymmetricKey;
const batch_id = new Uint8Array(16).fill(2);

async function createTestFile(
  path: string,
  content: string | Uint8Array,
): Promise<StreamingFileInput> {
  const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
    path,
    contentHash: await hashContent(data),
    size: data.length,
    getStream: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      }),
  };
}

async function collectAsyncIterable<T>(
  iterable: AsyncIterable<T>,
): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

async function collectBytes(
  iterable: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function uploadAndGetRefs(
  files: StreamingFileInput[],
  client: MockIpfsClient,
): Promise<FileDownloadRef[]> {
  const result = await uploadBatch(
    asAsyncIterable(files),
    { manifestKey, batch_id },
    client,
  );
  const manifest = await getManifest(result.cid, {
    ipfsClient: client,
    manifestKey,
  });
  return manifest.files.map((f) => ({
    batchCid: manifest.cid,
    path: f.path,
    size: f.size,
    contentHash: f.contentHash,
    chunks: f.chunks,
  }));
}

describe("downloadFiles", () => {
  describe("validation", () => {
    test("throws ValidationError for empty refs array", async () => {
      const client = new MockIpfsClient();
      await expect(
        collectAsyncIterable(downloadFiles([], { manifestKey }, client)),
      ).rejects.toThrow(ValidationError);
    });

    test("throws ValidationError for invalid concurrency", async () => {
      const client = new MockIpfsClient();
      const fakeHash = await hashContent(new Uint8Array(32));
      const ref: FileDownloadRef = {
        batchCid: "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354",
        path: "/test.txt",
        size: 7,
        contentHash: fakeHash,
        chunks: [],
      };

      await expect(
        collectAsyncIterable(
          downloadFiles([ref], { manifestKey, concurrency: 0 }, client),
        ),
      ).rejects.toThrow(ValidationError);
      await expect(
        collectAsyncIterable(
          downloadFiles([ref], { manifestKey, chunkConcurrency: 0 }, client),
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("basic functionality", () => {
    test("downloads a single file", async () => {
      const client = new MockIpfsClient();
      const refs = await uploadAndGetRefs(
        [await createTestFile("/test.txt", "Hello, World!")],
        client,
      );

      const downloadedFiles = await collectAsyncIterable(
        downloadFiles(refs, { manifestKey }, client),
      );

      expect(downloadedFiles).toHaveLength(1);
      expect(downloadedFiles[0]!.path).toBe("/test.txt");
      const content = await collectBytes(downloadedFiles[0]!.content);
      expect(new TextDecoder().decode(content)).toBe("Hello, World!");
    });

    test("downloads multiple files in request order", async () => {
      const client = new MockIpfsClient();
      const refs = await uploadAndGetRefs(
        [
          await createTestFile("/a.txt", "Content A"),
          await createTestFile("/b.txt", "Content B"),
          await createTestFile("/c.txt", "Content C"),
        ],
        client,
      );

      const downloadedFiles = await collectAsyncIterable(
        downloadFiles(refs, { manifestKey, concurrency: 2 }, client),
      );

      expect(downloadedFiles.map((f) => f.path)).toEqual([
        "/a.txt",
        "/b.txt",
        "/c.txt",
      ]);
    });

    test("reports aggregate progress", async () => {
      const client = new MockIpfsClient();
      const refs = await uploadAndGetRefs(
        [
          await createTestFile("/a.txt", "AAAA"),
          await createTestFile("/b.txt", "BBBBBB"),
          await createTestFile("/c.txt", "CC"),
        ],
        client,
      );
      const progressUpdates: MultiDownloadProgress[] = [];

      const downloadedFiles = await collectAsyncIterable(
        downloadFiles(
          refs,
          {
            manifestKey,
            onProgress: (progress) => progressUpdates.push({ ...progress }),
          },
          client,
        ),
      );

      expect(downloadedFiles).toHaveLength(3);
      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates[0]!.totalFiles).toBe(3);
      expect(progressUpdates[0]!.totalBytes).toBe(12);
      expect(progressUpdates[progressUpdates.length - 1]!.bytesDownloaded).toBe(
        12,
      );
    });
  });

  describe("error handling", () => {
    test("continue mode invokes onError and continues", async () => {
      const client = new MockIpfsClient();
      const refs = await uploadAndGetRefs(
        [
          await createTestFile("/good1.txt", "Good content 1"),
          await createTestFile("/good2.txt", "Good content 2"),
        ],
        client,
      );
      const fakeHash = await hashContent(new Uint8Array(32));
      const badRef: FileDownloadRef = {
        batchCid: refs[0]!.batchCid,
        path: "/bad.txt",
        size: 10,
        contentHash: fakeHash,
        chunks: [
          {
            chunkId: "badchunk12345678901234",
            cid: "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            offset: 0,
            length: 10,
            encryption: 0,
            encryptedLength: 50,
          },
        ],
      };
      const errors: Array<{ path: string; error: Error }> = [];

      const downloadedFiles = await collectAsyncIterable(
        downloadFiles(
          [refs[0]!, badRef, refs[1]!],
          {
            manifestKey,
            onError: (error, ref) => errors.push({ path: ref.path, error }),
          },
          client,
        ),
      );

      expect(downloadedFiles).toHaveLength(2);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.path).toBe("/bad.txt");
    });
  });
});

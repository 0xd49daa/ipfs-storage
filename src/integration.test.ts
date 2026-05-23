import { beforeAll, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type ContentHash,
  hashBlake2b,
  preloadSodium,
  type SymmetricKey,
} from "@0xd49daa/safecrypt";
import {
  asAsyncIterable,
  type BatchManifest,
  createIpfsStorageModule,
  type DirectoryInput,
  type FileDownloadRef,
  type IpfsStorageModule,
  MockIpfsClient,
  type StreamingFileInput,
} from "./index.ts";

const manifestKey = new Uint8Array(32).fill(1) as SymmetricKey;
const batch_id = new Uint8Array(16).fill(2);

beforeAll(async () => {
  await preloadSodium();
});

async function createFileInput(
  content: string,
  path: string,
): Promise<StreamingFileInput> {
  const bytes = new TextEncoder().encode(content);
  return createBinaryFileInput(bytes, path);
}

async function createBinaryFileInput(
  data: Uint8Array,
  path: string,
): Promise<StreamingFileInput> {
  return {
    path,
    contentHash: (await hashBlake2b(data, 32)) as ContentHash,
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

function generatePatternedBytes(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    data[i] = i % 256;
  }
  return data;
}

function buildFileRef(
  manifest: BatchManifest,
  filePath: string,
): FileDownloadRef {
  const fileInfo = manifest.files.find((f) => f.path === filePath);
  if (!fileInfo) throw new Error(`File not found: ${filePath}`);
  return {
    batchCid: manifest.cid,
    path: fileInfo.path,
    size: fileInfo.size,
    contentHash: fileInfo.contentHash,
    manifestKey: manifest.manifestKey,
    chunks: fileInfo.chunks,
  };
}

function buildAllFileRefs(manifest: BatchManifest): FileDownloadRef[] {
  return manifest.files.map((f) => ({
    batchCid: manifest.cid,
    path: f.path,
    size: f.size,
    contentHash: f.contentHash,
    manifestKey: manifest.manifestKey,
    chunks: f.chunks,
  }));
}

describe("Integration: symmetric API", () => {
  let ipfsClient: MockIpfsClient;
  let module: IpfsStorageModule;

  beforeEach(() => {
    ipfsClient = new MockIpfsClient();
    module = createIpfsStorageModule({ ipfsClient });
  });

  test("single small file: upload -> getManifest -> downloadFile", async () => {
    const content = "Hello, Integration Test!";
    const file = await createFileInput(content, "/hello.txt");

    const result = await module.uploadBatch(asAsyncIterable([file]), {
      manifestKey,
      batch_id,
    });
    const manifest = await module.getManifest(result.cid, { manifestKey });

    expect(manifest.cid).toBe(result.cid);
    expect("senderPublicKey" in manifest).toBe(false);
    expect(manifest.files).toHaveLength(1);

    const downloaded = await collectBytes(
      module.downloadFile(buildFileRef(manifest, "/hello.txt")),
    );
    expect(new TextDecoder().decode(downloaded)).toBe(content);
  });

  test("multiple small files: upload -> getManifest -> downloadFiles", async () => {
    const files = [
      await createFileInput("Content A", "/a.txt"),
      await createFileInput("Content B", "/b.txt"),
      await createFileInput("Content C", "/c.txt"),
    ];

    const result = await module.uploadBatch(asAsyncIterable(files), {
      manifestKey,
      batch_id,
    });
    const manifest = await module.getManifest(result.cid, { manifestKey });
    const downloaded = new Map<string, string>();

    for await (const file of module.downloadFiles(buildAllFileRefs(manifest))) {
      downloaded.set(
        file.path,
        new TextDecoder().decode(await collectBytes(file.content)),
      );
    }

    expect(downloaded.get("/a.txt")).toBe("Content A");
    expect(downloaded.get("/b.txt")).toBe("Content B");
    expect(downloaded.get("/c.txt")).toBe("Content C");
  });

  test("large file spans chunks and round-trips", async () => {
    const data = generatePatternedBytes(17 * 1024 * 1024);
    const file = await createBinaryFileInput(data, "/large.bin");

    const result = await module.uploadBatch(asAsyncIterable([file]), {
      manifestKey,
      batch_id,
    });
    const manifest = await module.getManifest(result.cid, { manifestKey });

    expect(result.chunkCount).toBeGreaterThan(1);
    expect(manifest.files[0]!.chunks.length).toBeGreaterThan(1);

    const downloaded = await collectBytes(
      module.downloadFile(buildFileRef(manifest, "/large.bin")),
    );
    expect(downloaded).toEqual(data);
  });

  test("explicit empty directories are preserved", async () => {
    const directories: DirectoryInput[] = [
      { path: "/empty-folder", created: 1700000000000 },
      { path: "/another-empty" },
    ];
    const file = await createFileInput("content", "/docs/readme.txt");

    const result = await module.uploadBatch(asAsyncIterable([file]), {
      manifestKey,
      batch_id,
      directories,
    });
    const manifest = await module.getManifest(result.cid, { manifestKey });

    const emptyFolder = manifest.directories.find(
      (d) => d.path === "/empty-folder",
    );
    expect(emptyFolder).toBeDefined();
    expect(emptyFolder!.created).toBe(1700000000000);
    expect(manifest.directories.some((d) => d.path === "/another-empty")).toBe(
      true,
    );
  });

  test("duplicate paths are renamed and content is preserved", async () => {
    const files = [
      await createFileInput("first", "/photo.jpg"),
      await createFileInput("second", "/photo.jpg"),
      await createFileInput("third", "/photo.jpg"),
    ];

    const result = await module.uploadBatch(asAsyncIterable(files), {
      manifestKey,
      batch_id,
    });
    const manifest = await module.getManifest(result.cid, { manifestKey });
    const downloaded = new Map<string, string>();

    expect(result.renamed).toHaveLength(2);
    for await (const file of module.downloadFiles(buildAllFileRefs(manifest))) {
      downloaded.set(
        file.path,
        new TextDecoder().decode(await collectBytes(file.content)),
      );
    }

    expect(downloaded.get("/photo.jpg")).toBe("first");
    expect(downloaded.get("/photo_1.jpg")).toBe("second");
    expect(downloaded.get("/photo_2.jpg")).toBe("third");
  });
});

import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CarBufferWriter } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import * as raw from "multiformats/codecs/raw";
import type { CID } from "multiformats/cid";
import {
  asAsyncIterable,
  CidMismatchError,
  createIpfsStorageModule,
  hashContent,
  KuboRpcClient,
  MockIpfsClient,
  type StreamingFileInput,
  type SymmetricKey,
} from "./index.ts";
import { computeDagPbCid, computeRawCid } from "./ipfs-client.ts";

const manifestKey = new Uint8Array(32).fill(7) as SymmetricKey;
const batch_id = new Uint8Array(16).fill(9);

interface FetchCall {
  readonly method: string;
  readonly path: string;
  readonly search: URLSearchParams;
  readonly bodyBytes: Uint8Array;
}

async function createCar(
  blocks: Array<{ cid: CID; bytes: Uint8Array }>,
  roots: CID[],
): Promise<Uint8Array> {
  const totalBlockBytes = blocks.reduce(
    (sum, block) => sum + block.bytes.length,
    0,
  );
  const buffer = new ArrayBuffer(totalBlockBytes + 4096);
  const writer = CarBufferWriter.createWriter(buffer, { roots });
  for (const block of blocks) {
    writer.write(block);
  }
  return writer.close();
}

async function createRootedRawCar(
  data: Uint8Array,
): Promise<{ carBytes: Uint8Array; rootCid: CID }> {
  const rootCid = await computeRawCid(data);
  const carBytes = await createCar([{ cid: rootCid, bytes: data }], [rootCid]);
  return { carBytes, rootCid };
}

async function createRootlessRawCar(
  blocks: Uint8Array[],
): Promise<{ carBytes: Uint8Array; cids: CID[] }> {
  const entries: Array<{ cid: CID; bytes: Uint8Array }> = [];
  for (const bytes of blocks) {
    entries.push({ cid: await computeRawCid(bytes), bytes });
  }
  const carBytes = await createCar(entries, []);
  return { carBytes, cids: entries.map((entry) => entry.cid) };
}

async function createDirectoryCar(
  files: Array<{ name: string; data: Uint8Array }>,
): Promise<{ carBytes: Uint8Array; rootCid: CID }> {
  const blocks: Array<{ cid: CID; bytes: Uint8Array }> = [];
  const links = [];

  for (const file of files) {
    const cid = await computeRawCid(file.data);
    blocks.push({ cid, bytes: file.data });
    links.push({ Name: file.name, Hash: cid, Tsize: file.data.length });
  }

  const rootBytes = dagPb.encode(dagPb.createNode(new Uint8Array(0), links));
  const rootCid = await computeDagPbCid(rootBytes);
  blocks.push({ cid: rootCid, bytes: rootBytes });

  const carBytes = await createCar(blocks, [rootCid]);
  return { carBytes, rootCid };
}

async function createFileInput(
  content: string,
  path: string,
): Promise<StreamingFileInput> {
  const bytes = new TextEncoder().encode(content);
  return {
    path,
    contentHash: await hashContent(bytes),
    size: bytes.length,
    getStream: () => asAsyncIterable([bytes]),
  };
}

async function collectBytes(
  iterable: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === "object" &&
    Symbol.asyncIterator in value;
}

async function collectRequestBody(body: unknown): Promise<Uint8Array> {
  if (body === undefined || body === null) {
    return new Uint8Array(0);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (body instanceof ReadableStream) {
    return collectBytes(readableStreamToAsyncIterable(body));
  }
  if (isAsyncIterable(body)) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) {
      if (chunk instanceof Uint8Array) {
        chunks.push(chunk);
      } else if (typeof chunk === "string") {
        chunks.push(new TextEncoder().encode(chunk));
      } else if (chunk instanceof ArrayBuffer) {
        chunks.push(new Uint8Array(chunk));
      } else {
        throw new TypeError("Unsupported request body chunk");
      }
    }
    return concatenate(chunks);
  }
  throw new TypeError("Unsupported request body");
}

async function* readableStreamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function findBytes(
  source: Uint8Array,
  target: Uint8Array,
  from = 0,
): number {
  for (let i = from; i <= source.length - target.length; i++) {
    let matches = true;
    for (let j = 0; j < target.length; j++) {
      if (source[i + j] !== target[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }
  return -1;
}

function extractMultipartFile(body: Uint8Array, headers: Headers): Uint8Array {
  const contentType = headers.get("content-type") ?? "";
  const boundary = contentType.match(/boundary=(.+)$/)?.[1]?.replaceAll(
    '"',
    "",
  );
  if (!boundary) {
    throw new Error("Missing multipart boundary");
  }

  const delimiter = new TextEncoder().encode("\r\n\r\n");
  const dataStart = findBytes(body, delimiter) + delimiter.length;
  if (dataStart < delimiter.length) {
    throw new Error("Missing multipart header delimiter");
  }

  const endMarker = new TextEncoder().encode(`\r\n--${boundary}`);
  const dataEnd = findBytes(body, endMarker, dataStart);
  if (dataEnd === -1) {
    throw new Error("Missing multipart end marker");
  }

  return body.slice(dataStart, dataEnd);
}

function splitIpfsPath(arg: string): { cid: string; path?: string } {
  const trimmed = arg.replace(/^\/+/, "");
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex === -1) {
    return { cid: trimmed };
  }
  return {
    cid: trimmed.slice(0, slashIndex),
    path: trimmed.slice(slashIndex + 1),
  };
}

class FakeKuboFetch {
  readonly client = new MockIpfsClient();
  readonly calls: FetchCall[] = [];
  nextDagImportRootCid: string | undefined;
  readonly blockPutCidOverrides: string[] = [];

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? input.toString());
    const headers = new Headers(init?.headers ?? request?.headers);
    const bodyBytes = await collectRequestBody(init?.body);

    this.calls.push({
      method: init?.method ?? request?.method ?? "GET",
      path: url.pathname,
      search: new URLSearchParams(url.searchParams),
      bodyBytes,
    });

    try {
      if (url.pathname.endsWith("/api/v0/dag/import")) {
        return await this.handleDagImport(bodyBytes, headers);
      }
      if (url.pathname.endsWith("/api/v0/block/put")) {
        return await this.handleBlockPut(url, bodyBytes, headers);
      }
      if (url.pathname.endsWith("/api/v0/cat")) {
        return await this.handleCat(url);
      }
      if (url.pathname.endsWith("/api/v0/block/stat")) {
        return await this.handleBlockStat(url);
      }
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : String(error),
        {
          status: 500,
        },
      );
    }

    return new Response("not found", { status: 404 });
  };

  private async handleDagImport(
    bodyBytes: Uint8Array,
    headers: Headers,
  ): Promise<Response> {
    const carBytes = extractMultipartFile(bodyBytes, headers);
    const rootCid = await this.client.uploadCar(asAsyncIterable([carBytes]));
    const returnedRootCid = this.nextDagImportRootCid ?? rootCid;
    this.nextDagImportRootCid = undefined;

    return new Response(
      `${JSON.stringify({ Root: { Cid: { "/": returnedRootCid } } })}\n`,
      { headers: { "content-type": "application/x-ndjson" } },
    );
  }

  private async handleBlockPut(
    url: URL,
    bodyBytes: Uint8Array,
    headers: Headers,
  ): Promise<Response> {
    const blockBytes = extractMultipartFile(bodyBytes, headers);
    const format = url.searchParams.get("format");
    const cid = format === "dag-pb" || format === "protobuf"
      ? await computeDagPbCid(blockBytes)
      : await computeRawCid(blockBytes);
    this.client.putBlock(cid.toString(), blockBytes);

    const returnedCid = this.blockPutCidOverrides.shift() ?? cid.toString();
    return Response.json({ Key: returnedCid, Size: blockBytes.length });
  }

  private async handleCat(url: URL): Promise<Response> {
    const arg = url.searchParams.get("arg");
    if (!arg) return new Response("missing arg", { status: 400 });

    const { cid, path } = splitIpfsPath(arg);
    const bytes = await collectBytes(this.client.cat(cid, path));
    return new Response(toArrayBuffer(bytes));
  }

  private async handleBlockStat(url: URL): Promise<Response> {
    const cid = url.searchParams.get("arg");
    if (!cid) return new Response("missing arg", { status: 400 });
    if (!(await this.client.has(cid))) {
      return new Response("block not found", { status: 500 });
    }
    return Response.json({
      Key: cid,
      Size: this.client.getBlock(cid)?.length ?? 0,
    });
  }
}

let originalFetch: typeof globalThis.fetch;

function installFakeFetch(): FakeKuboFetch {
  const fake = new FakeKuboFetch();
  globalThis.fetch = fake.fetch;
  return fake;
}

describe("KuboRpcClient", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uploads rooted CARs through Kubo dag.import", async () => {
    const fake = installFakeFetch();
    const { carBytes, rootCid } = await createRootedRawCar(
      new TextEncoder().encode("rooted block"),
    );

    const client = new KuboRpcClient();
    const result = await client.uploadCar(asAsyncIterable([carBytes]));

    expect(result).toBe(rootCid.toString());
    const call = fake.calls.find((item) => item.path.endsWith("/dag/import"));
    expect(call).toBeDefined();
    expect(call!.method).toBe("POST");
    expect(call!.search.get("pin-roots")).toBe("false");
  });

  test("uploads rootless CAR blocks through Kubo block.put", async () => {
    const fake = installFakeFetch();
    const { carBytes, cids } = await createRootlessRawCar([
      new TextEncoder().encode("block one"),
      new TextEncoder().encode("block two"),
    ]);

    const client = new KuboRpcClient();
    const result = await client.uploadCar(asAsyncIterable([carBytes]));

    expect(result).toBe("");
    const blockCalls = fake.calls.filter((item) =>
      item.path.endsWith("/block/put")
    );
    expect(blockCalls).toHaveLength(2);
    expect(blockCalls[0]!.search.get("format")).toBe("raw");
    expect(blockCalls[0]!.search.get("allow-big-block")).toBe("true");
    for (const cid of cids) {
      expect(await fake.client.has(cid.toString())).toBe(true);
    }
  });

  test("rejects rooted CAR CID mismatches", async () => {
    const fake = installFakeFetch();
    const { carBytes } = await createRootedRawCar(
      new TextEncoder().encode("expected root"),
    );
    fake.nextDagImportRootCid = (await computeRawCid(
      new TextEncoder().encode("wrong root"),
    )).toString();

    const client = new KuboRpcClient();
    await expect(client.uploadCar(asAsyncIterable([carBytes]))).rejects
      .toBeInstanceOf(CidMismatchError);
  });

  test("rejects rootless block CID mismatches", async () => {
    const fake = installFakeFetch();
    const { carBytes } = await createRootlessRawCar([
      new TextEncoder().encode("expected block"),
    ]);
    fake.blockPutCidOverrides.push((await computeRawCid(
      new TextEncoder().encode("wrong block"),
    )).toString());

    const client = new KuboRpcClient();
    await expect(client.uploadCar(asAsyncIterable([carBytes]))).rejects
      .toBeInstanceOf(CidMismatchError);
  });

  test("cats paths and checks CIDs through Kubo RPC", async () => {
    const fake = installFakeFetch();
    const manifestBytes = new TextEncoder().encode("manifest bytes");
    const { carBytes, rootCid } = await createDirectoryCar([
      { name: "m", data: manifestBytes },
    ]);
    await fake.client.uploadCar(asAsyncIterable([carBytes]));

    const client = new KuboRpcClient();
    const content = await collectBytes(client.cat(rootCid.toString(), "/m"));

    expect(content).toEqual(manifestBytes);
    expect(await client.has(rootCid.toString())).toBe(true);
    expect(
      await client.has((await computeRawCid(new Uint8Array([1]))).toString()),
    )
      .toBe(false);
  });

  test("uploads an encrypted batch and fetches its root manifest path", async () => {
    installFakeFetch();
    const client = new KuboRpcClient();
    const module = createIpfsStorageModule({ ipfsClient: client });
    const file = await createFileInput("hello kubo", "/hello.txt");

    const result = await module.uploadBatch(asAsyncIterable([file]), {
      manifestKey,
      batch_id,
    });
    const rootManifestBlob = await collectBytes(client.cat(result.cid, "/m"));

    expect(rootManifestBlob.length).toBeGreaterThan(batch_id.length);
    expect(rootManifestBlob.slice(0, batch_id.length)).toEqual(batch_id);
  });
});

import { CarBufferReader } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import * as raw from "multiformats/codecs/raw";
import type { KuboRPCClient as OfficialKuboRpcClient } from "kubo-rpc-client";
import { CidMismatchError } from "./errors.ts";
import { type IpfsClient, IpfsFetchError, IpfsUploadError } from "./ipfs-client.ts";

export const DEFAULT_KUBO_RPC_URL = "http://127.0.0.1:5001";

export interface KuboRpcClientOptions {
  /** Kubo RPC base URL. The default is the local Kubo API endpoint. */
  readonly baseUrl?: string | URL;
  /** Optional headers forwarded to the official Kubo RPC client. */
  readonly headers?: Headers | Record<string, string>;
  /** Optional request timeout accepted by the official Kubo RPC client. */
  readonly timeout?: number | string;
}

type KuboRpcClientModule = typeof import("kubo-rpc-client");

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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

function blockPutFormatForCodec(codec: number): string {
  if (codec === raw.code) return "raw";
  if (codec === dagPb.code) return "dag-pb";
  throw new IpfsUploadError(
    `Unsupported rootless CAR block codec: ${codec}`,
  );
}

function buildIpfsPath(cid: string, path?: string): string {
  if (!path || path === "/") return cid;
  return `${cid}/${path.replace(/^\/+/, "")}`;
}

function multipartBody(name: string, fileName: string, bytes: Uint8Array) {
  const boundary = `----ipfs-storage-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(prefix.length + bytes.length + suffix.length);
  body.set(prefix, 0);
  body.set(bytes, prefix.length);
  body.set(suffix, prefix.length + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function mergeHeaders(
  headers: Headers | Record<string, string> | undefined,
  extra: Record<string, string>,
): Headers {
  const merged = new Headers(headers);
  for (const [key, value] of Object.entries(extra)) merged.set(key, value);
  return merged;
}

/**
 * Browser-compatible adapter from this package's IpfsClient contract to the
 * official Kubo RPC JavaScript client.
 */
export class KuboRpcClient implements IpfsClient {
  private modulePromise: Promise<KuboRpcClientModule> | undefined;
  private clientPromise: Promise<OfficialKuboRpcClient> | undefined;

  constructor(private readonly options: KuboRpcClientOptions = {}) {}

  async uploadCar(car: AsyncIterable<Uint8Array>): Promise<string> {
    let carBytes: Uint8Array;
    let reader: CarBufferReader;
    try {
      carBytes = await collectBytes(car);
      reader = CarBufferReader.fromBytes(carBytes);
    } catch (error) {
      throw new IpfsUploadError("Failed to parse CAR file", asError(error));
    }

    const roots = reader.getRoots();
    if (roots.length === 0) {
      return await this.uploadRootlessCar(reader);
    }

    return await this.uploadRootedCar(carBytes, roots[0]!.toString());
  }

  async *cat(cid: string, path?: string): AsyncIterable<Uint8Array> {
    try {
      const client = await this.getClient();
      yield* client.cat(buildIpfsPath(cid, path));
    } catch (error) {
      throw new IpfsFetchError(cid, asError(error).message, path);
    }
  }

  async has(cid: string): Promise<boolean> {
    try {
      const [{ CID }, client] = await Promise.all([
        this.getModule(),
        this.getClient(),
      ]);
      await client.block.stat(CID.parse(cid));
      return true;
    } catch {
      return false;
    }
  }

  private async uploadRootedCar(
    carBytes: Uint8Array,
    expectedRootCid: string,
  ): Promise<string> {
    try {
      const returnedRootCid = await this.importDag(carBytes);

      if (!returnedRootCid) return expectedRootCid;
      if (returnedRootCid !== expectedRootCid) {
        throw new CidMismatchError(expectedRootCid, returnedRootCid);
      }

      return returnedRootCid;
    } catch (error) {
      if (
        error instanceof CidMismatchError || error instanceof IpfsUploadError
      ) {
        throw error;
      }
      throw new IpfsUploadError("Kubo dag.import failed", asError(error));
    }
  }

  private async uploadRootlessCar(reader: CarBufferReader): Promise<string> {
    for (const block of reader.blocks()) {
      const expectedCid = block.cid.toString();
      const format = blockPutFormatForCodec(block.cid.code);

      try {
        const actualCid = await this.putBlock(new Uint8Array(block.bytes), format);
        if (actualCid !== expectedCid) {
          throw new CidMismatchError(expectedCid, actualCid);
        }
      } catch (error) {
        if (
          error instanceof CidMismatchError || error instanceof IpfsUploadError
        ) {
          throw error;
        }
        throw new IpfsUploadError("Kubo block.put failed", asError(error));
      }
    }

    return "";
  }

  private async importDag(carBytes: Uint8Array): Promise<string | undefined> {
    const url = new URL("/api/v0/dag/import", this.options.baseUrl ?? DEFAULT_KUBO_RPC_URL);
    url.searchParams.set("pin-roots", "false");

    const { body, contentType } = multipartBody("file", "batch.car", carBytes);

    const response = await fetch(url, {
      method: "POST",
      headers: mergeHeaders(this.options.headers, { "content-type": contentType }),
      body,
    });
    if (!response.ok) {
      throw new IpfsUploadError(`Kubo dag.import failed with HTTP ${response.status}`);
    }

    for (const line of (await response.text()).split("\n")) {
      if (line.trim().length === 0) continue;
      const item = JSON.parse(line) as {
        Root?: { Cid?: { "/"?: unknown }; "/"?: unknown } | string;
      };
      if (typeof item.Root === "string") return item.Root;
      const cid = item.Root?.Cid?.["/"] ?? item.Root?.["/"];
      if (typeof cid === "string") return cid;
    }
    return undefined;
  }

  private getModule(): Promise<KuboRpcClientModule> {
    if (!this.modulePromise) {
      this.modulePromise = import("kubo-rpc-client");
    }
    return this.modulePromise;
  }

  private async getClient(): Promise<OfficialKuboRpcClient> {
    if (!this.clientPromise) {
      this.clientPromise = this.getModule().then((module) =>
        module.create({
          url: this.options.baseUrl ?? DEFAULT_KUBO_RPC_URL,
          headers: this.options.headers,
          timeout: this.options.timeout,
        })
      );
    }
    return await this.clientPromise;
  }

  private async putBlock(bytes: Uint8Array, format: string): Promise<string> {
    const url = new URL("/api/v0/block/put", this.options.baseUrl ?? DEFAULT_KUBO_RPC_URL);
    url.searchParams.set("format", format);
    url.searchParams.set("allow-big-block", "true");
    url.searchParams.set("pin", "false");

    const { body, contentType } = multipartBody("file", "block", bytes);

    const response = await fetch(url, {
      method: "POST",
      headers: mergeHeaders(this.options.headers, { "content-type": contentType }),
      body,
    });
    if (!response.ok) {
      throw new IpfsUploadError(`Kubo block.put failed with HTTP ${response.status}`);
    }

    const result = await response.json() as { Key?: unknown };
    if (typeof result.Key !== "string" || result.Key.length === 0) {
      throw new IpfsUploadError("Kubo block.put returned no CID");
    }
    return result.Key;
  }
}

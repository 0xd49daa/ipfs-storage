import { CarBufferReader } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import * as raw from "multiformats/codecs/raw";
import type { KuboRPCClient as OfficialKuboRpcClient } from "kubo-rpc-client";
import { CidMismatchError } from "./errors.ts";
import {
  type IpfsClient,
  IpfsFetchError,
  IpfsUploadError,
} from "./ipfs-client.ts";

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
      let returnedRootCid: string | undefined;
      const client = await this.getClient();
      for await (
        const result of client.dag.import([carBytes], {
          pinRoots: false,
        })
      ) {
        returnedRootCid = result.root.cid.toString();
        break;
      }

      if (!returnedRootCid) {
        throw new IpfsUploadError("Kubo dag.import returned no root CID");
      }
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
        const client = await this.getClient();
        const returnedCid = await client.block.put(block.bytes, {
          format,
          allowBigBlock: true,
          pin: false,
        });
        const actualCid = returnedCid.toString();
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
}

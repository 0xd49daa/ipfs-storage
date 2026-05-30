import type { IpfsClient } from "../src/ipfs-client.ts";
import { IpfsFetchError, IpfsUploadError } from "../src/ipfs-client.ts";
import { afterAll, beforeAll } from "@std/testing/bdd";
import {
  type ContentHash,
  hashContent,
  type SymmetricKey,
} from "../src/crypto-primitives.ts";
import { CarBufferReader } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import type { StreamingFileInput } from "../src/types.ts";
import {
  type MockIpfsServer,
  startMockIpfsServer,
} from "./mock-ipfs-server.ts";

// ============================================================================
// HttpIpfsClient Implementation
// ============================================================================

export class HttpIpfsClient implements IpfsClient {
  private apiUrl: string;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
  }

  async uploadCar(car: AsyncIterable<Uint8Array>): Promise<string> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of car) {
      chunks.push(chunk);
    }
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const carBytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      carBytes.set(chunk, offset);
      offset += chunk.length;
    }

    const reader = CarBufferReader.fromBytes(carBytes);
    const roots = reader.getRoots();

    if (roots.length === 0) {
      for (const block of reader.blocks()) {
        const codec = block.cid.code === dagPb.code ? "dag-pb" : "raw";
        const blockForm = new FormData();
        blockForm.append("file", new Blob([block.bytes.slice().buffer]));
        const res = await fetch(
          `${this.apiUrl}/api/v0/block/put?format=${codec}&allow-big-block=true`,
          {
            method: "POST",
            body: blockForm,
          },
        );
        if (!res.ok) {
          const text = await res.text();
          throw new IpfsUploadError(`Upload failed: ${res.status} ${text}`);
        }
      }
      return "";
    }

    const formData = new FormData();
    formData.append("file", new Blob([carBytes], { type: "application/car" }));

    const res = await fetch(
      `${this.apiUrl}/api/v0/dag/import?pin-roots=false&allow-big-blocks=true`,
      {
        method: "POST",
        body: formData,
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new IpfsUploadError(`Upload failed: ${res.status} ${text}`);
    }

    const text = await res.text();
    const lines = text.trim().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        if (json.Root && json.Root.Cid) {
          return json.Root.Cid["/"] || json.Root.Cid;
        }
      } catch {
        console.warn("Failed to parse dag/import response line:", line);
      }
    }

    return "";
  }

  async *cat(cid: string, path?: string): AsyncIterable<Uint8Array> {
    const fullPath = path ? `${cid}/${path.replace(/^\/+/, "")}` : cid;
    const url = `${this.apiUrl}/api/v0/cat?arg=${encodeURIComponent(fullPath)}`;

    const res = await fetch(url, { method: "POST" });
    if (!res.ok) {
      const text = await res.text();
      throw new IpfsFetchError(
        cid,
        `Fetch failed: ${res.status} ${text}`,
        path,
      );
    }

    if (!res.body) throw new IpfsFetchError(cid, "No response body", path);

    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async has(cid: string): Promise<boolean> {
    const url = `${this.apiUrl}/api/v0/block/stat?arg=${
      encodeURIComponent(cid)
    }`;
    const res = await fetch(url, { method: "POST" });
    return res.ok;
  }
}

// ============================================================================
// Test Environment Setup
// ============================================================================

const mockServer: MockIpfsServer | undefined = Deno.env.get("IPFS_API_URL")
  ? undefined
  : startMockIpfsServer();

export const IPFS_API_URL = Deno.env.get("IPFS_API_URL") || mockServer!.url;

export function createTestClient(): IpfsClient {
  return new HttpIpfsClient(IPFS_API_URL);
}

export function createTestManifestKey(index: number = 0): SymmetricKey {
  return new Uint8Array(32).fill(index & 0xff) as SymmetricKey;
}

export function createTestBatchId(index: number = 0): Uint8Array {
  return new Uint8Array(16).fill(index & 0xff);
}

export async function createStreamingFileInput(
  data: string | Uint8Array,
  path: string,
  created?: number,
): Promise<StreamingFileInput> {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  return {
    path,
    contentHash: await hashContent(bytes),
    size: bytes.length,
    created,
    getStream: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
  };
}

// Check connection before all tests
beforeAll(async () => {
  try {
    const res = await fetch(`${IPFS_API_URL}/api/v0/id`, { method: "POST" });
    if (!res.ok) throw new Error(`IPFS not healthy: ${res.status}`);
  } catch (err) {
    console.error("Failed to connect to IPFS node at", IPFS_API_URL);
    console.error(
      "Set IPFS_API_URL for a real Kubo node, or run without it to use the local mock.",
    );
    throw err;
  }
});

afterAll(async () => {
  await mockServer?.close();
});

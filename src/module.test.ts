/**
 * Tests for Module Factory (Phase 17).
 */

import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createIpfsStorageModule } from "./module.ts";
import { MockIpfsClient } from "./ipfs-client.ts";
import { ValidationError } from "./errors.ts";
import { asAsyncIterable } from "./async-iterable.ts";
import type { IpfsStorageConfig, StreamingFileInput } from "./types.ts";
import { type ContentHash, hashContent, type SymmetricKey } from "./crypto-primitives.ts";

const manifestKey = new Uint8Array(32) as SymmetricKey;
const batch_id = new Uint8Array(16).fill(1);

// ============================================================================
// Test Helpers
// ============================================================================

/** Compute content hash for a string */
async function hashString(content: string): Promise<ContentHash> {
  const bytes = new TextEncoder().encode(content);
  return hashContent(bytes);
}

/** Create StreamingFileInput from string content */
async function createFileInput(
  content: string,
  path: string,
): Promise<StreamingFileInput> {
  const bytes = new TextEncoder().encode(content);
  return {
    path,
    contentHash: await hashString(content),
    size: bytes.length,
    getStream: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
  };
}

/** Collect async iterable to Uint8Array */
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

// ============================================================================
// Factory Creation Tests
// ============================================================================

describe("createIpfsStorageModule - validation", () => {
  test("creates module with minimal config (ipfsClient only)", () => {
    const ipfsClient = new MockIpfsClient();
    const module = createIpfsStorageModule({ ipfsClient });

    expect(module).toBeDefined();
    expect(typeof module.uploadBatch).toBe("function");
    expect(typeof module.getManifest).toBe("function");
    expect(typeof module.downloadFile).toBe("function");
    expect(typeof module.downloadFiles).toBe("function");
  });

  test("creates module with config", () => {
    const ipfsClient = new MockIpfsClient();
    const module = createIpfsStorageModule({
      ipfsClient,
    });

    expect(module).toBeDefined();
  });

  test("throws ValidationError when ipfsClient is missing", () => {
    expect(() => {
      createIpfsStorageModule({} as IpfsStorageConfig);
    }).toThrow(ValidationError);

    expect(() => {
      createIpfsStorageModule({} as IpfsStorageConfig);
    }).toThrow("ipfsClient is required");
  });

  test("throws ValidationError when config is null", () => {
    expect(() => {
      createIpfsStorageModule(null as unknown as IpfsStorageConfig);
    }).toThrow(ValidationError);

    expect(() => {
      createIpfsStorageModule(null as unknown as IpfsStorageConfig);
    }).toThrow("Config must be an object");
  });
});

// ============================================================================
// Method Binding Tests
// ============================================================================

describe("createIpfsStorageModule - method binding", () => {
  test("methods are properly bound and can be destructured", async () => {
    const ipfsClient = new MockIpfsClient();
    const module = createIpfsStorageModule({ ipfsClient });

    // Destructure methods
    const { uploadBatch, getManifest, downloadFile, downloadFiles } = module;

    // Methods should still work when destructured
    expect(typeof uploadBatch).toBe("function");
    expect(typeof getManifest).toBe("function");
    expect(typeof downloadFile).toBe("function");
    expect(typeof downloadFiles).toBe("function");
  });

  test("config object is not mutated", () => {
    const ipfsClient = new MockIpfsClient();
    const config: IpfsStorageConfig = {
      ipfsClient,
    };

    const configCopy = { ...config };
    createIpfsStorageModule(config);

    expect(config.ipfsClient).toBe(configCopy.ipfsClient);
  });
});

// ============================================================================
// Round-Trip Integration Tests
// ============================================================================

describe("createIpfsStorageModule - round-trip", () => {
  test("upload → getManifest → downloadFile round-trip", async () => {
    const ipfsClient = new MockIpfsClient();
    const module = createIpfsStorageModule({ ipfsClient });

    // Upload
    const content = "Hello, IPFS Storage Module!";
    const file = await createFileInput(content, "/hello.txt");

    const result = await module.uploadBatch(asAsyncIterable([file]), {
      manifestKey,
      batch_id,
    });

    expect(result.cid).toMatch(/^bafybei/);
    expect(result.manifest.files).toHaveLength(1);

    // Get manifest
    const manifest = await module.getManifest(result.cid, {
      manifestKey,
    });

    expect(manifest.cid).toBe(result.cid);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]!.path).toBe("/hello.txt");

    // Download file
    const fileInfo = manifest.files[0]!;
    const fileRef = {
      batchCid: manifest.cid,
      path: fileInfo.path,
      size: fileInfo.size,
      contentHash: fileInfo.contentHash,
      chunks: fileInfo.chunks,
    };

    const downloadedBytes = await collectBytes(
      module.downloadFile(fileRef, { manifestKey }),
    );
    const downloadedContent = new TextDecoder().decode(downloadedBytes);

    expect(downloadedContent).toBe(content);
  });

  test("upload → getManifest → downloadFiles with multiple files", async () => {
    const ipfsClient = new MockIpfsClient();
    const module = createIpfsStorageModule({ ipfsClient });

    // Upload multiple files
    const files = [
      await createFileInput("File A content", "/a.txt"),
      await createFileInput("File B content", "/b.txt"),
      await createFileInput("File C content", "/c.txt"),
    ];

    const result = await module.uploadBatch(asAsyncIterable(files), {
      manifestKey,
      batch_id,
    });

    // Get manifest
    const manifest = await module.getManifest(result.cid, {
      manifestKey,
    });

    expect(manifest.files).toHaveLength(3);

    // Download all files
    const fileRefs = manifest.files.map((f) => ({
      batchCid: manifest.cid,
      path: f.path,
      size: f.size,
      contentHash: f.contentHash,
      chunks: f.chunks,
    }));

    const downloadedFiles: Array<{ path: string; content: string }> = [];
    for await (
      const downloaded of module.downloadFiles(fileRefs, { manifestKey })
    ) {
      const bytes = await collectBytes(downloaded.content);
      downloadedFiles.push({
        path: downloaded.path,
        content: new TextDecoder().decode(bytes),
      });
    }

    expect(downloadedFiles).toHaveLength(3);
    expect(downloadedFiles.find((f) => f.path === "/a.txt")?.content).toBe(
      "File A content",
    );
    expect(downloadedFiles.find((f) => f.path === "/b.txt")?.content).toBe(
      "File B content",
    );
    expect(downloadedFiles.find((f) => f.path === "/c.txt")?.content).toBe(
      "File C content",
    );
  });

  test("module methods work with AbortSignal", async () => {
    const ipfsClient = new MockIpfsClient();
    const module = createIpfsStorageModule({ ipfsClient });

    const file = await createFileInput("test content", "/test.txt");

    // Upload with signal (not aborted)
    const controller = new AbortController();
    const result = await module.uploadBatch(asAsyncIterable([file]), {
      manifestKey,
      batch_id,
      signal: controller.signal,
    });

    expect(result.cid).toBeDefined();

    // Get manifest with signal (not aborted)
    const manifest = await module.getManifest(result.cid, {
      manifestKey,
      signal: controller.signal,
    });

    expect(manifest.cid).toBe(result.cid);
  });
});

import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createStreamingFileInput,
  createTestBatchId,
  createTestClient,
  createTestManifestKey,
} from "./setup.ts";
import { asAsyncIterable, createIpfsStorageModule } from "../src/index.ts";
import type { BatchManifest, FileDownloadRef } from "../src/types.ts";

const client = createTestClient();
const module = createIpfsStorageModule({ ipfsClient: client });

function buildFileRef(manifest: BatchManifest, path: string): FileDownloadRef {
  const fileInfo = manifest.files.find((file) => file.path === path);
  if (!fileInfo) throw new Error(`File not found: ${path}`);
  return {
    batchCid: manifest.cid,
    path: fileInfo.path,
    size: fileInfo.size,
    contentHash: fileInfo.contentHash,
    chunks: fileInfo.chunks,
  };
}

// crypto.randomUUID is available in Deno
const randomBytes = (size: number) => {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
  }
  return bytes;
};

describe("E2E Large File Upload", () => {
  // Test file larger than the 16 MiB chunk threshold
  test("upload and download a 17 MiB file (chunked)", async () => {
    const size = 17 * 1024 * 1024;
    const content = randomBytes(size); // Random content

    const file = await createStreamingFileInput(content, "/large.bin");

    const manifestKey = createTestManifestKey(10);
    const batch_id = createTestBatchId(10);

    console.log(`Uploading ${size} bytes...`);
    const result = await module.uploadBatch(asAsyncIterable([file]), {
      manifestKey,
      batch_id,
    });

    console.log("Upload complete, checking manifest...");
    const manifest = await module.getManifest(result.cid, {
      manifestKey,
    });

    expect(manifest.files[0]!.chunks.length).toBeGreaterThan(1); // Should be split

    console.log("Downloading...");
    const downloadRef = buildFileRef(manifest, "/large.bin");

    const chunks: Uint8Array[] = [];
    for await (
      const chunk of module.downloadFile(downloadRef, { manifestKey })
    ) {
      chunks.push(chunk);
    }

    const totalDownloaded = chunks.reduce((acc, c) => acc + c.length, 0);
    expect(totalDownloaded).toBe(size);

    // Verify a few random bytes to ensure integrity
    const downloaded = new Uint8Array(totalDownloaded);
    let offset = 0;
    for (const chunk of chunks) {
      downloaded.set(chunk, offset);
      offset += chunk.length;
    }

    expect(downloaded[0]).toBe(content[0]);
    expect(downloaded[size - 1]).toBe(content[size - 1]);
    expect(downloaded[Math.floor(size / 2)]).toBe(
      content[Math.floor(size / 2)],
    );
  });

  test("downloads over 100 MiB to a WritableStream without collecting output", async () => {
    const size = 101 * 1024 * 1024;
    const content = new Uint8Array(size);
    for (let i = 0; i < content.length; i++) {
      content[i] = i % 251;
    }

    const file = await createStreamingFileInput(content, "/huge.bin");
    const manifestKey = createTestManifestKey(11);
    const batch_id = createTestBatchId(11);

    const result = await module.uploadBatch(asAsyncIterable([file]), {
      manifestKey,
      batch_id,
    });
    const manifest = await module.getManifest(result.cid, { manifestKey });
    const downloadRef = buildFileRef(manifest, "/huge.bin");

    let bytesWritten = 0;
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        for (let i = 0; i < chunk.length; i++) {
          expect(chunk[i]).toBe((bytesWritten + i) % 251);
        }
        bytesWritten += chunk.length;
      },
    });

    await module.downloadFile(downloadRef, {
      manifestKey,
      chunkConcurrency: 1,
      output,
    });

    expect(bytesWritten).toBe(size);
  });
});

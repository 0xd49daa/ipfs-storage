import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type ContentHash,
  hashBlake2b,
  preloadSodium,
  type SymmetricKey,
} from "@0xd49daa/safecrypt";
import { asAsyncIterable } from "./async-iterable.ts";
import { MockIpfsClient } from "./ipfs-client.ts";
import { uploadBatch } from "./streaming-upload.ts";
import { ValidationError } from "./errors.ts";
import type { StreamingFileInput } from "./types.ts";

const manifestKey = new Uint8Array(32).fill(1) as SymmetricKey;
const batch_id = new Uint8Array(16).fill(2);

beforeAll(async () => {
  await preloadSodium();
});

async function createFileInput(): Promise<StreamingFileInput> {
  const bytes = new TextEncoder().encode("test");
  return {
    path: "/test.txt",
    contentHash: (await hashBlake2b(bytes, 32)) as ContentHash,
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

describe("symmetric API validation", () => {
  test("upload rejects missing manifestKey", async () => {
    await expect(
      uploadBatch(
        asAsyncIterable([await createFileInput()]),
        { batch_id } as any,
        new MockIpfsClient(),
      ),
    ).rejects.toThrow(ValidationError);
  });

  test("upload rejects missing batch_id", async () => {
    await expect(
      uploadBatch(
        asAsyncIterable([await createFileInput()]),
        { manifestKey } as any,
        new MockIpfsClient(),
      ),
    ).rejects.toThrow(ValidationError);
  });

  test("upload rejects non-32-byte manifestKey", async () => {
    await expect(
      uploadBatch(
        asAsyncIterable([await createFileInput()]),
        { manifestKey: new Uint8Array(31), batch_id } as any,
        new MockIpfsClient(),
      ),
    ).rejects.toThrow("manifestKey must be 32 bytes");
  });

  test("upload rejects non-16-byte batch_id", async () => {
    await expect(
      uploadBatch(
        asAsyncIterable([await createFileInput()]),
        { manifestKey, batch_id: new Uint8Array(15) },
        new MockIpfsClient(),
      ),
    ).rejects.toThrow("batch_id must be 16 bytes");
  });
});

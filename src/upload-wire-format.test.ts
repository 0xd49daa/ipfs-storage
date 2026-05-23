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
import { CHUNK_SIZE } from "./constants.ts";
import { padme } from "./padme.ts";
import type { StreamingFileInput } from "./types.ts";
import {
  VAULT_AEAD_VERSION,
  VAULT_AEAD_NONCE_SIZE,
  VAULT_AEAD_TAG_SIZE,
  VAULT_BATCH_ID_SIZE,
  VAULT_KEY_SCOPE_CHUNK,
  VAULT_KEY_SCOPE_MANIFEST,
} from "./vault-aead.ts";

const manifestKey = new Uint8Array(32).fill(0x11) as SymmetricKey;
const VAULT_RECORD_OVERHEAD = 2 + VAULT_AEAD_NONCE_SIZE + VAULT_AEAD_TAG_SIZE;

beforeAll(async () => {
  await preloadSodium();
});

function rangeBytes(length: number, start: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (start + i) & 0xff;
  }
  return bytes;
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

async function createFileInput(
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

function createEmptyFileInput(
  path: string,
  emptyHash: ContentHash,
): StreamingFileInput {
  return {
    path,
    contentHash: emptyHash,
    size: 0,
    getStream: () =>
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
  };
}

describe("Phase 3 upload wire format", () => {
  test("emits Vault AEAD chunk records and a prefixed root manifest", async () => {
    const ipfsClient = new MockIpfsClient();
    const batch_id = rangeBytes(VAULT_BATCH_ID_SIZE, 0x80);
    const file = await createFileInput(
      new TextEncoder().encode("hello vault"),
      "/hello.txt",
    );

    const result = await uploadBatch(
      asAsyncIterable([file]),
      { manifestKey, batch_id },
      ipfsClient,
    );

    const rootBlob = await collectBytes(ipfsClient.cat(result.cid, "/m"));
    expect(rootBlob.slice(0, VAULT_BATCH_ID_SIZE)).toHaveLength(16);
    expect(rootBlob.slice(0, VAULT_BATCH_ID_SIZE)).toEqual(batch_id);
    expect(rootBlob[VAULT_BATCH_ID_SIZE]).toBe(VAULT_AEAD_VERSION);
    expect(rootBlob[VAULT_BATCH_ID_SIZE + 1]).toBe(
      VAULT_KEY_SCOPE_MANIFEST,
    );

    const chunkRef = result.manifest.files[0]!.chunks[0]!;
    const chunkBytes = ipfsClient.getBlock(chunkRef.cid)!;
    expect(chunkBytes[0]).toBe(VAULT_AEAD_VERSION);
    expect(chunkBytes[1]).toBe(VAULT_KEY_SCOPE_CHUNK);
  });

  test("PADME-pads chunk plaintext before encryption", async () => {
    const ipfsClient = new MockIpfsClient();
    const data = rangeBytes(123, 0x40);
    const file = await createFileInput(data, "/padded-chunk.bin");

    const result = await uploadBatch(
      asAsyncIterable([file]),
      { manifestKey, batch_id: rangeBytes(VAULT_BATCH_ID_SIZE, 0x90) },
      ipfsClient,
    );

    const chunkRef = result.manifest.files[0]!.chunks[0]!;
    expect(chunkRef.length).toBe(data.length);
    expect(chunkRef.encryptedLength).toBe(
      VAULT_RECORD_OVERHEAD + padme(data.length),
    );
  });

  test("PADME-pads large-file final chunk plaintext", async () => {
    const ipfsClient = new MockIpfsClient();
    const data = rangeBytes(CHUNK_SIZE + 123, 0x50);
    const file = await createFileInput(data, "/large-padded.bin");

    const result = await uploadBatch(
      asAsyncIterable([file]),
      { manifestKey, batch_id: rangeBytes(VAULT_BATCH_ID_SIZE, 0x91) },
      ipfsClient,
    );

    const chunks = result.manifest.files[0]!.chunks;
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.length).toBe(123);
    expect(chunks[1]!.encryptedLength).toBe(VAULT_RECORD_OVERHEAD + padme(123));
  });

  test("sub-manifest blobs are pure manifest AEAD records", async () => {
    const ipfsClient = new MockIpfsClient();
    const batch_id = rangeBytes(VAULT_BATCH_ID_SIZE, 0xa0);
    const emptyHash = (await hashBlake2b(new Uint8Array(0), 32)) as ContentHash;
    const longName = "a".repeat(3900);
    const files = Array.from(
      { length: 180 },
      (_, index) =>
        createEmptyFileInput(
          `/${index.toString().padStart(3, "0")}-${longName}.txt`,
          emptyHash,
        ),
    );

    const result = await uploadBatch(
      asAsyncIterable(files),
      { manifestKey, batch_id },
      ipfsClient,
    );

    expect(result.manifestCount).toBeGreaterThan(1);

    const rootBlob = await collectBytes(ipfsClient.cat(result.cid, "/m"));
    expect(rootBlob.slice(0, VAULT_BATCH_ID_SIZE)).toEqual(batch_id);

    const subManifestBlob = await collectBytes(
      ipfsClient.cat(result.cid, "/m_0"),
    );
    expect(subManifestBlob.slice(0, VAULT_BATCH_ID_SIZE)).not.toEqual(
      batch_id,
    );
    expect(subManifestBlob[0]).toBe(VAULT_AEAD_VERSION);
    expect(subManifestBlob[1]).toBe(VAULT_KEY_SCOPE_MANIFEST);
  });

  test("different batch ids produce different chunk ciphertexts", async () => {
    const data = new TextEncoder().encode("same plaintext");
    const fileA = await createFileInput(data, "/same.txt");
    const fileB = await createFileInput(data, "/same.txt");
    const clientA = new MockIpfsClient();
    const clientB = new MockIpfsClient();

    const resultA = await uploadBatch(
      asAsyncIterable([fileA]),
      { manifestKey, batch_id: rangeBytes(VAULT_BATCH_ID_SIZE, 0x10) },
      clientA,
    );
    const resultB = await uploadBatch(
      asAsyncIterable([fileB]),
      { manifestKey, batch_id: rangeBytes(VAULT_BATCH_ID_SIZE, 0x20) },
      clientB,
    );

    const chunkA = clientA.getBlock(resultA.manifest.files[0]!.chunks[0]!.cid)!;
    const chunkB = clientB.getBlock(resultB.manifest.files[0]!.chunks[0]!.cid)!;
    expect(chunkA).not.toEqual(chunkB);
  });

  test("small-file aggregation targets 16 MiB chunks", async () => {
    const ipfsClient = new MockIpfsClient();
    const eightMiB = 8 * 1024 * 1024;
    const first = await createFileInput(
      new Uint8Array(eightMiB).fill(0x01),
      "/first.bin",
    );
    const second = await createFileInput(
      new Uint8Array(eightMiB).fill(0x02),
      "/second.bin",
    );

    const result = await uploadBatch(
      asAsyncIterable([first, second]),
      { manifestKey, batch_id: rangeBytes(VAULT_BATCH_ID_SIZE, 0x30) },
      ipfsClient,
    );

    expect(result.chunkCount).toBe(1);
    expect(result.manifest.files[0]!.chunks[0]!.cid).toBe(
      result.manifest.files[1]!.chunks[0]!.cid,
    );
  });
});

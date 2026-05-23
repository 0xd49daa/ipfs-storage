import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  asAsyncIterable,
  ManifestError,
  MockIpfsClient,
  type StreamingFileInput,
  ValidationError,
} from "./index.ts";
import {
  getBatchIdFromManifestBlob,
  getManifest,
} from "./manifest-retrieval.ts";
import { uploadBatch } from "./streaming-upload.ts";
import { padManifestPlaintext } from "./manifest-padding.ts";
import { RootManifestSchema } from "./gen/manifest_pb.ts";
import { MANIFEST_VERSION_SUPPORTED } from "./constants.ts";
import {
  encryptVaultManifestRecord,
  VAULT_BATCH_ID_SIZE,
} from "./vault-aead.ts";
import { hashContent, type SymmetricKey } from "./crypto-primitives.ts";

const manifestKey = new Uint8Array(32).fill(1) as SymmetricKey;
const batch_id = new Uint8Array(16).fill(2);

async function createFileInput(
  content: string,
  path: string,
): Promise<StreamingFileInput> {
  const bytes = new TextEncoder().encode(content);
  return {
    path,
    contentHash: await hashContent(bytes),
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

function createRootManifestBlob(batchId: Uint8Array, record: Uint8Array) {
  const blob = new Uint8Array(batchId.length + record.length);
  blob.set(batchId, 0);
  blob.set(record, batchId.length);
  return blob;
}

describe("getBatchIdFromManifestBlob", () => {
  test("returns exactly the first 16 bytes", () => {
    const blob = new Uint8Array(32);
    for (let i = 0; i < blob.length; i++) blob[i] = i;

    expect(getBatchIdFromManifestBlob(blob)).toEqual(
      blob.slice(0, VAULT_BATCH_ID_SIZE),
    );
  });

  test("rejects too-short blobs", () => {
    expect(() => getBatchIdFromManifestBlob(new Uint8Array(15))).toThrow(
      ValidationError,
    );
    expect(() => getBatchIdFromManifestBlob(new Uint8Array(15))).toThrow(
      "Root manifest blob too short",
    );
  });
});

describe("getManifest", () => {
  test("retrieves and decrypts manifest with manifestKey", async () => {
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput("Hello, World!", "/hello.txt");
    const result = await uploadBatch(
      asAsyncIterable([file]),
      { manifestKey, batch_id },
      ipfsClient,
    );

    const manifest = await getManifest(result.cid, { ipfsClient, manifestKey });

    expect(manifest.cid).toBe(result.cid);
    expect(manifest.manifestVersion).toBe(MANIFEST_VERSION_SUPPORTED);
    expect("manifestKey" in manifest).toBe(false);
    expect("senderPublicKey" in manifest).toBe(false);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]!.path).toBe("/hello.txt");
  });

  test("throws ValidationError for empty batchCid", async () => {
    const ipfsClient = new MockIpfsClient();

    await expect(getManifest("", { ipfsClient, manifestKey })).rejects.toThrow(
      ValidationError,
    );
    await expect(getManifest("", { ipfsClient, manifestKey })).rejects.toThrow(
      "batchCid must be a non-empty string",
    );
  });

  test("throws ValidationError for missing manifestKey", async () => {
    const ipfsClient = new MockIpfsClient();

    await expect(
      getManifest("bafytest", { ipfsClient } as any),
    ).rejects.toThrow(ValidationError);
    await expect(
      getManifest("bafytest", { ipfsClient } as any),
    ).rejects.toThrow("manifestKey is required");
  });

  test("throws ValidationError for non-32-byte manifestKey", async () => {
    const ipfsClient = new MockIpfsClient();
    const invalidKey = new Uint8Array(31) as SymmetricKey;

    await expect(
      getManifest("bafytest", { ipfsClient, manifestKey: invalidKey }),
    ).rejects.toThrow(ValidationError);
    await expect(
      getManifest("bafytest", { ipfsClient, manifestKey: invalidKey }),
    ).rejects.toThrow("manifestKey must be 32 bytes");
  });

  test("wrong manifestKey fails with ManifestError", async () => {
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput("secret", "/secret.txt");
    const result = await uploadBatch(
      asAsyncIterable([file]),
      { manifestKey, batch_id },
      ipfsClient,
    );
    const wrongKey = new Uint8Array(32).fill(9) as SymmetricKey;

    await expect(
      getManifest(result.cid, { ipfsClient, manifestKey: wrongKey }),
    ).rejects.toThrow(ManifestError);
  });

  test("decrypts paginated sub-manifests", async () => {
    const ipfsClient = new MockIpfsClient();
    const longName = "a".repeat(3900);
    const files = await Promise.all(
      Array.from({ length: 180 }, (_, index) =>
        createFileInput(
          "",
          `/${index.toString().padStart(3, "0")}-${longName}.txt`,
        )),
    );
    const result = await uploadBatch(
      asAsyncIterable(files),
      { manifestKey, batch_id },
      ipfsClient,
    );

    expect(result.manifestCount).toBeGreaterThan(1);

    const manifest = await getManifest(result.cid, { ipfsClient, manifestKey });
    expect(manifest.files).toHaveLength(files.length);
  });

  test("unsupported manifest version fails with ManifestError", async () => {
    const root = create(RootManifestSchema, {
      manifestVersion: MANIFEST_VERSION_SUPPORTED + 1,
      directories: [],
      files: [],
      subManifests: [],
      created: 1700000000000n,
    });
    const rootBytes = toBinary(RootManifestSchema, root);
    const encrypted = await encryptVaultManifestRecord({
      plaintext: padManifestPlaintext(rootBytes),
      manifestKey,
      batchId: batch_id,
      manifestNodeId: 0,
    });
    const rootBlob = createRootManifestBlob(batch_id, encrypted);
    const ipfsClient = {
      uploadCar: async () => "unused",
      has: async () => true,
      async *cat() {
        yield rootBlob;
      },
    };

    await expect(
      getManifest("bafytest", { ipfsClient, manifestKey }),
    ).rejects.toThrow(ManifestError);
    await expect(
      getManifest("bafytest", { ipfsClient, manifestKey }),
    ).rejects.toThrow(/Unsupported manifest version/);
  });

  test("tampered root plaintext batch_id prefix fails decrypt", async () => {
    const ipfsClient = new MockIpfsClient();
    const file = await createFileInput("secret", "/secret.txt");
    const result = await uploadBatch(
      asAsyncIterable([file]),
      { manifestKey, batch_id },
      ipfsClient,
    );
    const rootBlob = await collectBytes(ipfsClient.cat(result.cid, "/m"));

    const tampered = rootBlob.slice();
    tampered[0] = tampered[0]! ^ 0x01;
    const tamperedClient = {
      uploadCar: async () => "unused",
      has: async () => true,
      async *cat(_cid: string, path?: string) {
        if (path === "/m") yield tampered;
      },
    };

    await expect(
      getManifest(result.cid, { ipfsClient: tamperedClient, manifestKey }),
    ).rejects.toThrow(ManifestError);
  });
});

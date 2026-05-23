import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  type ContentHash,
  encrypt,
  hashBlake2b,
  preloadSodium,
  type SymmetricKey,
} from "@0xd49daa/safecrypt";
import {
  asAsyncIterable,
  ManifestError,
  MockIpfsClient,
  type StreamingFileInput,
  ValidationError,
} from "./index.ts";
import { getManifest } from "./manifest-retrieval.ts";
import { uploadBatch } from "./streaming-upload.ts";
import { encodeManifestEnvelope } from "./serialization.ts";
import { RootManifestSchema } from "./gen/manifest_pb.ts";
import { MANIFEST_DOMAIN, MANIFEST_VERSION_SUPPORTED } from "./constants.ts";

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
  return {
    path,
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

function combineNonceAndCiphertext(encrypted: {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}): Uint8Array {
  const combined = new Uint8Array(
    encrypted.nonce.length + encrypted.ciphertext.length,
  );
  combined.set(encrypted.nonce, 0);
  combined.set(encrypted.ciphertext, encrypted.nonce.length);
  return combined;
}

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
    expect(manifest.manifestKey).toEqual(manifestKey);
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

  test("unsupported manifest version fails with ManifestError", async () => {
    const root = create(RootManifestSchema, {
      manifestVersion: MANIFEST_VERSION_SUPPORTED + 1,
      directories: [],
      files: [],
      subManifests: [],
      created: 1700000000000n,
    });
    const rootBytes = toBinary(RootManifestSchema, root);
    const encrypted = await encrypt(
      rootBytes,
      manifestKey,
      new TextEncoder().encode(MANIFEST_DOMAIN.ROOT),
    );
    const envelope = encodeManifestEnvelope({
      encryptedManifest: combineNonceAndCiphertext(encrypted),
    });
    const ipfsClient = {
      uploadCar: async () => "unused",
      has: async () => true,
      async *cat() {
        yield envelope;
      },
    };

    await expect(
      getManifest("bafytest", { ipfsClient, manifestKey }),
    ).rejects.toThrow(ManifestError);
    await expect(
      getManifest("bafytest", { ipfsClient, manifestKey }),
    ).rejects.toThrow(/Unsupported manifest version/);
  });
});

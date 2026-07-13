import { describe, it as test } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { asContentHash, hashContent, MANIFEST_VERSION_SUPPORTED } from "./index.ts";

// @ts-expect-error RecipientInfo is intentionally no longer public.
import type { RecipientInfo } from "./index.ts";
// @ts-expect-error X25519 key types are intentionally no longer public.
import type { X25519KeyPair, X25519PublicKey } from "./index.ts";

describe("public API exports", () => {
  test("exports supported manifest version", () => {
    expect(MANIFEST_VERSION_SUPPORTED).toBe(1);
  });

  test("exports content hash helpers", async () => {
    const hash = await hashContent(new Uint8Array([1, 2, 3]));
    expect(hash).toHaveLength(32);
    expect(asContentHash(hash)).toBe(hash);
  });
});

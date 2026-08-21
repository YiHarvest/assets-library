import { describe, expect, it } from "vitest";
import { createLocalId } from "@/lib/local-id";

describe("browser-local IDs", () => {
  it("uses collision-resistant page-local IDs when Web Crypto is unavailable", () => {
    const first = createLocalId(null);
    const second = createLocalId(null);
    expect(first).toMatch(/^local-[0-9a-z]+-[0-9a-z]+$/);
    expect(second).not.toBe(first);
  });

  it("builds an RFC 4122-shaped UUID from getRandomValues", () => {
    const cryptoApi = {
      getRandomValues<T extends ArrayBufferView>(array: T) {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(1);
        return array;
      },
    } as Crypto;

    expect(createLocalId(cryptoApi)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

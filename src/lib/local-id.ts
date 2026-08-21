let fallbackSequence = 0;

/** 生成仅用于浏览器内列表追踪的 ID；该值不会作为服务端资源标识。 */
export function createLocalId(
  cryptoApi: Crypto | undefined | null = globalThis.crypto,
) {
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues !== "function") {
    fallbackSequence += 1;
    return `local-${Date.now().toString(36)}-${fallbackSequence.toString(36)}`;
  }

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

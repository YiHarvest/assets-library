/** 只信任同机Next反向代理；不信任局域网、容器网段或任意X-Forwarded-For。 */
export function trustLoopbackProxy(address: string) {
  return address === "::1"
    || address.startsWith("127.")
    || address.startsWith("::ffff:127.");
}

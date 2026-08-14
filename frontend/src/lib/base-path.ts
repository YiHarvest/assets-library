function normalizeBasePath(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export const PUBLIC_BASE_PATH = normalizeBasePath(
  process.env.NEXT_PUBLIC_BASE_PATH,
);

export function prefixedHref(href: string) {
  if (!PUBLIC_BASE_PATH || !href.startsWith("/")) return href;
  if (href === PUBLIC_BASE_PATH || href.startsWith(`${PUBLIC_BASE_PATH}/`)) {
    return href;
  }
  return `${PUBLIC_BASE_PATH}${href}`;
}

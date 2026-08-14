export function withUserScope(href: string, userId: string | null | undefined) {
  const normalized = userId?.trim();
  if (!normalized) return href;
  const [pathname, rawQuery = ""] = href.split("?", 2);
  const parameters = new URLSearchParams(rawQuery);
  parameters.set("user_id", normalized);
  const query = parameters.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function corsAllowlist(value: string | undefined): false | string[] {
  if (!value) return false;
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean);
  return origins.length ? origins : false;
}

import { apiV1Path } from "@/lib/paths";

interface ApiFailure {
  error?: { message?: string };
}

function internalApiOrigin() {
  const configured = process.env.API_INTERNAL_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  throw new Error("API_INTERNAL_ORIGIN must be configured in the environment.");
}

/** Server Components 也通过稳定 HTTP facade 读取数据，不再直连领域服务。 */
export async function serverApiV1<T>(path: string, init?: RequestInit) {
  const response = await fetch(
    new URL(apiV1Path(path), internalApiOrigin()),
    {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      cache: "no-store",
    },
  );
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw new Error(
      (payload as ApiFailure | null)?.error?.message ??
        `后端请求失败（HTTP ${response.status}）。`,
    );
  }
  return payload as T;
}

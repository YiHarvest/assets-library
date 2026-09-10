import { AssetEditor } from "./asset-editor";
import { serverApiV1 } from "@/lib/server-api-v1";
import { appUrl } from "@/lib/paths";
import type { ApiV1AssetDetail } from "@/shared/contracts";

export const dynamic = "force-dynamic";

export default async function AssetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    scope?: string | string[];
    user_id?: string | string[];
    return_to?: string | string[];
  }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const rawUserId = Array.isArray(query.user_id) ? query.user_id[0] : query.user_id;
  const userId = rawUserId?.trim() || null;
  const rawScope = Array.isArray(query.scope) ? query.scope[0] : query.scope;
  const queryString = rawScope === "private" && userId
    ? `?user_id=${encodeURIComponent(userId)}`
    : "";
  const asset = await serverApiV1<ApiV1AssetDetail>(
    `/assets/${encodeURIComponent(id)}${queryString}`,
  );
  const fallback = new URLSearchParams({
    view: asset.review_status === "published" ? "published" : "pending",
    scope: asset.user_id ? "private" : "public",
  });
  if (asset.user_id) fallback.set("user_id", asset.user_id);
  let returnTo = appUrl(`/?${fallback}`);
  const rawReturnTo = Array.isArray(query.return_to) ? query.return_to[0] : query.return_to;
  if (rawReturnTo) {
    try {
      const target = new URL(rawReturnTo, "http://webui.local");
      if (target.origin === "http://webui.local" && target.pathname === appUrl("/")) {
        returnTo = target.pathname + target.search;
      }
    } catch { /* 无效来源使用当前素材库首页。 */ }
  }
  return (
    <main className="mx-auto max-w-7xl px-5 py-10">
      <AssetEditor initialAsset={asset} returnTo={returnTo} />
    </main>
  );
}

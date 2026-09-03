import { AssetEditor } from "./asset-editor";
import { serverApiV1 } from "@/lib/server-api-v1";
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
  return (
    <main className="mx-auto max-w-7xl px-5 py-10">
      <AssetEditor initialAsset={asset} />
    </main>
  );
}

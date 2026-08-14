import { AssetEditor } from "./asset-editor";
import { serverApi } from "@/lib/server-api";
import type { AssetDetail } from "@/shared/contracts";

export const dynamic = "force-dynamic";

export default async function AssetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ user_id?: string | string[] }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const rawUserId = Array.isArray(query.user_id) ? query.user_id[0] : query.user_id;
  const viewerUserId = rawUserId?.trim().slice(0, 191) ?? "";
  const asset = await serverApi<AssetDetail>(
    `/assets/detail?file_id=${encodeURIComponent(id)}`,
    {
      action: "assets.detail",
      telemetryMetadata: { file_id: id },
    },
  );
  return (
    <main className="mx-auto max-w-7xl px-5 py-10">
      <AssetEditor initialAsset={asset} viewerUserId={viewerUserId} />
    </main>
  );
}

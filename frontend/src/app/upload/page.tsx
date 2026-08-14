import { UploadForm } from "./upload-form";

export default async function UploadPage({
  searchParams,
}: {
  searchParams: Promise<{ user_id?: string | string[] }>;
}) {
  const parameters = await searchParams;
  const rawUserId = Array.isArray(parameters.user_id)
    ? parameters.user_id[0]
    : parameters.user_id;
  return (
    <main className="mx-auto max-w-4xl px-5 py-10">
      <div className="mb-8">
        <p className="mb-2 text-sm font-semibold tracking-wide text-cyan-700">
          NEW ASSET
        </p>
        <h1 className="text-3xl font-bold tracking-tight">上传素材</h1>
        <p className="mt-3 text-slate-600">
          支持一次选择多个本地素材并直传对象存储。系统会按文件扩展名转换图片；
          视频正规化后先自动分镜，每个子视频再提取 1–5 张关键帧独立分析。
          自动入库时任一切片或封面失败，整段父视频都不会入库。
        </p>
      </div>
      <UploadForm initialUserId={rawUserId?.trim().slice(0, 191) ?? ""} />
    </main>
  );
}

import { UploadForm } from "./upload-form";
import { appUrl } from "@/lib/paths";
import { WebUiLink } from "@/components/webui-link";

export default async function UploadPage({
  searchParams,
}: {
  searchParams: Promise<{ user_id?: string | string[]; project_id?: string | string[]; return_to?: string | string[] }>;
}) {
  const parameters = await searchParams;
  const rawUserId = Array.isArray(parameters.user_id)
    ? parameters.user_id[0]
    : parameters.user_id;
  const rawProjectId = Array.isArray(parameters.project_id) ? parameters.project_id[0] : parameters.project_id;
  const rawReturnTo = Array.isArray(parameters.return_to) ? parameters.return_to[0] : parameters.return_to;
  let returnTo = appUrl("/");
  if (rawReturnTo) {
    try {
      const target = new URL(rawReturnTo, "http://webui.local");
      if (target.origin === "http://webui.local" && target.pathname === appUrl("/")) returnTo = target.pathname + target.search;
    } catch { /* 无效来源返回素材库。 */ }
  }
  return (
    <main className="mx-auto max-w-4xl px-5 py-10">
      <div className="mb-8">
        <WebUiLink href={returnTo} className="mb-4 inline-block text-sm text-cyan-700">返回素材库</WebUiLink>
        <p className="mb-2 text-sm font-semibold tracking-wide text-cyan-700">
          NEW ASSET
        </p>
        <h1 className="text-3xl font-bold tracking-tight">上传素材</h1>
        <p className="mt-3 text-slate-600">
          支持一次选择多个本地素材并逐个上传（采用流式传输）。系统会按文件扩展名转换图片；
          视频正规化后先自动分镜，每个子视频再提取 1–5 张关键帧独立分析。
          私人上传会同时生成一份待审核的公共副本，首次分析只执行一次。
        </p>
      </div>
      <UploadForm initialUserId={rawUserId?.trim().slice(0, 191) ?? ""} initialProjectId={rawProjectId ?? ""} returnTo={returnTo} />
    </main>
  );
}

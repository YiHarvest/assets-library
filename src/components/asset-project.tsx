export function AssetProject({ projectId }: { projectId?: string | null }) {
  return (
    <p className="break-all text-xs text-slate-500 dark:text-slate-400">
      项目：<span className="select-all font-mono" title={projectId ? "选中后可复制项目 ID" : undefined}>
        {projectId || "未归属项目"}
      </span>
    </p>
  );
}

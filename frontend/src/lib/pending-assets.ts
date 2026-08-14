import type {
  AssetSummary,
  TaskFile,
  TaskResponse,
} from "@/shared/contracts";

function pendingFile(
  task: TaskResponse,
  file: TaskFile,
  userId: string,
  filePosition: number,
  entryPosition: number,
): AssetSummary {
  return {
    file_id:
      file.file_id ??
      file.video_source_id ??
      `${task.task_id}-${filePosition}-${entryPosition}`,
    file_name: file.file_name,
    ...(file.video_source_id ? { video_source_id: file.video_source_id } : {}),
    user_id: userId || null,
    media_type: file.media_type,
    status: file.status ?? task.status,
    phase: file.phase ?? task.phase,
    description: file.description ?? "",
    tags: file.tags ?? [],
    size_bytes: file.size_bytes ?? 0,
    media_url: file.media_url ?? "",
    cover_url: file.cover_url ?? "",
    error: file.error ?? task.error ?? null,
    created_at: task.created_at,
  };
}

/**
 * 将待处理任务展开成素材卡片。变更任务会重复引用原 file_id，所以同一素材
 * 只保留任务列表中最新的状态；已经入库或过期的文件不再出现在待入库页。
 */
export function pendingFiles(tasks: TaskResponse[], userId: string): AssetSummary[] {
  const seen = new Set<string>();
  const result: AssetSummary[] = [];
  for (const task of tasks) {
    for (const [filePosition, file] of task.files.entries()) {
      const entries = file.slices?.length ? file.slices : [file];
      for (const [entryPosition, entry] of entries.entries()) {
        if (entry.phase === "published" || entry.phase === "expired") continue;
        // pending_review 代表处理已经完成，此时必须已经有可预览的素材记录。
        // 历史版本删除素材后可能遗留 pending_review task_file；这种孤儿项既
        // 无法预览也无法入库，不能继续渲染成可操作卡片。
        if (
          entry.phase === "pending_review" &&
          !entry.media_url &&
          !entry.cover_url
        ) continue;
        const asset = pendingFile(task, entry, userId, filePosition, entryPosition);
        if (seen.has(asset.file_id)) continue;
        seen.add(asset.file_id);
        result.push(asset);
      }
    }
  }
  return result;
}

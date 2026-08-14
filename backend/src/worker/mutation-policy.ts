export function canDeleteOrphanVideoSource(source: { sourceObjectId: string | null; status: string; phase: string }, remainingSlices: number) {
  return remainingSlices === 0 && source.sourceObjectId === null && source.status === "done" && ["published", "expired"].includes(source.phase);
}

/** The old detail editor supports both pre-publication review and published assets. */
export function canEditPersonalAsset(
  asset: { userId: string | null; phase: string },
  userId: string,
) {
  return asset.userId === userId && ["pending_review", "published"].includes(asset.phase);
}

/** Chroma 是可重建的派生索引，删除失败不得回滚或阻断规范数据删除。 */
export async function deleteDerivedIndexBestEffort(operation: () => Promise<unknown>) {
  try {
    await operation();
    return true;
  } catch {
    return false;
  }
}

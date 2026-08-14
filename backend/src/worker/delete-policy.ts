export function requestedDeletionUserId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isFailedProcessingTarget(value: { status: string; phase: string } | null | undefined) {
  return value?.status === "failed" && value.phase === "processing";
}

export function deletionScopeMatches(ownerUserId: string | null, requestedUserId: string | null) {
  return ownerUserId === requestedUserId;
}

export function uniqueObjectIds(ids: Array<string | null | undefined>) {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

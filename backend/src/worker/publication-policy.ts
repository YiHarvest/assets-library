export function canAcquirePublicationLease(asset: { status: string; phase: string; updatedAt: Date }, staleBefore: Date) {
  return (asset.status === "pending_review" && asset.phase === "pending_review") ||
    (asset.status === "running" && asset.phase === "processing" && asset.updatedAt < staleBefore);
}

export function publicationLeaseDisposition(asset: { status: string; phase: string; updatedAt: Date }, staleBefore: Date) {
  if (asset.status === "done" && asset.phase === "published") return "already_published" as const;
  return canAcquirePublicationLease(asset, staleBefore) ? "acquire" as const : "busy" as const;
}

export function shouldDeleteCompensatingObject(permanentReferenceExists: boolean) {
  return !permanentReferenceExists;
}

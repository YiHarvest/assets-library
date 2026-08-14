export function isRetryableProcessingState(value: { status: string; phase: string } | null | undefined) {
  return value?.status === "failed" && value.phase === "processing";
}

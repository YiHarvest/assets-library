export type TelemetryValue = string | number | boolean | null;
export type TelemetryMetadata = Record<string, TelemetryValue | undefined>;
export type TelemetryStatus = "started" | "done" | "failed";

export interface TelemetryEvent {
  operation_id: string;
  event: string;
  step: string;
  duration_ms: number;
  status: TelemetryStatus;
  metadata?: Record<string, TelemetryValue>;
}

const ALLOWED_METADATA = new Set([
  "action",
  "endpoint",
  "method",
  "status_code",
  "status",
  "phase",
  "previous_status",
  "previous_phase",
  "task_type",
  "task_id",
  "file_id",
  "video_source_id",
  "file_count",
  "file_position",
  "media_type",
  "auto_publish",
  "user_scope",
  "view",
  "progress_percent",
  "error_type",
]);

export function createOperationId() {
  return globalThis.crypto.randomUUID();
}

export function elapsedMilliseconds(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export function safeEndpoint(path: string) {
  return path.split("?", 1)[0]!.slice(0, 500);
}

export function telemetryEvent(input: {
  operationId: string;
  event: string;
  step: string;
  durationMs?: number;
  status: TelemetryStatus;
  metadata?: TelemetryMetadata;
}): TelemetryEvent {
  const metadata = Object.fromEntries(
    Object.entries(input.metadata ?? {})
      .filter(
        ([key, value]) =>
          ALLOWED_METADATA.has(key) &&
          value !== undefined &&
          (value === null || ["string", "number", "boolean"].includes(typeof value)),
      )
      .slice(0, 20)
      .map(([key, value]) => [
        key.slice(0, 64),
        typeof value === "string" ? value.slice(0, 500) : (value as TelemetryValue),
      ]),
  );
  return {
    operation_id: input.operationId.slice(0, 128),
    event: input.event.slice(0, 128),
    step: input.step.slice(0, 128),
    duration_ms: Math.min(86_400_000, Math.max(0, Math.round(input.durationMs ?? 0))),
    status: input.status,
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}

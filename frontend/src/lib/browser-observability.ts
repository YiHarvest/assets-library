import { PUBLIC_BASE_PATH } from "@/lib/base-path";
import {
  telemetryEvent,
  type TelemetryMetadata,
  type TelemetryStatus,
} from "@/lib/observability-core";

export async function reportBrowserEvent(input: {
  operationId: string;
  event: string;
  step: string;
  durationMs?: number;
  status: TelemetryStatus;
  metadata?: TelemetryMetadata;
}) {
  try {
    await fetch(`${PUBLIC_BASE_PATH}/api/v1/observability/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-operation-id": input.operationId,
      },
      body: JSON.stringify(telemetryEvent(input)),
      cache: "no-store",
      credentials: "omit",
      keepalive: true,
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // Telemetry must never change the user-facing operation result.
  }
}

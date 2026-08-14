import "server-only";
import {
  telemetryEvent,
  type TelemetryMetadata,
  type TelemetryStatus,
} from "@/lib/observability-core";

function observabilityEndpoint() {
  const origin = process.env.BACKEND_URL?.trim() || "http://127.0.0.1:23017";
  return `${origin.replace(/\/+$/, "")}/api/v1/observability/events`;
}

export async function reportServerEvent(input: {
  operationId: string;
  event: string;
  step: string;
  durationMs?: number;
  status: TelemetryStatus;
  metadata?: TelemetryMetadata;
}) {
  try {
    await fetch(observabilityEndpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-operation-id": input.operationId,
      },
      body: JSON.stringify(telemetryEvent(input)),
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // Rendering and data access must not depend on telemetry availability.
  }
}

interface ApiFailurePayload {
  error?: { message?: unknown };
}

export interface DecodedApiResponse {
  payload: unknown;
  invalidJson: boolean;
}

export async function decodeApiResponse(
  response: Pick<Response, "status" | "text">,
): Promise<DecodedApiResponse> {
  if (response.status === 204) return { payload: null, invalidJson: false };
  const text = await response.text();
  if (!text.trim()) return { payload: null, invalidJson: true };
  try {
    return { payload: JSON.parse(text), invalidJson: false };
  } catch {
    return { payload: text, invalidJson: true };
  }
}

export function apiFailureMessage(
  payload: unknown,
  status: number,
  invalidJson: boolean,
) {
  if (!invalidJson && payload && typeof payload === "object") {
    const message = (payload as ApiFailurePayload).error?.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (status >= 500) return `后端服务暂时不可用，请稍后重试（HTTP ${status}）。`;
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  return `操作失败（HTTP ${status}）。`;
}

/** 从调用异常、API 错误响应或日志上下文中提取可直接阅读的原因。 */
export function errorSummary(value: unknown, depth = 0): string {
  if (!value || depth > 4) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  if (row.error) return errorSummary(row.error, depth + 1);
  const message = typeof row.message === "string" ? row.message : typeof row.error_message === "string" ? row.error_message : "";
  const code = typeof row.code === "string" ? row.code : typeof row.error_code === "string" ? row.error_code : "";
  return [code, message].filter(Boolean).join(" · ");
}

const auditEventLabels: Record<string, string> = {
  api_request_started: "API 请求开始", api_response_opened: "API 已生成响应",
  api_request_completed: "API 响应发送完成", api_request_failed: "API 请求失败",
  api_request_cancelled: "API 请求已取消", api_response_stream_failed: "API 响应传输失败",
  upload_lease_acquired: "已获取文件上传租约", upload_stream_started: "开始接收上传文件",
  upload_stream_progress: "文件上传进度更新", upload_stream_completed: "文件接收完成",
  upload_stream_failed: "文件上传失败", upload_lease_released_after_failure: "上传失败后已释放租约",
  worker_job_started: "worker 开始执行作业", worker_job_dispatch_finished: "worker 作业执行返回",
  worker_job_dispatch_failed: "worker 作业执行失败", worker_job_heartbeat_failed: "worker 租约续期失败",
  worker_upload_failed: "文件处理失败", worker_analysis_failed: "素材分析失败",
  task_terminal_failed: "任务处理失败", task_terminal_done: "任务处理完成", asset_recall: "素材召回完成",
  elasticsearch_request_failed: "Elasticsearch 请求失败", vlm_response_parse_failed: "模型响应解析失败",
  vlm_extract_chat_text_failed: "模型聊天响应提取失败", vlm_extract_responses_text_failed: "模型响应文本提取失败",
};

export function auditEventMessage(event: string, fields: Record<string, unknown>) {
  const label = auditEventLabels[event] ?? event;
  return typeof fields.error_message === "string" ? `${label}：${fields.error_message}` : `${label}。`;
}

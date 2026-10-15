import { AlertCircle, CheckCircle2, Clock3, LoaderCircle } from "lucide-react";
import { taskPhaseLabels, taskStatusLabels } from "@/shared/monitor-contracts";
import { errorSummary } from "@/shared/log-message";

export const panelClass = "rounded-[1.5rem] border border-black/[0.06] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03),0_8px_24px_rgba(0,0,0,0.03)] dark:border-white/[0.10] dark:bg-[#1c1c1e]";
export const selectClass = "h-11 min-w-0 rounded-full border border-black/[0.08] bg-white/85 px-4 text-sm outline-none focus:ring-4 focus:ring-blue-500/10 dark:border-white/[0.12] dark:bg-white/[0.10]";

export function Status({ value }: { value: string }) {
  const colors = { queued: "bg-black/5 text-slate-600 dark:bg-white/10", running: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300", done: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300", failed: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300" };
  const Icon = value === "failed" ? AlertCircle : value === "done" ? CheckCircle2 : value === "running" ? LoaderCircle : Clock3;
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${colors[value as keyof typeof colors] ?? colors.queued}`}><Icon size={12} />{taskStatusLabels[value as keyof typeof taskStatusLabels] ?? value}</span>;
}

export function ProgressBar({ value, status, className = "w-full" }: { value: number; status?: string | null; className?: string }) {
  const progress = Math.max(0, Math.min(100, value));
  return <div role="progressbar" aria-label="任务进度" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} className={`h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/10 ${className}`}><div className={`h-full rounded-full ${status === "failed" ? "bg-red-500" : status === "done" ? "bg-emerald-500" : "bg-[#0071e3]"}`} style={{ width: `${progress}%` }} /></div>;
}

export interface LogEntry {
  id: number;
  level: "info" | "warn" | "error";
  message: string;
  data: unknown;
  created_at: string;
  phase?: string;
}

export function LogTimeline({ logs, label }: { logs: LogEntry[]; label: string }) {
  return <ol aria-label={label} className={`${panelClass} max-h-[560px] overflow-auto px-4 sm:px-5`}>
    {!logs.length && <li className="py-12 text-center text-sm text-slate-500">暂无符合条件的日志</li>}
    {logs.map((log) => {
      const reason = log.level === "info" ? "" : errorSummary(log.data);
      return <li key={log.id} className="relative border-b py-4 pl-5 last:border-0 dark:border-white/10">
        <span className={`absolute left-0 top-6 size-1.5 rounded-full ${log.level === "error" ? "bg-red-500" : log.level === "warn" ? "bg-amber-500" : "bg-[#0071e3]"}`} />
        <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
          <time className="font-mono">{new Date(log.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}.{String(new Date(log.created_at).getMilliseconds()).padStart(3, "0")}</time>
          <span className={`font-semibold ${log.level === "error" ? "text-red-600 dark:text-red-400" : log.level === "warn" ? "text-amber-700 dark:text-amber-400" : "text-blue-600 dark:text-blue-400"}`}>{log.level.toUpperCase()}</span>
          {log.phase && <span>{taskPhaseLabels[log.phase] ?? log.phase}</span>}
        </div>
        <p className="break-words text-sm leading-6">{log.message}</p>
        {reason && !log.message.includes(reason) && <p className="mt-2 break-words rounded-lg bg-red-50 p-3 text-xs leading-5 text-red-700 dark:bg-red-950 dark:text-red-300">{reason}</p>}
        {log.data != null && <details className="mt-2 text-xs text-slate-500"><summary className="w-fit cursor-pointer hover:text-blue-600">上下文</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-slate-50 p-3 font-mono leading-5">{JSON.stringify(log.data, null, 2)}</pre></details>}
      </li>;
    })}
  </ol>;
}

"use client";

import { WebUiLink as Link } from "@/components/webui-link";
import { appUrl } from "@/lib/paths";
import { useEffect, useRef, useState } from "react";
import { Download, Pause, Play, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JsonView } from "@/components/json-view";
import { apiV1 } from "@/lib/api-v1-client";
import { callKindLabels, callQuerySchema, type CallDetail, type CallList, type CallRecord } from "@/shared/call-contracts";
import { taskPhaseLabels, taskStatusLabels, type TaskLogPage } from "@/shared/monitor-contracts";

import { LogTimeline, Status, ProgressBar, panelClass as panel, selectClass, type LogEntry } from "./monitor-ui";
import { errorSummary } from "@/shared/log-message";
import { FailureToast, useFailureAlerts } from "./failure-alerts";
const colors = { api: "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300", function: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300", match: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300" };
function time(value: string) { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }
function elapsed(call: CallRecord) {
  const ms = call.duration_ms ?? Math.max(0, Date.now() - Date.parse(call.started_at));
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function CallMonitor({ initialSpanId, initialTaskId }: { initialSpanId: string | null; initialTaskId: string | null }) {
  const [list, setList] = useState<CallList | null>(null);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [taskId, setTaskId] = useState(initialTaskId ?? "");
  const [traceId, setTraceId] = useState("");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({ task_id: initialTaskId ?? "", trace_id: "", q: "" });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(initialSpanId);
  const [live, setLive] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const alerts = useFailureAlerts("调用");
  const { observe } = alerts;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const params = new URLSearchParams({ page: String(page), limit: "30" });
        for (const [key, value] of Object.entries({ kind, status, ...filters })) if (value) params.set(key, value);
        const next = await apiV1<CallList>(`/monitor/calls?${params}`, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setList(next); setError(""); setUpdatedAt(new Date().toISOString());
          observe(params.toString(), next.items.filter((call) => call.status === "failed").map((call) => ({
            id: call.id, title: call.name,
            description: `${callKindLabels[call.kind]}${call.status_code ? ` · HTTP ${call.status_code}` : ""}`,
            occurredAt: call.finished_at,
          })));
        }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "调用列表读取失败。"); }
      finally { if (live && !controller.signal.aborted) timer = setTimeout(poll, 2000); }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [kind, status, filters, page, live, refresh, observe]);

  function search(event: React.FormEvent) {
    event.preventDefault();
    const values = { task_id: taskId.trim(), trace_id: traceId.trim(), q: query.trim() };
    const parsed = callQuerySchema.safeParse(Object.fromEntries(Object.entries(values).filter(([, value]) => value)));
    if (!parsed.success) { setError("Task ID 和 Trace ID 需为完整 UUID；名称最多 200 字符。"); return; }
    setFilters(values); setPage(1);
  }
  function select(id: string | null) {
    setSelected(id);
    window.history.replaceState(null, "", appUrl(id ? `/monitor?span_id=${id}` : "/monitor"));
  }
  function showTrace(id: string) {
    setTraceId(id); setTaskId(""); setQuery(""); setKind(""); setStatus(""); setPage(1);
    setFilters({ trace_id: id, task_id: "", q: "" }); select(null);
  }
  const notification = <FailureToast notice={alerts.notice} onDismiss={alerts.dismiss} onInspect={select} soundMuted={alerts.soundMuted} soundState={alerts.soundState} onToggleSound={alerts.toggleSound} />;

  return <main className="mx-auto max-w-7xl space-y-5 px-5 py-7 sm:py-9">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">统一调用监控</h1><p className="mt-2 text-sm text-slate-500">从请求到处理结果，查看每一步的状态、参数与执行日志。</p></div>
      <div className="flex gap-2"><Button variant="outline" onClick={() => setLive(!live)}>{live ? <Pause size={15} /> : <Play size={15} />}{live ? "暂停刷新" : "自动刷新"}</Button><Button variant="outline" onClick={() => setRefresh((n) => n + 1)}><RefreshCw size={15} />刷新</Button></div>
    </header>
    <div className="flex flex-wrap items-center gap-2 rounded-[1.5rem] border border-black/[0.06] bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.06]" aria-label="调用类型筛选">
      {[["", "全部调用"], ...Object.entries(callKindLabels)].map(([value, label]) => <Button key={value} size="sm" variant={kind === value ? "default" : "ghost"} aria-pressed={kind === value} onClick={() => { setKind(value); setPage(1); }}>{label}</Button>)}
      <p className="ml-auto text-xs text-slate-500">{live ? "每 2 秒刷新" : "已暂停"}{updatedAt && ` · ${time(updatedAt)}`}</p>
    </div>
    <form className={`${panel} flex flex-wrap gap-3 p-4`} onSubmit={search}>
      <select aria-label="调用状态" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} className={selectClass}><option value="">所有状态</option>{["running", "done", "failed"].map((value) => <option key={value} value={value}>{taskStatusLabels[value as CallRecord["status"]]}</option>)}</select>
      <Input aria-label="调用名称" placeholder="API 路径 / 函数名称" value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-48 flex-1" />
      <Input aria-label="关联 Task ID" placeholder="关联 task_id" value={taskId} onChange={(event) => setTaskId(event.target.value)} className="min-w-48 flex-1" />
      <Input aria-label="Trace ID" placeholder="trace_id" value={traceId} onChange={(event) => setTraceId(event.target.value)} className="min-w-48 flex-1" />
      <Button type="submit" variant="outline"><Search size={15} />查询</Button>
      <Button type="button" variant="ghost" onClick={() => { setTaskId(""); setTraceId(""); setQuery(""); setKind(""); setStatus(""); setFilters({ task_id: "", trace_id: "", q: "" }); setPage(1); }}>重置</Button>
    </form>
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
    <section className={`${panel} overflow-hidden`}>
      <div className="flex justify-between gap-4 border-b p-4"><h2 className="font-semibold">调用记录</h2><span className="text-xs text-slate-500">共 {list?.total ?? "—"} 条 · 按开始时间倒序</span></div>
      <div className="max-h-[720px] overflow-auto"><table aria-label="统一调用列表" className="w-full min-w-[1060px] text-left text-sm">
        <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500"><tr>{["类型", "调用 / ID", "调用状态", "HTTP", "耗时", "任务结果 / 进度", "开始时间", "操作"].map((label) => <th className="whitespace-nowrap px-4 py-3 font-medium" key={label}>{label}</th>)}</tr></thead>
        <tbody>
          {!list && <tr><td colSpan={8} className="p-12 text-center text-slate-500">{error ? "暂时无法获取调用" : "正在加载调用…"}</td></tr>}
          {list?.items.length === 0 && <tr><td colSpan={8} className="p-12 text-center text-slate-500">暂无符合条件的调用。调用业务 API 或已接入的函数后，记录会出现在这里。</td></tr>}
          {list?.items.map((call) => <tr key={call.id} className="border-t hover:bg-slate-50">
            <td className="px-4 py-4"><span className={`rounded-md px-2 py-1 text-xs font-medium ${colors[call.kind]}`}>{callKindLabels[call.kind]}</span></td>
            <td className="max-w-96 px-4 py-4"><p className="break-all font-medium">{call.name}</p><p className="mt-1 font-mono text-[10px] text-slate-400">{call.id}</p></td>
            <td className="px-4 py-4"><Status value={call.status} /></td><td className="px-4 py-4 font-mono text-xs">{call.status_code ?? "—"}</td><td className="whitespace-nowrap px-4 py-4 font-mono text-xs">{elapsed(call)}</td>
            <td className="min-w-56 px-4 py-4">{call.task_id ? <><div className="mb-2">{call.task_status && <Status value={call.task_status} />}</div><Link className="break-all font-mono text-[10px] text-blue-600 hover:underline" href={appUrl(`/monitor?task_id=${call.task_id}`)}>{call.task_id}</Link>{call.task_progress !== null && <div className="mt-2 flex items-center gap-2"><ProgressBar className="w-20" value={call.task_progress} status={call.task_status} /><span className="text-xs text-slate-500">{call.task_progress}% · {taskPhaseLabels[call.task_phase ?? ""] ?? call.task_phase}</span></div>}</> : <span className="text-xs text-slate-400">独立调用</span>}</td>
            <td className="whitespace-nowrap px-4 py-4 text-xs text-slate-500">{time(call.started_at)}</td><td className="px-4 py-4"><Button size="sm" variant="outline" onClick={() => select(call.id)}>查看调用</Button></td>
          </tr>)}
        </tbody>
      </table></div>
      <div className="flex items-center justify-between border-t p-3"><Button size="sm" variant="ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</Button><span className="text-xs text-slate-500">第 {page} 页</span><Button size="sm" variant="ghost" disabled={!list?.has_more} onClick={() => setPage(page + 1)}>下一页</Button></div>
    </section>
    <p className="text-xs leading-5 text-slate-400">调用状态表示本次 API / 函数执行结果；异步 task 的进度单独展示。监控查询自身不生成记录。</p>
    {!selected && notification}
    {selected && <CallDrawer key={selected} id={selected} live={live} refresh={refresh} onClose={() => select(null)} onTrace={showTrace} onSelect={select} notification={notification} />}
  </main>;
}

function CallDrawer({ id, live, refresh, onClose, onTrace, onSelect, notification }: { id: string; live: boolean; refresh: number; onClose: () => void; onTrace: (id: string) => void; onSelect: (id: string) => void; notification: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cursor = useRef(0);
  const taskCursor = useRef(0);
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [logs, setLogs] = useState<CallDetail["logs"]>([]);
  const [taskLogs, setTaskLogs] = useState<LogEntry[]>([]);
  const [scope, setScope] = useState<"call" | "task">("task");
  const [tab, setTab] = useState("logs");
  const [error, setError] = useState("");
  const [logQuery, setLogQuery] = useState("");
  const [level, setLevel] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let more = false;
      try {
        const next = await apiV1<CallDetail>(`/monitor/calls/${id}?after=${cursor.current}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setDetail(next); setError("");
        const batch = next.logs.filter((log) => log.id > cursor.current);
        setLogs((previous) => [...previous, ...batch].slice(-2000));
        cursor.current = next.next_after; more = next.has_more;
        if (next.call.task_id) {
          const taskBatch = await apiV1<TaskLogPage>(`/tasks/${next.call.task_id}/logs?after=${taskCursor.current}&limit=200`, { signal: controller.signal });
          if (controller.signal.aborted) return;
          const taskRows = taskBatch.items.filter((log) => log.id > taskCursor.current);
          setTaskLogs((previous) => [...previous, ...taskRows].slice(-2000));
          taskCursor.current = taskBatch.next_after;
          more ||= taskBatch.has_more;
        }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "调用详情读取失败。"); }
      finally { if ((live || more) && !controller.signal.aborted) timer = setTimeout(poll, more ? 100 : 2000); }
    }
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [id, live, refresh]);
  const call = detail?.call;
  const activeLogs = scope === "task" && call?.task_id ? taskLogs : logs;
  const visibleLogs = activeLogs.filter((log) => (!level || log.level === level) && (!logQuery || JSON.stringify(log).toLowerCase().includes(logQuery.toLowerCase())));
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ call, call_logs: logs, task_logs: taskLogs, logs_scope: "各范围当前加载的最近 2000 条" }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `call-${id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <dialog ref={dialog} aria-label="调用详情" onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }} className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-4xl overflow-y-auto border-0 bg-[var(--background)] p-0 text-[var(--foreground)] shadow-2xl backdrop:bg-black/35">
    {notification}
    <div className="sticky top-0 z-20 flex items-center justify-between border-b bg-white/90 p-4 backdrop-blur-xl dark:border-white/10"><h2 className="font-semibold">调用详情</h2><Button size="sm" variant="ghost" aria-label="关闭调用详情" onClick={() => dialog.current?.close()}><X size={18} /></Button></div>
    <div className="space-y-5 p-4 sm:p-6">
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!call && !error && <p className="py-10 text-center text-sm text-slate-500">正在加载详情…</p>}
      {call && <>
        <div className="flex flex-wrap items-center gap-3"><span className={`rounded-md px-2 py-1 text-xs ${colors[call.kind]}`}>{callKindLabels[call.kind]}</span><Status value={call.status} /><span className="font-mono text-xs text-slate-500">{elapsed(call)}{call.status_code && ` · HTTP ${call.status_code}`}</span><Button className="ml-auto" size="sm" variant="outline" onClick={download}><Download size={14} />导出记录</Button></div>
        <h3 className="break-all text-lg font-semibold">{call.name}</h3>
        {call.error != null && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{errorSummary(call.error) || "调用失败，请查看错误详情。"}</p>}
        {call.task_id && <div className={`${panel} flex flex-wrap items-center justify-between gap-3 p-4`}>
          <div><p className="mb-2 text-xs text-slate-500">关联任务结果</p><div className="flex flex-wrap items-center gap-2">{call.task_status && <Status value={call.task_status} />}<span className="text-xs text-slate-500">{call.task_progress ?? 0}% · {taskPhaseLabels[call.task_phase ?? ""] ?? call.task_phase}</span></div></div>
          <Button asChild size="sm" variant="outline"><Link href={appUrl(`/monitor?task_id=${call.task_id}`)}>查看任务结果</Link></Button>
          <p className="w-full text-xs text-slate-500">调用完成表示这一步已返回；素材是否处理成功，以任务结果为准。</p>
        </div>}
        <details className="rounded-xl bg-slate-50 p-4 text-xs text-slate-600"><summary className="cursor-pointer">调用标识与链路 · {time(call.started_at)}</summary><div className="mt-3 space-y-2 font-mono"><p className="break-all">Span: {call.id}</p><p className="break-all">Trace: {call.trace_id}</p>{call.parent_span_id && <button className="break-all text-left text-blue-600 hover:underline" onClick={() => onSelect(call.parent_span_id!)}>父调用: {call.parent_span_id}</button>}{call.task_id && <p className="break-all">Task: <Link className="text-blue-600 hover:underline" href={appUrl(`/monitor?task_id=${call.task_id}`)}>{call.task_id}</Link></p>}<p>{time(call.started_at)} → {call.finished_at ? time(call.finished_at) : "执行中"}</p></div>
        <Button className="mt-3" variant="outline" size="sm" onClick={() => onTrace(call.trace_id)}>查看同一 Trace 的全部调用</Button></details>
        <div className="flex gap-1 overflow-x-auto border-b" role="tablist" aria-label="调用信息">{[["logs", "调用日志"], ["input", "入参"], ["output", "出参"], ["error", "错误"]].map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm ${tab === key ? "border-blue-600 font-medium text-blue-600" : "border-transparent text-slate-500"}`}>{label}</button>)}</div>
        {tab === "input" && <JsonView label="调用入参" value={call.input} />}
        {tab === "output" && <JsonView label="调用出参" value={call.output} />}
        {tab === "error" && <JsonView label="调用错误" value={call.error} />}
        {tab === "logs" && <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-1 rounded-full bg-black/5 p-1 dark:bg-white/10" aria-label="日志范围">
              <Button size="sm" variant={scope === "task" && call.task_id ? "default" : "ghost"} disabled={!call.task_id} aria-pressed={scope === "task" && Boolean(call.task_id)} onClick={() => setScope("task")}>整个任务</Button>
              <Button size="sm" variant={scope === "call" || !call.task_id ? "default" : "ghost"} aria-pressed={scope === "call" || !call.task_id} onClick={() => setScope("call")}>当前调用</Button>
            </div>
            <span className="text-xs text-slate-500">{live ? "每 2 秒更新" : "已暂停更新"}</span>
          </div>
          <p className="text-xs text-slate-500">{scope === "task" && call.task_id ? "展示关联任务跨请求、跨 worker 的业务步骤与处理结果。" : "展示当前调用的起止、内部步骤及异常；子调用可通过 Trace 查看。"}</p>
          <div className="flex flex-wrap gap-2"><select aria-label="调用日志级别" className={selectClass} value={level} onChange={(event) => setLevel(event.target.value)}><option value="">全部级别</option>{["info", "warn", "error"].map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select><Input aria-label="搜索调用日志" placeholder="搜索日志内容" value={logQuery} onChange={(event) => setLogQuery(event.target.value)} className="min-w-40 flex-1" /></div>
          <LogTimeline label="调用日志列表" logs={visibleLogs} />
          <p className="text-xs leading-5 text-slate-500">已加载 {activeLogs.length} 条，按发生顺序增量更新，页面保留最近 2000 条。历史未记录的步骤不会补造，可通过日志接口分页读取全部已有记录。</p>
        </>}
      </>}
    </div>
  </dialog>;
}

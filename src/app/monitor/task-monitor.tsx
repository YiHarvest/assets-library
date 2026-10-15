"use client";

import { WebUiLink as Link } from "@/components/webui-link";
import { appUrl } from "@/lib/paths";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Download, Pause, Play, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JsonView } from "@/components/json-view";
import { apiV1 } from "@/lib/api-v1-client";
import type { ApiTaskStatus } from "@/shared/contracts";
import {
  monitorQuerySchema, taskPhaseLabels, taskStatusLabels, taskTypeLabels,
  type MonitorTaskList, type MonitorDetail, type TaskLog, type TaskLogPage,
} from "@/shared/monitor-contracts";

import { LogTimeline, Status, ProgressBar, panelClass as panel, selectClass } from "./monitor-ui";
function timestamp(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—";
}
function duration(startedAt: string | null, finishedAt: string | null) {
  if (!startedAt) return "—";
  const seconds = Math.max(0, ((finishedAt ? Date.parse(finishedAt) : Date.now()) - Date.parse(startedAt)) / 1_000);
  return seconds < 60 ? `${seconds.toFixed(1)} 秒` : `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
}
function Progress({ value, status }: { value: number; status?: string }) {
  return <div className="flex items-center gap-3"><ProgressBar value={value} status={status} /><span className="w-12 shrink-0 text-right font-mono text-xs">{value.toFixed(1)}%</span></div>;
}

export function TaskMonitor({ initialTaskId }: { initialTaskId: string | null }) {
  const [list, setList] = useState<MonitorTaskList | null>(null);
  const [selected, setSelected] = useState<string | null>(initialTaskId);
  const [live, setLive] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [userId, setUserId] = useState("");
  const [filters, setFilters] = useState({ task_id: "", user_id: "" });
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const params = new URLSearchParams({ page: String(page), limit: "30" });
        if (type) params.set("type", type);
        if (status) params.set("status", status);
        if (filters.task_id) params.set("task_id", filters.task_id);
        if (filters.user_id) params.set("user_id", filters.user_id);
        const result = await apiV1<MonitorTaskList>(`/tasks?${params}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setList(result); setError(""); setUpdatedAt(new Date().toISOString());
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "任务列表加载失败。");
      } finally {
        if (live && !controller.signal.aborted) timer = setTimeout(poll, 2_000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [type, status, page, filters, live, refresh]);

  function filterStatus(value: string) { setStatus(value); setPage(1); setSelected(null); }
  function searchTasks(event: React.FormEvent) {
    event.preventDefault();
    const parsed = monitorQuerySchema.safeParse({ ...(search.trim() ? { task_id: search.trim() } : {}), ...(userId.trim() ? { user_id: userId.trim() } : {}) });
    if (!parsed.success) { setError("请填写完整有效的 task UUID；用户 ID 最多 191 个字符。"); return; }
    setFilters({ task_id: search.trim(), user_id: userId.trim() }); setPage(1);
  }

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-5 py-7 sm:py-9">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">任务监控</h1><p className="mt-2 text-sm text-slate-500">在列表中检测每个任务的运行状态，展开详情查看入参、出参和执行日志。</p></div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setLive(!live)}>{live ? <Pause size={15} /> : <Play size={15} />}{live ? "暂停刷新" : "自动刷新"}</Button>
          <Button variant="outline" onClick={() => setRefresh((n) => n + 1)}><RefreshCw size={15} />刷新</Button>
          <Button asChild><Link href={appUrl("/monitor")}>统一调用<ArrowRight size={15} /></Link></Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 rounded-[1.5rem] border border-black/[0.06] bg-white/70 p-3 dark:border-white/10 dark:bg-white/[0.06]" aria-label="按运行状态筛选">
        <Button size="sm" variant={status ? "ghost" : "default"} onClick={() => filterStatus("")} aria-pressed={!status}>全部任务 <span className="font-mono">{list ? Object.values(list.counts).reduce((a, b) => a + b, 0) : "—"}</span></Button>
        {(Object.entries(taskStatusLabels) as [ApiTaskStatus, string][]).map(([key, label]) => <Button key={key} size="sm" variant={status === key ? "default" : "ghost"} onClick={() => filterStatus(status === key ? "" : key)} aria-pressed={status === key}>{label}<span className="font-mono">{list?.counts[key] ?? "—"}</span></Button>)}
      </div>
      <form onSubmit={searchTasks} className={`${panel} flex flex-wrap items-center gap-3 p-4`}>
        <select aria-label="任务类型" value={type} onChange={(e) => { setType(e.target.value); setPage(1); setSelected(null); }} className={selectClass}><option value="">所有类型</option>{Object.entries(taskTypeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <select aria-label="任务状态" value={status} onChange={(e) => filterStatus(e.target.value)} className={selectClass}><option value="">所有状态</option>{Object.entries(taskStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <Input aria-label="任务 ID" placeholder="按完整 task_id 查找" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-48 flex-1" />
        <Input aria-label="用户 ID" placeholder="按 user_id 筛选" value={userId} maxLength={191} onChange={(e) => setUserId(e.target.value)} className="w-44" />
        <Button variant="outline" type="submit"><Search size={15} />查询</Button>
        <span className="ml-auto text-xs text-slate-500" role="status">{live ? "每 2 秒刷新" : "已暂停"}{updatedAt && ` · ${timestamp(updatedAt)}`}</span>
      </form>
      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error} 已有数据保留，刷新后重试。</p>}
      <section className={`${panel} overflow-hidden`} aria-label="任务列表">
        <div className="flex items-center justify-between border-b p-4"><h2 className="font-semibold">监控列表</h2><span className="text-xs text-slate-500">共 {list?.total ?? "—"} 条 · 按创建时间倒序</span></div>
        <div className="max-h-[720px] overflow-auto">
          <table aria-label="任务监控列表" className="w-full min-w-[1080px] text-left text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50 text-xs text-slate-500"><tr>
              {["任务 / ID", "用户", "状态", "当前阶段", "进度", "完成 / 失败", "耗时", "更新时间", "操作"].map((label) => <th key={label} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">{label}</th>)}
            </tr></thead>
            <tbody>
              {!list && <tr><td colSpan={9} className="p-12 text-center text-slate-500">{error ? "暂时无法获取任务" : "正在加载任务…"}</td></tr>}
              {list?.items.length === 0 && <tr><td colSpan={9} className="p-12 text-center text-slate-500">没有符合条件的任务</td></tr>}
              {list?.items.map((task) => <tr key={task.task_id} className="border-t transition-colors hover:bg-slate-50">
                <td className="px-4 py-4"><p className="font-medium">{taskTypeLabels[task.task_type]}</p><p className="mt-1 font-mono text-[11px] text-slate-500">{task.task_id}</p></td>
                <td className="max-w-36 break-words px-4 py-4 text-xs text-slate-500">{task.user_id ?? "—"}</td>
                <td className="px-4 py-4"><Status value={task.status} /></td>
                <td className="max-w-52 px-4 py-4"><p className="whitespace-nowrap text-xs">{taskPhaseLabels[task.phase] ?? task.phase}</p>{task.error_message && <p className="mt-1 line-clamp-2 text-xs text-red-600 dark:text-red-300" title={task.error_message}>{task.error_message}</p>}</td>
                <td className="min-w-40 px-4 py-4"><Progress value={task.progress_percent} status={task.status} /></td>
                <td className="whitespace-nowrap px-4 py-4 font-mono text-xs"><span>{task.done_items}</span> / <span className={task.failed_items ? "text-red-600" : ""}>{task.failed_items}</span><p className="mt-1 text-slate-500">共 {task.total_items} 项</p></td>
                <td className="whitespace-nowrap px-4 py-4 text-xs">{duration(task.started_at, task.finished_at)}</td>
                <td className="whitespace-nowrap px-4 py-4 text-xs text-slate-500"><time>{timestamp(task.updated_at)}</time></td>
                <td className="px-4 py-4"><Button size="sm" variant="outline" aria-haspopup="dialog" onClick={() => { setSelected(task.task_id); window.history.replaceState(null, "", appUrl(`/monitor?task_id=${task.task_id}`)); }}>查看详情</Button></td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t p-3"><Button size="sm" variant="ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</Button><span className="text-xs text-slate-500">第 {page} 页</span><Button size="sm" variant="ghost" disabled={!list?.has_more} onClick={() => setPage(page + 1)}>下一页</Button></div>
      </section>
      {selected && <TaskDrawer key={selected} taskId={selected} live={live} refresh={refresh}
        onRefresh={() => setRefresh((n) => n + 1)} onToggleLive={() => setLive(!live)}
        onClose={() => { setSelected(null); window.history.replaceState(null, "", appUrl("/monitor?view=tasks")); }} />}
    </main>
  );
}

function TaskDrawer({ taskId, live, refresh, onClose, onRefresh, onToggleLive }: {
  taskId: string; live: boolean; refresh: number; onClose: () => void; onRefresh: () => void; onToggleLive: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);
  return <dialog ref={dialog} aria-label="任务详情" onClose={onClose} onClick={(event) => {
    if (event.target === event.currentTarget) dialog.current?.close();
  }} className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-4xl overflow-y-auto border-0 bg-[var(--background)] p-0 text-[var(--foreground)] shadow-2xl backdrop:bg-black/35">
    <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 border-b bg-white/90 p-4 backdrop-blur-xl dark:border-white/10">
      <h2 className="font-semibold">任务详情</h2>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={onToggleLive}>{live ? <Pause size={14} /> : <Play size={14} />}{live ? "暂停刷新" : "自动刷新"}</Button>
        <Button size="sm" variant="ghost" onClick={onRefresh}><RefreshCw size={14} />刷新</Button>
        <Button size="sm" variant="ghost" onClick={() => dialog.current?.close()} aria-label="关闭任务详情"><X size={18} /></Button>
      </div>
    </div>
    <div className="p-3 sm:p-5"><TaskDetail taskId={taskId} live={live} refresh={refresh} /></div>
  </dialog>;
}

function TaskDetail({ taskId, live, refresh }: { taskId: string; live: boolean; refresh: number }) {
  const [detail, setDetail] = useState<MonitorDetail | null>(null);
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [tab, setTab] = useState("logs");
  const [level, setLevel] = useState("");
  const [logSearch, setLogSearch] = useState("");
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const logCursor = useRef(0);
  const logCount = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let more = false;
      try {
        const [next, batch] = await Promise.all([
          apiV1<MonitorDetail>(`/tasks/${taskId}/monitor`, { signal: controller.signal }),
          apiV1<TaskLogPage>(`/tasks/${taskId}/logs?after=${logCursor.current}&limit=200`, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setDetail(next); setError("");
        logCursor.current = batch.next_after; more = batch.has_more;
        logCount.current += batch.items.length;
        setLogs((current) => {
          const unique = new Map(current.map((log) => [log.id, log]));
          for (const log of batch.items) unique.set(log.id, log);
          return [...unique.values()].sort((a, b) => a.id - b.id).slice(-2_000);
        });
        setTruncated(logCount.current > 2_000);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "任务详情加载失败。");
      } finally {
        if ((live || more) && !controller.signal.aborted) timer = setTimeout(poll, more ? 100 : 2_000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [taskId, live, refresh]);

  const task = detail?.task;
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...detail, logs, logs_scope: "当前页面已加载的最多 2000 条日志" }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `task-${taskId}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  const visibleLogs = logs.filter((log) => (!level || log.level === level) && (!logSearch || JSON.stringify(log).toLowerCase().includes(logSearch.toLowerCase())));
  return <section className={`${panel} min-w-0 overflow-hidden`} aria-label="任务详情">
    <div className="space-y-4 border-b p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-3 font-semibold">{task ? taskTypeLabels[task.task_type] : "任务详情"}{task && <Status value={task.status} />}</h2><Button size="sm" variant="outline" onClick={download} disabled={!detail}><Download size={14} />导出当前记录</Button></div>
      <p className="break-all font-mono text-xs text-slate-500">{taskId}</p>
      <Link className="inline-block text-sm text-blue-600 hover:underline" href={appUrl(`/monitor?view=calls&task_id=${taskId}`)}>查看此任务关联的 API / Function / Match 调用</Link>
      {task && <><Progress value={task.progress_percent} status={task.status} /><dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
        {[ ["当前阶段", taskPhaseLabels[task.phase] ?? task.phase], ["完成 / 失败 / 总数", `${task.done_items} / ${task.failed_items} / ${task.total_items}`], ["创建时间", timestamp(task.created_at)], ["开始时间", timestamp(task.started_at)], ["结束时间", timestamp(task.finished_at)], ["耗时", task.started_at ? `${Math.max(0, ((task.finished_at ? Date.parse(task.finished_at) : Date.now()) - Date.parse(task.started_at)) / 1_000).toFixed(1)} 秒` : "—"] ].map(([label, value]) => <div key={label}><dt className="mb-1 text-slate-500">{label}</dt><dd className="break-words">{value}</dd></div>)}
      </dl></>}
      {task?.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{task.error.code} · {task.error.message}</p>}
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}
    </div>
    <div className="flex overflow-x-auto border-b px-3" role="tablist" aria-label="任务信息">
      {[["logs", "执行日志"], ["input", "入参"], ["output", "出参"], ["jobs", "作业 / 文件"], ["callbacks", "回调"]].map(([key, label]) => <button role="tab" aria-selected={tab === key} aria-controls={`panel-${key}`} id={`tab-${key}`} key={key} onClick={() => setTab(key)} className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm ${tab === key ? "border-blue-600 font-medium text-blue-600" : "border-transparent text-slate-500"}`}>{label}</button>)}
    </div>
    <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="space-y-4 p-4 sm:p-5">
      {!detail && !error && <p className="py-10 text-center text-sm text-slate-500">正在加载详情…</p>}
      {tab === "logs" && <>
        <div className="flex flex-wrap gap-2"><select aria-label="日志级别" className={selectClass} value={level} onChange={(e) => setLevel(e.target.value)}><option value="">所有级别</option><option value="info">INFO</option><option value="warn">WARN</option><option value="error">ERROR</option></select><Input aria-label="搜索日志" placeholder="搜索消息、阶段、作业 ID" value={logSearch} onChange={(e) => setLogSearch(e.target.value)} className="min-w-40 flex-1" /></div>
        <p className="text-xs text-slate-500">已加载 {logs.length} 条{truncated ? "，仅保留最近 2000 条；完整日志可通过日志 API 分页读取" : ""} · 日志按时间顺序显示</p>
        <LogTimeline label="执行日志列表" logs={visibleLogs} />
      </>}
      {tab === "input" && detail && <>{!detail.input && <p className="text-sm text-slate-500">此历史任务未记录入参快照。</p>}<JsonView label="请求入参" value={detail.input} /></>}
      {tab === "output" && detail && <><p className="text-xs text-slate-500">这里展示任务实际处理结果。上传结果查看 items 中的状态、错误与 private_asset_ids / public_asset_ids；匹配结果查看 result。</p><JsonView label="任务出参" value={detail.output} /></>}
      {tab === "jobs" && detail && <>
        {task?.items.map((item) => <div className="rounded-xl border p-3" key={item.item_id}><div className="mb-2 flex items-center justify-between gap-2"><span className="break-all text-sm">{item.filename}</span><Status value={item.status} /></div><p className="text-xs text-slate-500">{taskPhaseLabels[item.phase] ?? item.phase} · 接收 {item.received_bytes} / {item.total_bytes} bytes</p>{item.private_asset_ids.length > 0 && <p className="mt-2 break-all font-mono text-xs text-slate-500">私有素材 ID：{item.private_asset_ids.join("、")}</p>}{item.public_asset_ids.length > 0 && <p className="mt-2 break-all font-mono text-xs text-slate-500">公共素材 ID：{item.public_asset_ids.join("、")}</p>}{item.error && <p className="mt-2 text-sm text-red-600">{item.error.message}</p>}</div>)}
        {!detail.jobs.length && <p className="text-sm text-slate-500">暂无 worker 作业。</p>}
        {detail.jobs.map((job) => <details className="rounded-xl border p-3" key={job.job_id}><summary className="cursor-pointer text-sm">{job.type} · {taskStatusLabels[job.status as ApiTaskStatus] ?? job.status} · 第 {job.attempt} 次执行</summary><div className="mt-3"><JsonView label="作业详情" value={job} /></div></details>)}
      </>}
      {tab === "callbacks" && detail && (detail.callbacks.length ? detail.callbacks.map((callback) => <JsonView key={callback.attempt} label={`第 ${callback.attempt} 次回调`} value={callback} />) : <p className="py-8 text-center text-sm text-slate-500">暂无回调记录{task?.callback_url ? "，任务结束后开始投递。" : "，创建任务时可传入 callback_url。"}</p>)}
    </div>
  </section>;
}

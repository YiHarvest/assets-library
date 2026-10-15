import type { Metadata } from "next";
import { TaskMonitor } from "./task-monitor";
import { CallMonitor } from "./call-monitor";
import { WebUiLink as Link } from "@/components/webui-link";
import { appUrl } from "@/lib/paths";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "统一监控 · 素材中枢" };
export default async function MonitorPage({ searchParams }: { searchParams: Promise<{ task_id?: string; span_id?: string; view?: string }> }) {
  const { task_id, span_id, view } = await searchParams;
  const taskView = view === "tasks" || Boolean(task_id && view !== "calls");
  return <>
    <div className="mx-auto max-w-7xl px-5 pt-7"><nav aria-label="监控视图" className="flex w-fit gap-1 rounded-full bg-black/[0.05] p-1 dark:bg-white/[0.10]">
      <Button asChild variant={!taskView ? "default" : "ghost"} size="sm"><Link href={appUrl("/monitor")} aria-current={!taskView ? "page" : undefined}>统一调用</Link></Button>
      <Button asChild variant={taskView ? "default" : "ghost"} size="sm"><Link href={appUrl("/monitor?view=tasks")} aria-current={taskView ? "page" : undefined}>任务进度</Link></Button>
    </nav></div>
    {taskView ? <TaskMonitor initialTaskId={task_id ?? null} /> : <CallMonitor initialSpanId={span_id ?? null} initialTaskId={task_id ?? null} />}
  </>;
}

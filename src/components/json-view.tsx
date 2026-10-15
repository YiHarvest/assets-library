"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function JsonView({ value, label }: { value: unknown; label: string }) {
  const [message, setMessage] = useState("");
  const text = JSON.stringify(value, null, 2) ?? "null";
  async function copy() {
    try { await navigator.clipboard.writeText(text); setMessage("已复制"); }
    catch { setMessage("复制失败，请在下方选择文本复制"); }
  }
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-slate-200">
      <div className="flex items-center justify-between gap-2 bg-slate-50 px-4 py-2">
        <span className="text-xs font-medium text-slate-600">{label}</span>
        <div className="flex items-center gap-2"><span role="status" className="text-xs">{message}</span><Button size="sm" variant="ghost" onClick={copy} aria-label={`复制${label}`}>复制 JSON</Button></div>
      </div>
      <pre aria-label={label} tabIndex={0} className="max-h-[32rem] overflow-auto bg-[#111827] p-4 font-mono text-xs leading-6 text-slate-100">{text}</pre>
    </div>
  );
}

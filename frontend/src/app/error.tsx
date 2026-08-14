"use client";

import { AlertCircle, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-3xl px-5 py-16">
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-800">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 size-5 shrink-0" />
          <div>
            <h1 className="font-semibold">页面暂时无法加载</h1>
            <p className="mt-2 text-sm">后端响应超时或服务暂时不可用，请稍后重试。</p>
            <Button className="mt-5" variant="outline" onClick={reset}>
              <RefreshCcw className="size-4" /> 重新加载
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}

import * as React from "react";
import { cn } from "@/lib/utils";

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "flex min-h-24 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100 disabled:opacity-50 dark:border-white/[0.12] dark:bg-white/[0.08] dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:ring-cyan-400/15",
        className,
      )}
      {...props}
    />
  );
}

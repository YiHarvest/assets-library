import * as React from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-black/[0.045] px-2.5 py-1 text-xs font-medium text-slate-600 dark:bg-white/[0.10] dark:text-slate-300",
        className,
      )}
      {...props}
    />
  );
}

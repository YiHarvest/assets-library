/* eslint-disable @next/next/no-img-element */
import React from "react";
import { cn } from "@/lib/utils";

export function MediaPreview({
  mediaType,
  src,
  poster,
  name,
  className,
}: {
  mediaType: "image" | "video";
  src: string;
  poster?: string | null;
  name: string;
  className?: string;
}) {
  if (!src) {
    return (
      <div
        className={cn(
          "grid h-full w-full place-items-center bg-slate-100 px-3 text-center text-xs text-slate-500 dark:bg-white/[0.06] dark:text-slate-400",
          className,
        )}
        role="img"
        aria-label={`${name} 暂无预览`}
      >
        正在生成预览
      </div>
    );
  }
  if (mediaType === "video") {
    return (
      <video
        className={cn("h-full w-full bg-slate-950 object-contain", className)}
        src={src}
        poster={poster ?? undefined}
        controls
        preload="none"
        aria-label={name}
      />
    );
  }
  // API-served user media cannot use Next image optimization safely.
  return (
    <img
      className={cn("h-full w-full object-cover", className)}
      src={src}
      alt={name}
    />
  );
}

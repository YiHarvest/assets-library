import type { ReactNode } from "react";
import { LibraryBig, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WebUiLink } from "@/components/webui-link";
import { appUrl } from "@/lib/paths";

export function SiteHeader({ trailing }: { trailing?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 border-b border-black/[0.06] bg-white/75 backdrop-blur-xl dark:border-white/[0.08] dark:bg-[#1d1d1f]/75">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-5">
        <WebUiLink href={appUrl("/")} className="flex items-center gap-2.5 font-semibold tracking-tight dark:text-[#f5f5f7]">
          <span className="grid size-8 place-items-center rounded-[0.7rem] bg-[#0071e3] text-white shadow-sm">
            <LibraryBig className="size-5" />
          </span>
          <span>素材库</span>
        </WebUiLink>
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost">
            <WebUiLink href={appUrl("/")}>素材概览</WebUiLink>
          </Button>
          <Button asChild>
            <WebUiLink href={appUrl("/upload")}>
              <Upload className="size-4" />
              上传素材
            </WebUiLink>
          </Button>
          {trailing}
        </nav>
      </div>
    </header>
  );
}

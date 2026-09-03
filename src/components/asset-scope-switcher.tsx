"use client";

import { ChevronDown, Globe2, UserRound, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { WebUiLink } from "@/components/webui-link";
import type { UserDirectoryEntry } from "@/shared/contracts";

interface UserOption extends UserDirectoryEntry {
  href: string;
}

function userOptionLabel(user: UserOption) {
  const identity = user.display_name
    ? `${user.display_name} (${user.user_id})`
    : user.user_id;
  return `${identity}, ${user.asset_count} 项`;
}

export function AssetScopeSwitcher({
  currentUserId,
  currentScope,
  publicHref,
  users,
}: {
  currentUserId: string;
  currentScope: "public" | "private";
  publicHref: string;
  users: UserOption[];
}) {
  const [pickerOpen, setPickerOpen] = useState(currentScope === "private");
  const [isNavigating, setIsNavigating] = useState(false);
  const isPersonal = currentScope === "private";
  const currentUserIsRegistered = users.some(
    (user) => user.user_id === currentUserId,
  );

  useEffect(() => {
    setPickerOpen(currentScope === "private");
  }, [currentScope]);

  const selectUser = (userId: string) => {
    const user = users.find((candidate) => candidate.user_id === userId);
    if (!user) return;
    setIsNavigating(true);
    // rewrite 部署下必须整页跳转，确保公开前缀和 WebUI Cookie 一起交给服务端。
    window.location.assign(user.href);
  };

  return (
    <section
      className="mb-4 flex flex-col gap-3 rounded-[1.5rem] border border-black/[0.06] bg-white/70 p-3 shadow-sm backdrop-blur-xl dark:border-white/[0.10] dark:bg-white/[0.06] sm:flex-row sm:items-center"
      aria-labelledby="asset-scope-label"
    >
      <div className="flex items-center gap-2 px-1 sm:min-w-28">
        <UsersRound className="size-4 text-slate-400" aria-hidden="true" />
        <span
          id="asset-scope-label"
          className="text-sm font-medium text-slate-600 dark:text-slate-300"
        >
          素材范围
        </span>
      </div>

      <div
        className="flex w-fit shrink-0 rounded-full bg-black/[0.05] p-1 dark:bg-white/[0.10]"
        aria-label="素材库范围"
      >
        <WebUiLink
          href={publicHref}
          aria-current={!isPersonal ? "page" : undefined}
          onClick={() => setPickerOpen(false)}
          className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition active:scale-[0.97] ${
            !isPersonal
              ? "bg-[#0071e3] text-white shadow-sm"
              : "text-slate-600 hover:bg-black/[0.05] dark:text-slate-200 dark:hover:bg-white/[0.10]"
          }`}
        >
          <Globe2 className="size-3.5" aria-hidden="true" />
          公共素材
        </WebUiLink>
        <button
          type="button"
          aria-pressed={isPersonal}
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen(true)}
          className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition active:scale-[0.97] ${
            isPersonal
              ? "bg-[#0071e3] text-white shadow-sm"
              : pickerOpen
                ? "bg-white text-[#0071e3] shadow-sm dark:bg-white/[0.14] dark:text-blue-400"
              : "text-slate-600 hover:bg-black/[0.05] dark:text-slate-200 dark:hover:bg-white/[0.10]"
          }`}
        >
          <UserRound className="size-3.5" aria-hidden="true" />
          个人素材
        </button>
      </div>

      {pickerOpen && (
        <div className="min-w-0 flex-1">
          {users.length > 0 ? (
            <div className="relative">
              <label htmlFor="asset-user" className="sr-only">
                选择素材所属用户
              </label>
              <select
                id="asset-user"
                value={currentUserIsRegistered ? currentUserId : ""}
                disabled={isNavigating}
                onChange={(event) => selectUser(event.target.value)}
                className="h-10 w-full appearance-none rounded-full border border-black/[0.08] bg-white/85 py-2 pl-4 pr-10 text-sm text-slate-700 shadow-sm outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-60 dark:border-white/[0.12] dark:bg-white/[0.10] dark:text-slate-100"
              >
                <option value="" disabled>
                  {isNavigating ? "正在切换用户" : "请选择用户"}
                </option>
                {users.map((user) => (
                  <option key={user.user_id} value={user.user_id}>
                    {userOptionLabel(user)}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-4 top-1/2 size-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
            </div>
          ) : (
            <p className="rounded-xl bg-black/[0.035] px-4 py-2.5 text-sm text-slate-500 dark:bg-white/[0.07] dark:text-slate-400">
              暂无已注册用户
            </p>
          )}
        </div>
      )}
    </section>
  );
}

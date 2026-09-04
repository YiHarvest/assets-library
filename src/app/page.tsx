import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Images,
  LayoutGrid,
  List,
  Search,
  X,
} from "lucide-react";
import { AssetOverviewGrid } from "@/components/asset-overview-grid";
import { AssetScopeSwitcher } from "@/components/asset-scope-switcher";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { WebUiLink } from "@/components/webui-link";
import { serverApiV1, serverWebUiApi } from "@/lib/server-api-v1";
import { appUrl } from "@/lib/paths";
import { detectSearchInputMode } from "@/server/search/relevance";
import type {
  AssetQueryResponse,
  UserDirectoryResponse,
  UserScope,
} from "@/shared/contracts";

export const dynamic = "force-dynamic";

type AssetOverviewView = "pending" | "published";
type OverviewLayout = "gallery" | "list";
type LibraryScope = "public" | "private";

function firstParameter(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

function decodeHistory(value?: string) {
  if (!value) return [] as Array<string | null>;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    return Array.isArray(parsed) &&
      parsed.every((item) => item === null || typeof item === "string")
      ? (parsed as Array<string | null>).slice(-100)
      : [];
  } catch {
    return [];
  }
}

function overviewHref(input: {
  view: AssetOverviewView;
  cursor?: string | null;
  history?: Array<string | null>;
  tag?: string;
  layout?: OverviewLayout;
  userId?: string;
  scope: LibraryScope;
}) {
  const parameters = new URLSearchParams({ view: input.view, scope: input.scope });
  if (input.cursor) parameters.set("cursor", input.cursor);
  if (input.history?.length) {
    parameters.set(
      "history",
      Buffer.from(JSON.stringify(input.history), "utf8").toString("base64url"),
    );
  }
  if (input.view === "published" && input.tag) {
    parameters.set("tag", input.tag);
  }
  if (input.layout === "list") parameters.set("layout", "list");
  if (input.userId) parameters.set("user_id", input.userId);
  return appUrl(`/?${parameters.toString()}`);
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{
    tag?: string | string[];
    cursor?: string | string[];
    history?: string | string[];
    view?: string | string[];
    layout?: string | string[];
    user_id?: string | string[];
    scope?: string | string[];
  }>;
}) {
  const parameters = await searchParams;
  const view: AssetOverviewView =
    firstParameter(parameters.view) === "pending" ? "pending" : "published";
  const layout: OverviewLayout =
    firstParameter(parameters.layout) === "list" ? "list" : "gallery";
  const tagQuery =
    view === "published"
      ? firstParameter(parameters.tag)?.trim().slice(0, 128) ?? ""
      : "";
  const searchMode = tagQuery ? detectSearchInputMode(tagQuery) : null;
  const userId = firstParameter(parameters.user_id)?.trim().slice(0, 191) ?? "";
  const scope: LibraryScope =
    firstParameter(parameters.scope) === "private" && userId
      ? "private"
      : "public";
  const effectiveView = view;
  const cursor = firstParameter(parameters.cursor) ?? null;
  const history = decodeHistory(firstParameter(parameters.history));
  const userScope: UserScope = scope === "private"
    ? { mode: "user", user_id: userId }
    : userId
      ? { mode: "exclude_user", user_id: userId }
      : { mode: "public" };
  const [page, userDirectory] = await Promise.all([
    serverApiV1<AssetQueryResponse>("/assets/query", {
      method: "POST",
      body: JSON.stringify({
        ...(searchMode === "semantic"
          ? { query: tagQuery }
          : searchMode === "keyword"
            ? { keywords: [tagQuery] }
            : {}),
        filter: {
          user_scope: userScope,
          review_statuses: [
            effectiveView === "published" ? "published" : "pending_review",
          ],
        },
        cursor,
        limit: 8,
        include_tag_statistics: true,
      }),
    }),
    serverWebUiApi<UserDirectoryResponse>("/users"),
  ]);
  const common = { view: effectiveView, tag: tagQuery, layout, userId, scope };
  const uploadHref = userId
    ? appUrl(`/upload?user_id=${encodeURIComponent(userId)}`)
    : appUrl("/upload");
  const total = page.tag_statistics?.total_assets ?? page.items.length;
  const currentUser = userDirectory.items.find(
    (user) => user.user_id === userId,
  );
  const scopeDescription = scope === "private"
    ? currentUser?.display_name
      ? `${currentUser.display_name} (${userId})`
      : `用户 ${userId} 的素材`
    : "公共素材库";
  const publicScopeHref = overviewHref({
    view: effectiveView,
    tag: tagQuery,
    layout,
    userId,
    scope: "public",
  });
  const userOptions = userDirectory.items.map((user) => ({
    ...user,
    href: overviewHref({
      view: "published",
      tag: tagQuery,
      layout,
      userId: user.user_id,
      scope: "private",
    }),
  }));

  return (
    <main className="mx-auto max-w-7xl px-5 py-7 sm:py-9">
      <section className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
            素材库
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {scopeDescription}
          </p>
        </div>
        <Button asChild>
          <WebUiLink href={uploadHref}>
            添加新素材 <ArrowRight className="size-4" />
          </WebUiLink>
        </Button>
      </section>

      <AssetScopeSwitcher
        currentUserId={userId}
        currentScope={scope}
        publicHref={publicScopeHref}
        users={userOptions}
      />

      <div className="mb-7 flex flex-col gap-3 rounded-[1.5rem] border border-black/[0.06] bg-white/70 p-3 shadow-sm backdrop-blur-xl dark:border-white/[0.10] dark:bg-white/[0.06] sm:flex-row sm:items-center">
        <nav
          className="flex w-fit shrink-0 rounded-full bg-black/[0.05] p-1 dark:bg-white/[0.10]"
          aria-label="素材视图"
        >
          <Button
            asChild
            variant={effectiveView === "published" ? "default" : "ghost"}
            size="sm"
          >
            <WebUiLink href={overviewHref({ ...common, view: "published" })}>
              已入库
            </WebUiLink>
          </Button>
          <Button
            asChild
            variant={effectiveView === "pending" ? "default" : "ghost"}
            size="sm"
          >
            <WebUiLink
              href={overviewHref({ ...common, view: "pending", tag: "" })}
            >
              待入库
            </WebUiLink>
          </Button>
        </nav>

        {effectiveView === "published" ? (
          <form
            action={appUrl("/")}
            method="get"
            className="flex flex-1 items-center gap-2"
          >
            <input type="hidden" name="view" value="published" />
            <input type="hidden" name="scope" value={scope} />
            {layout === "list" && (
              <input type="hidden" name="layout" value="list" />
            )}
            {userId && <input type="hidden" name="user_id" value={userId} />}
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
              <Input
                name="tag"
                defaultValue={tagQuery}
                maxLength={128}
                className="pl-10"
                aria-label="按标签搜索已入库素材"
                placeholder="搜索标签、场景或风格"
              />
            </div>
            <Button type="submit" size="sm" aria-label="搜索标签">
              <Search className="size-4" />
              <span className="hidden sm:inline">搜索</span>
            </Button>
            {tagQuery && (
              <Button asChild variant="ghost" size="sm" aria-label="清除搜索">
                <WebUiLink href={overviewHref({ ...common, tag: "" })}>
                  <X className="size-4" />
                </WebUiLink>
              </Button>
            )}
          </form>
        ) : (
          <p className="px-2 text-sm text-slate-500 dark:text-slate-400">
            处理完成后，在这里确认并入库。
          </p>
        )}
        <div
          className="flex shrink-0 rounded-full bg-black/[0.05] p-1 dark:bg-white/[0.10]"
          aria-label="布局选择"
        >
          <Button
            asChild
            variant={layout === "gallery" ? "default" : "ghost"}
            size="sm"
            aria-label="画廊视图"
          >
            <WebUiLink href={overviewHref({ ...common, layout: "gallery" })}>
              <LayoutGrid className="size-3.5" />
            </WebUiLink>
          </Button>
          <Button
            asChild
            variant={layout === "list" ? "default" : "ghost"}
            size="sm"
            aria-label="列表视图"
          >
            <WebUiLink href={overviewHref({ ...common, layout: "list" })}>
              <List className="size-3.5" />
            </WebUiLink>
          </Button>
        </div>
      </div>

      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            {effectiveView === "pending" ? "待入库素材" : "已入库素材"}
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {tagQuery
              ? `匹配“${tagQuery}”的素材。`
              : effectiveView === "pending"
                ? "包含等待处理、处理中、失败及待确认素材。"
                : "已经完成审核并正式入库的素材。"}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-sm tabular-nums text-slate-500 dark:text-slate-400">
          <span>{total} 项</span>
          {page.search?.max_score !== null &&
            page.search?.max_score !== undefined && (
              <span className="text-xs">
                最高相关度 {(page.search.max_score * 100).toFixed(0)}%
              </span>
            )}
        </div>
      </div>

      {page.items.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex min-h-80 flex-col items-center justify-center text-center">
            <span className="mb-5 grid size-16 place-items-center rounded-2xl bg-cyan-50 text-cyan-700 dark:bg-cyan-400/10 dark:text-cyan-300">
              <Images className="size-8" />
            </span>
            <h2 className="text-xl font-semibold">
              {tagQuery
                ? "未找到匹配素材"
                : effectiveView === "pending"
                  ? "暂无待入库素材"
                  : "暂无已入库素材"}
            </h2>
            <p className="mt-2 max-w-md text-sm text-slate-500 dark:text-slate-400">
              {tagQuery
                ? page.search?.message ?? `没有素材匹配“${tagQuery}”。`
                : "新上传素材完成处理后会显示在对应视图。"}
            </p>
            <Button asChild className="mt-6">
              <WebUiLink href={tagQuery ? overviewHref({ ...common, tag: "" }) : uploadHref}>
                {tagQuery ? "清除搜索条件" : "开始上传"}
              </WebUiLink>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <AssetOverviewGrid assets={page.items} layout={layout} />
      )}

      {(history.length > 0 || page.has_more) && (
        <nav
          className="mt-8 flex items-center justify-center gap-2"
          aria-label="素材分页"
        >
          <Button
            asChild
            variant="outline"
            size="sm"
            className={history.length === 0 ? "pointer-events-none opacity-50" : ""}
          >
            <WebUiLink
              href={overviewHref({
                ...common,
                cursor: history.at(-1) ?? null,
                history: history.slice(0, -1),
              })}
              aria-disabled={history.length === 0}
            >
              <ChevronLeft className="size-4" /> 上一页
            </WebUiLink>
          </Button>
          <Button
            asChild
            variant="outline"
            size="sm"
            className={!page.has_more ? "pointer-events-none opacity-50" : ""}
          >
            <WebUiLink
              href={overviewHref({
                ...common,
                cursor: page.next_cursor,
                history: [...history, cursor],
              })}
              aria-disabled={!page.has_more}
            >
              下一页 <ChevronRight className="size-4" />
            </WebUiLink>
          </Button>
        </nav>
      )}
    </main>
  );
}

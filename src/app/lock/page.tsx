import { LockKeyhole } from "lucide-react";
import { appUrl } from "@/lib/paths";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { safeWebUiReturnPath } from "@/server/auth/webui-lock";

export const dynamic = "force-dynamic";

interface LockPageProps {
  searchParams: Promise<{ error?: string; next?: string }>;
}

export default async function LockPage({ searchParams }: LockPageProps) {
  const query = await searchParams;
  const returnPath = safeWebUiReturnPath(query.next);
  const hasError = query.error === "invalid";

  return (
    <main className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-lg items-center px-5 py-12">
      <Card className="w-full overflow-hidden bg-white/90 backdrop-blur-xl dark:bg-[#1c1c1e]/95">
        <CardHeader className="space-y-4 pb-4 text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-[#0071e3]/10 text-[#0071e3] dark:bg-blue-500/15 dark:text-blue-400">
            <LockKeyhole className="size-6" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">素材中枢已锁定</h1>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              这是可信内网中的管理页面。请输入访问密钥继续。
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <form method="post" action={appUrl("/api/auth/unlock")} className="space-y-4">
            <input type="hidden" name="next" value={returnPath} />
            <div>
              <label htmlFor="webui-key" className="sr-only">
                访问密钥
              </label>
              <Input
                id="webui-key"
                name="key"
                type="password"
                autoComplete="current-password"
                placeholder="访问密钥"
                required
                autoFocus
                aria-invalid={hasError}
                aria-describedby={hasError ? "unlock-error" : undefined}
              />
              {hasError && (
                <p id="unlock-error" className="mt-2 px-1 text-sm text-red-600" role="alert">
                  访问密钥不正确，请重试。
                </p>
              )}
            </div>
            <Button type="submit" className="w-full" size="lg">
              解锁管理页面
            </Button>
          </form>
          <p className="mt-5 text-center text-xs leading-5 text-slate-400">
            解锁状态保存在 HttpOnly 签名 Cookie 中，12 小时后自动失效。
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import { ThemeToggle } from "@/components/theme-toggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "素材中枢",
  description: "图片与视频素材的智能分析和管理工具",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(() => { try { const mode = localStorage.getItem('theme-mode') || 'system'; const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches); document.documentElement.dataset.theme = dark ? 'dark' : 'light'; } catch {} })()`,
          }}
        />
      </head>
      <body>
        <SiteHeader trailing={<ThemeToggle />} />
        {children}
      </body>
    </html>
  );
}

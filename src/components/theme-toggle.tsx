"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type ThemeMode = "light" | "dark" | "system";

const options: Array<{ mode: ThemeMode; label: string; Icon: typeof Sun }> = [
  { mode: "light", label: "浅色", Icon: Sun },
  { mode: "dark", label: "暗色", Icon: Moon },
  { mode: "system", label: "跟随系统", Icon: Monitor },
];

function applyTheme(mode: ThemeMode) {
  const isDark =
    mode === "dark" ||
    (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  try {
    localStorage.setItem("theme-mode", mode);
  } catch {
    // 非安全上下文（http + IP）下 localStorage 不可用，忽略。
  }
}

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("system");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("theme-mode");
    } catch {
      // 非安全上下文（http + IP）下 localStorage 不可用，忽略。
    }
    const next = saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    setMode(next);
    applyTheme(next);
  }, []);

  useEffect(() => {
    if (mode !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncWithSystem = () => applyTheme("system");
    media.addEventListener("change", syncWithSystem);
    return () => media.removeEventListener("change", syncWithSystem);
  }, [mode]);

  const selectTheme = (next: ThemeMode) => {
    setMode(next);
    applyTheme(next);
    setOpen(false);
  };

  const selected = options.find((option) => option.mode === mode) ?? options[2]!;
  const SelectedIcon = selected.Icon;

  return (
    <div className="relative">
      <button
        type="button"
        className="grid size-8 place-items-center rounded-full text-slate-600 transition hover:bg-black/[0.05] dark:text-slate-300 dark:hover:bg-white/[0.10]"
        onClick={() => setOpen((visible) => !visible)}
        aria-label={`主题：${selected.label}`}
        aria-expanded={open}
      >
        <SelectedIcon className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-30 w-32 rounded-2xl border border-black/[0.08] bg-white/90 p-1.5 shadow-xl backdrop-blur-xl dark:border-white/[0.12] dark:bg-[#2c2c2e]/95">
          {options.map(({ mode: optionMode, label, Icon }) => (
            <button
              key={optionMode}
              type="button"
              className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition ${
                mode === optionMode
                  ? "bg-[#0071e3] text-white"
                  : "text-slate-600 hover:bg-black/[0.05] dark:text-slate-200 dark:hover:bg-white/[0.10]"
              }`}
              onClick={() => selectTheme(optionMode)}
              aria-pressed={mode === optionMode}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

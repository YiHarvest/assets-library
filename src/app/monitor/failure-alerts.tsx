"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CircleAlert, Volume2, VolumeX, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FailureItem {
  id: string;
  title: string;
  description: string;
  occurredAt: string | null;
}

interface Notice {
  title: string;
  items: FailureItem[];
  total: number;
  detectedAt: string;
}

type SoundState = "blocked" | "ready" | "unavailable";

export function useFailureAlerts(kind: "调用" | "任务") {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [soundMuted, setSoundMuted] = useState(false);
  const [soundState, setSoundState] = useState<SoundState>("blocked");
  const audio = useRef<AudioContext | null>(null);
  const muted = useRef(false);
  const soundAttempt = useRef(0);
  const tones = useRef<OscillatorNode[]>([]);
  const seen = useRef<{ scope: string; ids: Set<string> } | null>(null);

  const stopSound = useCallback(() => {
    soundAttempt.current++;
    for (const tone of tones.current) tone.stop();
    tones.current = [];
  }, []);

  const prepareSound = useCallback(async () => {
    if (muted.current) return null;
    let context = audio.current;
    try {
      if (!context || context.state === "closed") {
        context = new AudioContext();
        audio.current = context;
        const current = context;
        const updateState = () => {
          if (audio.current === current) setSoundState(current.state === "running" ? "ready" : "blocked");
        };
        context.onstatechange = updateState;
        updateState();
      }
      if (context.state !== "running") await context.resume();
      return context;
    } catch {
      if (audio.current === context) setSoundState(context ? "blocked" : "unavailable");
      return null;
    }
  }, []);

  useEffect(() => {
    // Reuse earlier user activation without playing a sound.
    void prepareSound();
    const activate = (event: Event) => {
      // Let the sound button handle activation before changing its mute state.
      if (event.target instanceof Element && event.target.closest("[data-alert-sound]")) return;
      void prepareSound();
    };
    document.addEventListener("click", activate, true);
    document.addEventListener("keydown", activate, true);
    return () => {
      document.removeEventListener("click", activate, true);
      document.removeEventListener("keydown", activate, true);
      stopSound();
      const context = audio.current;
      audio.current = null;
      if (context) {
        context.onstatechange = null;
        if (context.state !== "closed") void context.close().catch(() => {});
      }
    };
  }, [prepareSound, stopSound]);

  const playSound = useCallback(() => {
    if (muted.current) return;
    stopSound();
    const attempt = soundAttempt.current;
    const deadline = performance.now() + 500;
    void prepareSound().then((context) => {
      // resume() may wait for permission; discard stale or cancelled alarms.
      if (!context || audio.current !== context || context.state !== "running"
        || muted.current || soundAttempt.current !== attempt || performance.now() > deadline) return;
      try {
        [740, 560].forEach((frequency, index) => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const start = context.currentTime + 0.02 + index * 0.28;
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(frequency, start);
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
          gain.gain.setValueAtTime(0.18, start + 0.12);
          gain.gain.linearRampToValueAtTime(0, start + 0.24);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.onended = () => {
            oscillator.disconnect(); gain.disconnect();
            tones.current = tones.current.filter((tone) => tone !== oscillator);
          };
          oscillator.start(start);
          oscillator.stop(start + 0.26);
          tones.current.push(oscillator);
        });
      } catch {
        stopSound();
        setSoundState("unavailable");
      }
    });
  }, [prepareSound, stopSound]);

  useEffect(() => {
    if (!notice) return;
    playSound();
    return stopSound;
  }, [notice, playSound, stopSound]);

  function toggleSound() {
    if (muted.current || soundState !== "ready") {
      muted.current = false;
      setSoundMuted(false);
      playSound(); // An explicit enable click also auditions the notification.
    } else {
      muted.current = true;
      setSoundMuted(true);
      stopSound();
    }
  }

  const observe = useCallback((scope: string, failures: FailureItem[]) => {
    if (seen.current?.scope !== scope) {
      // First successful response in a view is the baseline, not a new incident.
      seen.current = { scope, ids: new Set(failures.map((item) => item.id)) };
      return;
    }
    const previous = seen.current;
    const fresh = failures.filter((item) => !previous.ids.has(item.id));
    for (const item of fresh) previous.ids.add(item.id);
    if (!fresh.length) return;
    setNotice({
      title: fresh.length === 1 ? `${kind}失败` : `${fresh.length} 条${kind}失败`,
      items: fresh.slice(0, 3), total: fresh.length, detectedAt: new Date().toISOString(),
    });
  }, [kind]);

  const dismiss = useCallback(() => setNotice(null), []);

  return {
    notice, observe, soundMuted, soundState, toggleSound, dismiss,
  };
}

export function FailureToast({ notice, onDismiss, onInspect, soundMuted, soundState, onToggleSound }: {
  notice: Notice | null;
  onDismiss: () => void;
  onInspect: (id: string) => void;
  soundMuted: boolean;
  soundState: SoundState;
  onToggleSound: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const dismiss = useCallback(() => {
    setHovered(false); setFocused(false); onDismiss();
  }, [onDismiss]);
  useEffect(() => {
    if (!notice || hovered || focused) return;
    const timer = window.setTimeout(dismiss, 8_000);
    return () => window.clearTimeout(timer);
  }, [notice, hovered, focused, dismiss]);

  if (!notice) return null;

  const iconButtonClass = "size-8 shrink-0 rounded-md p-0 text-slate-600 hover:bg-red-900/5 focus-visible:ring-red-500 focus-visible:ring-offset-0 dark:text-red-100 dark:hover:bg-white/5";
  let soundLabel = "开启声音并试听";
  if (soundState === "unavailable") soundLabel = "提示音不可用";
  else if (soundMuted) soundLabel = "取消静音并试听";
  else if (soundState === "ready") soundLabel = "静音提醒";

  return <aside role="alert" aria-label="失败通知" aria-atomic="true"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    style={{ borderColor: "rgba(239, 68, 68, 0.55)" }}
    className="fixed top-[72px] left-1/2 z-50 grid max-h-[70dvh] w-[calc(100%-2rem)] max-w-[440px] -translate-x-1/2 grid-cols-[1.125rem_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 overflow-y-auto rounded-2xl border bg-[#f9dede]/80 p-3.5 text-[var(--foreground)] shadow-[0_8px_24px_rgba(0,0,0,0.06)] backdrop-blur-md dark:bg-[#4b252b]/80">
    <CircleAlert size={18} strokeWidth={1.8} className="col-start-1 row-start-1 mt-[7px] text-red-600 dark:text-red-300" aria-hidden="true" />
    <h2 className="col-start-2 row-start-1 text-sm font-semibold leading-8 tracking-tight text-red-800 dark:text-red-200">{notice.title}</h2>
    <ul className="col-span-2 col-start-2 row-start-2 min-w-0 divide-y divide-red-900/10 dark:divide-red-100/10">
      {notice.items.map((item) => <li key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
        <p className="col-span-2 min-w-0 break-words">
          <span className="block truncate text-[13px] font-medium leading-5 tracking-tight" title={item.title}>{item.title}</span>
          <span className="mt-0.5 block text-xs leading-5 text-slate-600">{item.description}</span>
        </p>
        <time dateTime={item.occurredAt ?? notice.detectedAt} className="shrink-0 text-[11px] tabular-nums text-slate-600">{new Date(item.occurredAt ?? notice.detectedAt).toLocaleTimeString("zh-CN", { hour12: false })}</time>
        <Button size="sm" variant="ghost" aria-label={`查看失败详情：${item.title}`} className="-mr-1 h-7 shrink-0 gap-1 rounded-md px-2 font-medium text-red-700 hover:bg-red-900/5 focus-visible:ring-red-500 focus-visible:ring-offset-0 dark:text-red-200 dark:hover:bg-white/5" onClick={() => { onInspect(item.id); dismiss(); }}>查看详情<ArrowRight size={13} aria-hidden="true" /></Button>
      </li>)}
    </ul>
    <div className="col-start-3 row-start-1 -mr-1 flex items-center">
      <Button size="sm" variant="ghost" data-alert-sound aria-label={soundLabel} title={soundLabel} aria-pressed={soundMuted} disabled={soundState === "unavailable"} className={iconButtonClass} onClick={onToggleSound}>{soundMuted || soundState !== "ready" ? <VolumeX size={16} /> : <Volume2 size={16} />}</Button>
      <Button size="sm" variant="ghost" aria-label="关闭失败提醒" title="关闭失败提醒" className={iconButtonClass} onClick={dismiss}><X size={16} /></Button>
    </div>
    {!soundMuted && soundState !== "ready" && <p className="col-span-2 col-start-2 text-xs leading-5 text-red-800/80 dark:text-red-200/80">{soundState === "unavailable" ? "当前浏览器无法播放提示音。" : "声音尚未启用，点击右上角喇叭开启。"}</p>}
    {notice.total > notice.items.length && <p className="col-span-2 col-start-2 text-xs leading-5 text-slate-600">另有 {notice.total - notice.items.length} 条失败，请在列表中查看。</p>}
  </aside>;
}

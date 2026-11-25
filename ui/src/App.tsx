import { useEffect, useRef, useState } from "react";
import { Moon, Sun, Settings2, Pause, Play, Minus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Logo } from "@/Logo";
import { Wizard } from "@/wizard/Wizard";
import { Panel } from "@/panel/Panel";
import { useTrame } from "@/api";
import { onTrayTogglePause, setAutostart } from "@/desktop";

function tauriWindow() {
  const w = (window as unknown as { __TAURI__?: any }).__TAURI__?.window;
  return w?.getCurrentWindow?.() ?? w?.getCurrent?.() ?? null;
}

function WindowControls() {
  const win = tauriWindow();
  const base = "flex h-full w-12 items-center justify-center text-muted-foreground transition-colors";
  return (
    <div className="flex h-full" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <button className={`${base} hover:bg-accent hover:text-foreground`} onClick={() => win?.minimize?.()} aria-label="Réduire">
        <Minus className="size-4" />
      </button>
      <button className={`${base} hover:bg-accent hover:text-foreground`} onClick={() => win?.toggleMaximize?.()} aria-label="Agrandir">
        <Square className="size-3.5" />
      </button>
      <button className={`${base} hover:bg-red-500 hover:text-white`} onClick={() => win?.close?.()} aria-label="Réduire dans la barre des tâches">
        <X className="size-4" />
      </button>
    </div>
  );
}

export default function App() {
  const [dark, setDark] = useState(true);
  const [configured, setConfigured] = useState(false);
  const trame = useTrame();
  const paused = trame.state.paused;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => onTrayTogglePause(() => trame.setPaused(!pausedRef.current)), []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        setDark((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col overflow-hidden rounded-xl border bg-background text-foreground">
        <header
          data-tauri-drag-region
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          className="flex h-12 select-none items-center gap-3 border-b bg-sidebar pl-4"
        >
          <Logo size={30} />
          <div className="flex flex-col leading-none">
            <span className="text-sm font-semibold">Trame</span>
            <span className="text-[11px] text-muted-foreground">la trame de tes conversations</span>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-1.5 pr-2" style={noDrag}>
            {configured && (
              <div className="flex items-center gap-2 rounded-full bg-secondary px-2.5 py-1">
                {paused ? <Pause className="size-3.5 text-warning" /> : <Play className="size-3.5 text-success" />}
                <span className="text-xs">{paused ? "En pause" : "Actif"}</span>
                <Switch checked={paused} onCheckedChange={trame.setPaused} />
              </div>
            )}

            {configured && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={() => setConfigured(false)}>
                    <Settings2 className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Relancer le wizard</TooltipContent>
              </Tooltip>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setDark(!dark)}>
                  {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Thème clair / sombre — Alt + D</TooltipContent>
            </Tooltip>
          </div>

          <WindowControls />
        </header>

        <main className="flex-1 overflow-hidden">
          {configured ? <Panel trame={trame} /> : <Wizard onFinish={() => { setConfigured(true); setAutostart(true); }} />}
        </main>
      </div>
      <Toaster richColors position="bottom-right" />
    </TooltipProvider>
  );
}

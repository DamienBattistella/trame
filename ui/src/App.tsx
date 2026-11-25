import { useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Check, Moon, Sun, Settings2, Pause, Play, Minus, Square, X, WifiOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Logo } from "@/Logo";
import { Wizard } from "@/wizard/Wizard";
import { Panel } from "@/panel/Panel";
import { useTrame } from "@/api";
import { toast } from "sonner";
import { onTrayTogglePause, setAutostart } from "@/desktop";
import { cn } from "@/lib/utils";

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
  const [view, setView] = useState<"wizard" | "panel" | null>(null);
  const trame = useTrame();
  const configured = view === "panel";

  // Une fois le moteur joint, c'est lui qui dit si le wizard a déjà été fait ; hors ligne, wizard d'abord.
  // L'activation du wizard fige le choix, pour qu'un onboarded=true reçu en cours de route ne l'interrompe pas.
  useEffect(() => {
    if (view === null && trame.connected && trame.state.onboarded) setView("panel");
  }, [view, trame.connected, trame.state.onboarded]);
  const paused = trame.state.paused;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const togglePause = async (next: boolean) => {
    const res = await trame.setPaused(next);
    if (!res.ok) toast.error(next ? "Pause impossible" : "Reprise impossible", { description: res.error });
  };
  const togglePauseRef = useRef(togglePause);
  togglePauseRef.current = togglePause;
  useEffect(() => onTrayTogglePause(() => togglePauseRef.current(!pausedRef.current)), []);
  // Démarrage avec Windows activé au premier onboarding seulement, jamais en relançant le wizard.
  const firstRun = useRef(true);

  const mountedAt = useRef(Date.now());
  const [booting, setBooting] = useState(true);
  useEffect(() => {
    const max = setTimeout(() => setBooting(false), 4000);
    return () => clearTimeout(max);
  }, []);
  useEffect(() => {
    if (!trame.connected) return;
    const t = setTimeout(() => setBooting(false), Math.max(0, 1800 - (Date.now() - mountedAt.current)));
    return () => clearTimeout(t);
  }, [trame.connected]);

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
    <MotionConfig reducedMotion="user">
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
            <ConnectionBadge connected={trame.connected} demo={trame.demoMode} />

            {configured && (
              <div
                className={cn(
                  "flex items-center gap-2 rounded-full px-2.5 py-1 transition-colors duration-300",
                  paused ? "bg-warning/15" : "bg-secondary"
                )}
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={paused ? "p" : "a"}
                    initial={{ scale: 0, rotate: -90 }}
                    animate={{ scale: 1, rotate: 0 }}
                    exit={{ scale: 0, rotate: 90 }}
                    transition={{ type: "spring", stiffness: 500, damping: 25 }}
                  >
                    {paused ? <Pause className="size-3.5 text-warning" /> : <Play className="size-3.5 text-success" />}
                  </motion.span>
                </AnimatePresence>
                <span className="w-14 text-xs">{paused ? "En pause" : "Actif"}</span>
                <Switch checked={paused} onCheckedChange={togglePause} />
              </div>
            )}

            {configured && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={() => { firstRun.current = false; setView("wizard"); }}>
                    <Settings2 className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Relancer le wizard</TooltipContent>
              </Tooltip>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setDark(!dark)}>
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span
                      key={dark ? "sun" : "moon"}
                      initial={{ rotate: -90, scale: 0 }}
                      animate={{ rotate: 0, scale: 1 }}
                      exit={{ rotate: 90, scale: 0 }}
                      transition={{ type: "spring", stiffness: 500, damping: 25 }}
                    >
                      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
                    </motion.span>
                  </AnimatePresence>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Thème clair / sombre — Alt + D</TooltipContent>
            </Tooltip>
          </div>

          <WindowControls />
        </header>

        <main className="relative flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            {booting ? (
              <Splash key="splash" connected={trame.connected} />
            ) : (
              <motion.div key="app" className="h-full" initial={{ opacity: 0, scale: 0.99 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.3 }}>
                {configured ? <Panel trame={trame} /> : <Wizard trame={trame} onStart={() => setView((v) => v ?? "wizard")} onFinish={() => { setView("panel"); if (firstRun.current) setAutostart(true); }} />}
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
      <Toaster richColors position="bottom-right" />
    </TooltipProvider>
    </MotionConfig>
  );
}

function ConnectionBadge({ connected, demo }: { connected: boolean; demo: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-muted-foreground">
          <span className="relative grid size-2 place-items-center">
            {connected && (
              <motion.span
                className="absolute inset-0 rounded-full bg-success"
                animate={{ scale: [1, 2.4], opacity: [0.6, 0] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
              />
            )}
            <span className={cn("relative size-2 rounded-full transition-colors duration-300", connected ? "bg-success" : "bg-muted-foreground/50")} />
          </span>
          <span className="hidden sm:inline">{connected ? "En direct" : "Hors ligne"}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {connected
          ? "Connecté au moteur Trame"
          : demo
            ? "Moteur Trame injoignable — données d'exemple affichées"
            : "Moteur Trame injoignable — reconnexion en cours, aucune action possible"}
      </TooltipContent>
    </Tooltip>
  );
}

function Splash({ connected }: { connected: boolean }) {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 2600);
    return () => clearTimeout(t);
  }, []);
  const status = connected ? "ok" : waited ? "offline" : "boot";
  return (
    <motion.div
      className="absolute inset-0 flex flex-col items-center justify-center gap-5"
      exit={{ opacity: 0, scale: 1.03 }}
      transition={{ duration: 0.35 }}
    >
      <Logo size={96} animated />
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.25, duration: 0.4 }}
        className="flex flex-col items-center gap-1"
      >
        <span className="text-2xl font-semibold tracking-tight">Trame</span>
        <span className="text-sm text-muted-foreground">la trame de tes conversations</span>
      </motion.div>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.5 }}
        className="h-5 text-xs text-muted-foreground"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={status}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="flex items-center gap-1.5"
          >
            {status === "boot" && <><Loader2 className="size-3.5 animate-spin" /> Démarrage du moteur…</>}
            {status === "ok" && <><Check className="size-3.5 text-success" strokeWidth={3} /> Connecté</>}
            {status === "offline" && <><WifiOff className="size-3.5" /> Mode hors ligne</>}
          </motion.span>
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

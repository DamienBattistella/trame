import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Check, Moon, Sun, Settings2, Pause, Play, Minus, Square, X, WifiOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CountBadge } from "@/components/kit";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Logo } from "@/Logo";
import { useTrame } from "@/api";
import { TeamsWebRelay } from "@/components/TeamsWebRelay";
import { WhatsNew } from "@/components/Changelog";
import { UpdateLed } from "@/components/UpdateLed";
import type { PanelTab } from "@/panel/Panel";
import { toast } from "sonner";
import { isDesktop, onDesktopEvent, onTrayTogglePause, restartBackend, setAutostart } from "@/desktop";
import { cn } from "@/lib/utils";

// Chargés à part : le wizard ne sert qu'au premier lancement. Les deux téléchargements
// partent dès le démarrage, pendant l'écran de chargement, pour ne jamais faire attendre.
const loadWizard = () => import("@/wizard/Wizard");
const loadPanel = () => import("@/panel/Panel");
const Wizard = lazy(() => loadWizard().then((m) => ({ default: m.Wizard })));
const Panel = lazy(() => loadPanel().then((m) => ({ default: m.Panel })));
loadPanel();
loadWizard();

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
      <button className={`${base} hover:bg-destructive hover:text-destructive-foreground`} onClick={() => win?.close?.()} aria-label="Réduire dans la barre des tâches">
        <X className="size-4" />
      </button>
    </div>
  );
}

export default function App() {
  const [dark, setDark] = useState(true);
  const [view, setView] = useState<"wizard" | "panel" | null>(null);
  const trame = useTrame();
  const [panelTab, setPanelTab] = useState<PanelTab>("inbox");
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
  // Mise à jour au lancement (faite par l'application de bureau) : on prévient, sans rien demander.
  // Celles trouvées ensuite (toutes les 15 min) allument la LED de l'en-tête (UpdateLed).
  useEffect(() => {
    const offAvailable = onDesktopEvent<string>("update-available", (version) =>
      toast.info(`Mise à jour vers la version ${version}`, { description: "Téléchargement en cours. Trame redémarrera tout seul." })
    );
    const offFailed = onDesktopEvent("update-failed", () =>
      toast.error("Mise à jour impossible", { description: "Trame continue avec la version actuelle et réessaiera au prochain lancement." })
    );
    return () => {
      offAvailable();
      offFailed();
    };
  }, []);
  // Démarrage avec Windows activé au premier onboarding seulement, jamais en relançant le wizard.
  const firstRun = useRef(true);

  // Application installée dont le moteur ne répond toujours pas après 15 s : on le dit
  // franchement au lieu de dérouler un wizard qui ne peut rien faire.
  const [engineLate, setEngineLate] = useState(false);
  useEffect(() => {
    if (!isDesktop()) return;
    const t = setTimeout(() => setEngineLate(true), 15000);
    return () => clearTimeout(t);
  }, []);
  const engineDown = engineLate && !trame.everConnected;

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
      <Tabs
        value={panelTab}
        onValueChange={(v) => setPanelTab(v as PanelTab)}
        className="flex h-screen flex-col gap-0 overflow-hidden rounded-xl border bg-background text-foreground"
      >
        <header
          data-tauri-drag-region
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          className="relative flex h-12 select-none items-center gap-3 border-b bg-sidebar pl-4"
        >
          <Logo size={30} />
          <span className="text-sm font-semibold">Trame</span>

          {configured && !booting && !engineDown && (
            <div className="ml-3" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
              <TabsList aria-label="Sections" className="h-8 rounded-full">
                <TabsTrigger value="inbox" className="rounded-full px-3 text-xs">
                  Discussions <CountBadge n={trame.state.drafts.length} />
                </TabsTrigger>
                <TabsTrigger value="logs" className="rounded-full px-3 text-xs">Journal</TabsTrigger>
                <TabsTrigger value="settings" className="rounded-full px-3 text-xs">Réglages</TabsTrigger>
              </TabsList>
            </div>
          )}

          <div className="flex-1" />

          <div className="flex items-center gap-1.5 pr-2" style={noDrag}>
            <UpdateLed />
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
                <Switch aria-label="Mettre Trame en pause" checked={paused} onCheckedChange={togglePause} />
              </div>
            )}


            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={dark ? "Thème clair" : "Thème sombre"} onClick={() => setDark(!dark)}>
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
              <TooltipContent>Thème clair ou sombre (Alt + D)</TooltipContent>
            </Tooltip>
          </div>

          <WindowControls />
        </header>

        <main className="relative flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            {booting ? (
              <Splash key="splash" connected={trame.connected} />
            ) : engineDown ? (
              <EngineDown key="down" />
            ) : (
              <motion.div key="app" className="h-full" initial={{ opacity: 0, scale: 0.99 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.3 }}>
                <Suspense fallback={null}>
                  {configured ? (
                    <Panel
                      trame={trame}
                      tab={panelTab}
                      onTab={setPanelTab}
                      onRestartSetup={() => {
                        firstRun.current = false;
                        setPanelTab("inbox");
                        setView("wizard");
                      }}
                    />
                  ) : <Wizard trame={trame} onStart={() => setView((v) => v ?? "wizard")} onFinish={() => { setView("panel"); if (firstRun.current) setAutostart(true); }} />}
                </Suspense>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </Tabs>
      <TeamsWebRelay />
      <WhatsNew />
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
            {/* Une seule onde à la connexion : elle confirme le changement d'état, puis le point reste calme. */}
            <AnimatePresence>
              {connected && (
                <motion.span
                  key="ping"
                  className="absolute inset-0 rounded-full bg-success"
                  initial={{ scale: 1, opacity: 0.6 }}
                  animate={{ scale: 2.4, opacity: 0 }}
                  transition={{ duration: 1.2, ease: "easeOut" }}
                />
              )}
            </AnimatePresence>
            <span className={cn("relative size-2 rounded-full transition-colors duration-300", connected ? "bg-success" : "bg-muted-foreground/50")} />
          </span>
          <span className="hidden sm:inline">{connected ? "En direct" : demo ? "Données d'exemple" : "Hors ligne"}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {connected
          ? "Connecté au moteur Trame"
          : demo
            ? "Moteur injoignable : données d'exemple"
            : "Moteur injoignable : reconnexion en cours"}
      </TooltipContent>
    </Tooltip>
  );
}

function EngineDown() {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    await restartBackend();
    // Le moteur met quelques secondes à démarrer ; la connexion fermera cet écran.
    setTimeout(() => setRetrying(false), 12000);
  };
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <Logo size={56} />
      <h1 className="text-2xl font-semibold tracking-tight">Le moteur de Trame ne démarre pas</h1>
      <p className="max-w-md text-balance text-muted-foreground">
        Sans lui, Trame ne peut ni lire Teams ni préparer de réponse. Le détail de l'erreur est dans le fichier
        <span className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">%APPDATA%\Trame\backend.log</span>.
      </p>
      <Button className="mt-2 h-11 rounded-full px-8" disabled={retrying} onClick={retry}>
        {retrying ? <><Loader2 className="size-4 animate-spin" /> Redémarrage…</> : "Relancer le moteur"}
      </Button>
    </motion.div>
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

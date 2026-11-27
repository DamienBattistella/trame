import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Check, Minus, Square, X, WifiOff, Loader2, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Logo } from "@/Logo";
import { useTrame } from "@/api";
import { TeamsWebRelay } from "@/components/TeamsWebRelay";
import { WhatsNew } from "@/components/Changelog";
import { UpdateLed } from "@/components/UpdateLed";
import { AppRail } from "@/components/AppRail";
import { ShortcutsHelp } from "@/components/ShortcutsHelp";
import { isSwitcherKey, overlayOpen, requestSwitcher, sectionFromKey } from "@/lib/shortcuts";
import type { PanelTab } from "@/panel/Panel";
import { toast } from "sonner";
import { isDesktop, onDesktopEvent, onTrayTogglePause, restartBackend, setAutostart, setTrayBadge } from "@/desktop";
import { cn } from "@/lib/utils";
import { UndoAutoToasts } from "@/components/UndoAuto";

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
  // Pastille de l'icône de la zone de notification, comme Teams : une conversation attend
  // tant qu'elle est non lue ou qu'un brouillon est à relire. Moteur injoignable : éteinte.
  const pending = trame.connected ? pendingCount(trame.state.watchlist, trame.state.drafts) : 0;
  useEffect(() => void setTrayBadge(pending), [pending]);
  // Mise à jour au lancement (faite par l'application de bureau) : on prévient, sans rien demander.
  // Celles trouvées ensuite (toutes les 15 min) allument l'icône de mise à jour de l'en-tête (UpdateLed).
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

  // Ctrl+K depuis Journal ou Réglages : retour aux Discussions, où la palette s'ouvre
  // (dans l'onglet Discussions, c'est la liste elle-même qui l'écoute).
  const switchToInbox = useRef<() => boolean>(() => false);
  // Ctrl+1, 2, 3 et Ctrl+, : les sections du rail, une fois le panneau affiché.
  const goToSection = useRef<(t: PanelTab) => boolean>(() => false);
  goToSection.current = (t) => {
    if (!configured || overlayOpen()) return false;
    setPanelTab(t);
    return true;
  };
  switchToInbox.current = () => {
    if (!configured || panelTab === "inbox") return false;
    requestSwitcher();
    setPanelTab("inbox");
    return true;
  };

  // Alt+D bascule le thème de n'importe où, wizard compris ; le choix se règle aussi dans Réglages › Général.
  const toggleTheme = useRef(trame.toggleTheme);
  toggleTheme.current = trame.toggleTheme;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.shiftKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        toggleTheme.current();
      } else if (isSwitcherKey(e) && !e.defaultPrevented && switchToInbox.current()) {
        e.preventDefault();
      } else {
        const section = e.defaultPrevented ? null : sectionFromKey(e);
        if (section && goToSection.current(section)) e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const railShown = configured && !booting && !engineDown;
  const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

  return (
    <MotionConfig reducedMotion="user">
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col gap-0 overflow-hidden rounded-xl border bg-background text-foreground">
        {/* Barre de titre : la marque, un problème de connexion s'il y en a un, les boutons de la fenêtre.
            Tout le reste vit dans le rail, à gauche ; tant qu'il n'est pas là (wizard), la mise à jour reste ici. */}
        <header
          data-tauri-drag-region
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          className="relative flex h-12 shrink-0 select-none items-center gap-2 border-b bg-sidebar pr-0"
        >
          <span className="grid w-14 shrink-0 place-items-center lg:w-[4.5rem]">
            <Logo size={30} />
          </span>
          <span className="-ml-1 text-sm font-semibold lg:-ml-2">Trame</span>

          <div className="flex-1" />

          <div className="flex items-center gap-1.5 pr-2" style={noDrag}>
            <ConnectionBadge connected={trame.connected} demo={trame.demoMode} lost={trame.everConnected} />
            {!railShown && <UpdateLed />}
          </div>

          <WindowControls />
        </header>

        <main className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            {booting ? (
              <Splash key="splash" connected={trame.connected} />
            ) : engineDown ? (
              <EngineDown key="down" />
            ) : (
              <motion.div key="app" className="flex h-full" initial={{ opacity: 0, scale: 0.99 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.3 }}>
                {railShown && (
                  <AppRail
                    trame={trame}
                    tab={panelTab}
                    onTab={setPanelTab}
                    onTogglePause={togglePause}
                  />
                )}
                <div className="h-full min-w-0 flex-1">
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
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
      <TeamsWebRelay />
      <WhatsNew />
      <Toaster richColors position="bottom-right" />
      <UndoAutoToasts trame={trame} />
      <ShortcutsHelp />
    </TooltipProvider>
    </MotionConfig>
  );
}

/**
 * Rien quand tout va bien : l'en-tête ne parle de la connexion que si elle manque.
 * « Hors ligne » quand le moteur a été joint puis perdu (avant la première connexion,
 * le démarrage et l'écran « moteur injoignable » s'en chargent) ; « Données d'exemple »
 * en démo navigateur. Teams déconnecté ou modifié a son propre bandeau dans le panneau.
 */
function pendingCount(watchlist: { threadId: string; unread?: boolean }[], drafts: { threadId: string }[]): number {
  const ids = new Set(drafts.map((d) => d.threadId));
  for (const c of watchlist) if (c.unread) ids.add(c.threadId);
  return ids.size;
}

function ConnectionBadge({ connected, demo, lost }: { connected: boolean; demo: boolean; lost: boolean }) {
  const state = demo ? "demo" : !connected && lost ? "offline" : null;
  return (
    <AnimatePresence initial={false}>
      {state && (
        <motion.div
          key={state}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.2 }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                role="status"
                tabIndex={0}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  state === "offline" ? "bg-destructive/10 text-destructive" : "bg-secondary text-muted-foreground"
                )}
              >
                {state === "offline" ? <WifiOff className="size-3.5" /> : <FlaskConical className="size-3.5" />}
                {/* Sous 1024 px, l'en-tête n'a pas la place : icône seule, libellé en infobulle et pour les lecteurs d'écran. */}
                <span className="sr-only lg:not-sr-only">{state === "offline" ? "Hors ligne" : "Données d'exemple"}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {state === "offline" ? "Moteur injoignable : reconnexion en cours" : "Moteur injoignable : données d'exemple"}
            </TooltipContent>
          </Tooltip>
        </motion.div>
      )}
    </AnimatePresence>
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

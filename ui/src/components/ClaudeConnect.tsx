import { useEffect, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GroupList, pop, shake } from "@/components/kit";
import { openExternal } from "@/desktop";
import { cn } from "@/lib/utils";
import { Trame } from "@/api";
import { ClaudeLogo } from "@/brands";

const POLL_MS = 2000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_URL = "https://docs.claude.com/en/docs/claude-code/setup";

type View = "checking" | "unavailable" | "missing" | "disconnected" | "pending" | "connected";

const rowMotion = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: "auto" },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.2, ease: "easeOut" },
} as const;

/** Connexion de Claude Code (`claude auth login`) : état, navigateur, attente. */
export function ClaudeConnect({ trame, className }: { trame: Trame; className?: string }) {
  const status = trame.claudeStatus;
  const [busy, setBusy] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [justConnected, setJustConnected] = useState(false);
  const controls = useAnimationControls();

  const check = async () => {
    setCheckError(false);
    const res = await trame.getClaudeStatus();
    if (!res.ok) setCheckError(true);
    return res;
  };

  useEffect(() => {
    check();
  }, [trame.connected]);

  const pending = Boolean(status?.loginPending) || startedAt !== null;

  // Le navigateur termine la connexion : on relit l'état toutes les 2 s.
  useEffect(() => {
    if (!pending) return;
    const since = startedAt ?? Date.now();
    const id = setInterval(async () => {
      if (Date.now() - since > LOGIN_TIMEOUT_MS) {
        clearInterval(id);
        setStartedAt(null);
        await trame.cancelClaudeLogin();
        check();
        toast.error("Connexion à Claude expirée", { description: "Relance-la quand tu veux." });
        return;
      }
      const res = await trame.getClaudeStatus();
      if (res.ok && res.claude.loggedIn) {
        setStartedAt(null);
        setJustConnected(true);
      } else if (res.ok && !res.claude.loginPending) {
        setStartedAt(null);
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [pending, startedAt]);

  const fail = (title: string, error: string) => {
    controls.start(shake);
    toast.error(title, { description: `${error} Tu peux réessayer.` });
  };

  const start = async () => {
    setBusy(true);
    const res = await trame.claudeLogin();
    setBusy(false);
    if (!res.ok) {
      if (res.status === 409) {
        const cur = await check();
        if (cur.ok && cur.claude.loggedIn) return;
      }
      fail("Connexion à Claude impossible", res.error);
      return;
    }
    setStartedAt(Date.now());
    check();
  };

  const cancel = async () => {
    setBusy(true);
    const res = await trame.cancelClaudeLogin();
    setBusy(false);
    if (!res.ok) {
      fail("Annulation impossible", res.error);
      return;
    }
    setStartedAt(null);
    check();
  };

  const view: View = checkError
    ? "unavailable"
    : !status
      ? "checking"
      : !status.installed
        ? "missing"
        : status.loggedIn
          ? "connected"
          : pending
            ? "pending"
            : "disconnected";

  return (
    <motion.div animate={controls} className={cn("w-full", className)}>
      <GroupList>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={view} {...rowMotion} className="overflow-hidden">
            {view === "checking" && (
              <Row>
                <ClaudeMark />
                <span className="flex-1 text-sm text-muted-foreground">Vérification de Claude…</span>
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </Row>
            )}

            {view === "unavailable" && (
              <Row>
                <ClaudeMark />
                <span className="flex-1 text-sm text-muted-foreground">
                  {trame.connected ? "Vérification impossible" : "Moteur injoignable"}
                </span>
                <Button size="sm" variant="ghost" className="rounded-full" onClick={check}>
                  Réessayer
                </Button>
              </Row>
            )}

            {view === "missing" && (
              <Row>
                <ClaudeMark />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm">Claude Code n'est pas installé</span>
                  <span className="text-xs text-muted-foreground">Installe-le, puis reviens ici.</span>
                </div>
                <Button size="sm" variant="ghost" className="rounded-full" onClick={check}>
                  Vérifier
                </Button>
                <Button size="sm" variant="outline" className="rounded-full" onClick={() => openExternal(INSTALL_URL)}>
                  Installer
                </Button>
              </Row>
            )}

            {view === "disconnected" && (
              <Row>
                <ClaudeMark />
                <span className="flex-1 text-sm font-medium">Claude</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full border-primary/40 text-link hover:text-link"
                  disabled={busy}
                  onClick={start}
                >
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  Se connecter
                </Button>
              </Row>
            )}

            {view === "pending" && (
              <Row>
                <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">Suite dans le navigateur…</span>
                {status?.loginUrl && (
                  <Button size="sm" variant="outline" className="rounded-full" onClick={() => openExternal(status.loginUrl!)}>
                    Ouvrir
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="rounded-full" disabled={busy} onClick={cancel}>
                  Annuler
                </Button>
              </Row>
            )}

            {view === "connected" && status && (
              <Row>
                <ClaudeMark connected animate={justConnected} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{status.account ?? "Compte Claude"}</span>
                <span className="text-xs text-success">{status.plan ? `Connecté · ${status.plan}` : "Connecté"}</span>
              </Row>
            )}
          </motion.div>
        </AnimatePresence>
      </GroupList>
    </motion.div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-14 items-center gap-3 px-4 py-2.5 text-left">{children}</div>;
}

function ClaudeMark({ connected = false, animate = false }: { connected?: boolean; animate?: boolean }) {
  return (
    <span className="relative grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
      <ClaudeLogo className="size-4.5" />
      <AnimatePresence initial={animate}>
        {connected && (
          <motion.span
            key="ok"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ ...pop, delay: animate ? 0.15 : 0 }}
            className="absolute -right-0.5 -bottom-0.5 grid size-3.5 place-items-center rounded-full bg-success text-success-foreground ring-2 ring-card"
          >
            <Check className="size-2.5" strokeWidth={4} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

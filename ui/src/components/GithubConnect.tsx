import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { Check, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GroupList, Status, StatusDot, pop, shake } from "@/components/kit";
import { openExternal } from "@/desktop";
import { cn } from "@/lib/utils";
import { Trame } from "@/api";
import { GithubLogin } from "@/types";

const POLL_MS = 2000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const INSTALL_URL = "https://cli.github.com";
const SSO_URL = "https://github.com/settings/applications";

type PendingLogin = GithubLogin & { startedAt: number };

// Survit au démontage (changement d'étape du wizard, d'onglet du panneau) le temps de la session.
let pendingLogin: PendingLogin | null = null;

type View = "checking" | "unavailable" | "missing" | "disconnected" | "pending" | "expired" | "connected";

const rowMotion = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: "auto" },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.2, ease: "easeOut" },
} as const;

/** Connexion du compte GitHub (gh) : état, code à usage unique, attente, SSO. */
export function GithubConnect({ trame, className }: { trame: Trame; className?: string }) {
  const status = trame.githubStatus;
  const [login, setLogin] = useState<PendingLogin | null>(pendingLogin);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const [justConnected, setJustConnected] = useState(false);
  const controls = useAnimationControls();

  const keepLogin = (l: PendingLogin | null) => {
    pendingLogin = l;
    setLogin(l);
  };

  const check = async () => {
    setCheckError(false);
    const res = await trame.getGithubStatus();
    if (!res.ok) setCheckError(true);
    return res;
  };

  useEffect(() => {
    check();
  }, [trame.connected]);

  const waiting = Boolean(login) || Boolean(status?.loginPending && !status.loggedIn);

  // Attente de la saisie du code dans le navigateur : on relit l'état toutes les 2 s.
  useEffect(() => {
    if (!waiting || expired) return;
    let live = true;
    const startedAt = login?.startedAt ?? Date.now();
    const tick = async () => {
      if (!live) return;
      if (Date.now() - startedAt > LOGIN_TIMEOUT_MS) {
        setExpired(true);
        trame.cancelGithubLogin();
        return;
      }
      const res = await trame.getGithubStatus();
      if (!live || !res.ok) return;
      if (res.github.loggedIn) {
        keepLogin(null);
        setJustConnected(true);
      } else if (!res.github.loginPending) {
        setExpired(true);
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [waiting, expired, login?.startedAt]);

  useEffect(() => {
    if (status?.loggedIn && login) keepLogin(null);
  }, [status?.loggedIn]);

  const fail = (title: string, error: string) => {
    controls.start(shake);
    toast.error(title, { description: `${error} Rien n'a été perdu, tu peux réessayer.` });
  };

  const start = async () => {
    setBusy(true);
    const res = await trame.githubLogin();
    setBusy(false);
    if (!res.ok) {
      if (res.status === 409) {
        const cur = await check();
        if (cur.ok && cur.github.loggedIn) return;
      }
      fail("Connexion à GitHub impossible", res.error);
      return;
    }
    setExpired(false);
    keepLogin({ code: res.code, verificationUrl: res.verificationUrl, startedAt: Date.now() });
  };

  const cancel = async () => {
    setBusy(true);
    const res = await trame.cancelGithubLogin();
    setBusy(false);
    if (!res.ok) {
      fail("Annulation impossible", res.error);
      return;
    }
    keepLogin(null);
    setExpired(false);
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
          : expired && login
            ? "expired"
            : waiting && !expired
              ? "pending"
              : "disconnected";

  const sso = view === "connected" ? (status?.ssoBlocked ?? []) : [];

  return (
    <motion.div animate={controls} className={cn("w-full", className)}>
      <GroupList>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={view} {...rowMotion} className="overflow-hidden">
            {view === "checking" && (
              <Row>
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
                <span className="flex-1 text-sm text-muted-foreground">Vérification de la connexion GitHub…</span>
              </Row>
            )}

            {view === "unavailable" && (
              <Row>
                <span className="flex-1 text-sm text-muted-foreground">Impossible de vérifier la connexion GitHub.</span>
                <Button size="sm" variant="ghost" className="rounded-full" onClick={check}>
                  Réessayer
                </Button>
              </Row>
            )}

            {view === "missing" && (
              <Row>
                <span className="flex-1 text-sm">La commande gh n'est pas installée</span>
                <Button size="sm" variant="link" className="h-auto px-0" onClick={() => openExternal(INSTALL_URL)}>
                  Comment l'installer
                </Button>
              </Row>
            )}

            {view === "disconnected" && (
              <Row>
                <span className="flex-1 text-sm text-muted-foreground">Non connecté</span>
                <ConnectButton busy={busy} onClick={start} label="Se connecter à GitHub" />
              </Row>
            )}

            {view === "expired" && (
              <Row>
                <span className="flex-1 text-sm text-muted-foreground">Le code a expiré.</span>
                <ConnectButton busy={busy} onClick={start} label="Réessayer" />
              </Row>
            )}

            {view === "pending" && (
              <div className="divide-y divide-border">
                {login && <CodeRow login={login} />}
                <Row>
                  <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                  <span className="flex-1 text-sm text-muted-foreground">En attente de validation dans le navigateur…</span>
                  <Button size="sm" variant="ghost" className="rounded-full" disabled={busy} onClick={cancel}>
                    Annuler
                  </Button>
                </Row>
              </div>
            )}

            {view === "connected" && status && (
              <Row>
                <ConnectedDot animate={justConnected} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">
                    Connecté en tant que <span className="font-medium">{status.account ?? "ton compte"}</span>
                  </span>
                  {status.scopes.length > 0 && (
                    <span className="truncate text-xs text-muted-foreground">Accès : {status.scopes.join(", ")}</span>
                  )}
                </div>
              </Row>
            )}
          </motion.div>
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {sso.length > 0 && (
            <motion.div key="sso" {...rowMotion} className="overflow-hidden">
              <div className="flex items-start gap-3 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm text-warning">
                    {sso.length > 1
                      ? `Les organisations ${sso.join(", ")} demandent d'autoriser l'accès (SSO)`
                      : `L'organisation ${sso[0]} demande d'autoriser l'accès (SSO)`}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Autorise GitHub CLI pour cette organisation, puis relance la recherche.
                  </span>
                </div>
                <Button size="sm" variant="link" className="h-auto shrink-0 px-0 py-0.5" onClick={() => openExternal(SSO_URL)}>
                  Autoriser
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </GroupList>
    </motion.div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-14 items-center gap-3 px-4 py-2.5 text-left">{children}</div>;
}

function ConnectButton({ busy, onClick, label }: { busy: boolean; onClick: () => void; label: string }) {
  return (
    <Button
      size="sm"
      variant="outline"
      className="rounded-full border-primary/40 text-primary hover:text-primary"
      disabled={busy}
      onClick={onClick}
    >
      {busy && <Loader2 className="size-4 animate-spin" />}
      {label}
    </Button>
  );
}

/** Coche verte : rebondit une fois juste après la connexion, statique sinon. */
function ConnectedDot({ animate }: { animate: boolean }) {
  const [s, setS] = useState<Status>(animate ? "idle" : "ok");
  useEffect(() => {
    if (!animate) return;
    const t = setTimeout(() => setS("ok"), 120);
    return () => clearTimeout(t);
  }, []);
  return <StatusDot status={s} />;
}

function CodeRow({ login }: { login: GithubLogin }) {
  const [copied, setCopied] = useState(false);
  const controls = useAnimationControls();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(login.code);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      controls.start(shake);
      toast.error("Copie impossible", { description: "Le presse-papiers est indisponible. Recopie le code affiché." });
    }
  };

  return (
    <div className="flex flex-col gap-3 px-4 py-4 text-left">
      <span className="text-xs text-muted-foreground">Saisis ce code sur GitHub</span>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-mono text-2xl font-semibold tracking-[0.2em] tabular-nums select-all">{login.code}</span>
        <div className="flex gap-2">
          <motion.div animate={controls}>
            <Button
              size="sm"
              variant="ghost"
              className={cn("min-w-24 rounded-full transition-colors", copied && "text-success hover:text-success")}
              onClick={copy}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={copied ? "done" : "idle"}
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  transition={pop}
                  className="flex items-center gap-1.5"
                >
                  {copied ? <><Check className="size-4" strokeWidth={3} /> Copié</> : <><Copy className="size-4" /> Copier</>}
                </motion.span>
              </AnimatePresence>
            </Button>
          </motion.div>
          <Button size="sm" variant="outline" className="rounded-full" onClick={() => openExternal(login.verificationUrl)}>
            Ouvrir GitHub
          </Button>
        </div>
      </div>
    </div>
  );
}

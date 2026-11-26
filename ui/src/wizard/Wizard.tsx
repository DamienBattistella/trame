import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { Check, ChevronLeft, FileText, Loader2, PenLine, RotateCcw, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BrainPicker, BrainId } from "@/components/BrainPicker";
import { ConversationList } from "@/components/ConversationList";
import { SoulGhost } from "@/components/SoulGhost";
import { SoulHelp } from "@/components/SoulHelp";
import { GithubConnect } from "@/components/GithubConnect";
import { GroupList, InitialsAvatar, Segment, SelectCircle, StatusDot, Status, pop, shake } from "@/components/kit";
import { cn } from "@/lib/utils";
import { SOUL_MAX_BYTES, Trame } from "@/api";
import { mockConversations } from "@/mockData";
import { WatchEntity } from "@/types";

const TOTAL = 8;
const PROBE_CHECKS = ["Fenêtre Teams trouvée", "Liste des messages repérée", "Zone de saisie repérée"];

const slide = {
  enter: (dir: number) => ({ x: dir * 48, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir * -48, opacity: 0 }),
};

type Soul = { name: string; content: string };
type StepId = "settings" | "watchlist" | "soul";
type ActivationStep = { id: StepId; label: string; status: Status };

export function Wizard({ trame, onStart, onFinish }: { trame: Trame; onStart?: () => void; onFinish: () => void }) {
  const { connected, demoMode } = trame;
  const live = connected || demoMode;
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [brain, setBrain] = useState<BrainId>(trame.state.brain);
  const [probe, setProbe] = useState<"idle" | "running" | "ok" | "fail">("idle");
  const [probeDone, setProbeDone] = useState(0);
  const source = connected || !demoMode ? trame.state.watchlist : mockConversations;
  const [convs, setConvs] = useState<WatchEntity[]>(source);
  const touched = useRef(false);
  const [countdown, setCountdown] = useState(5);
  const [soul, setSoul] = useState<Soul | null>(null);
  const [activation, setActivation] = useState<"idle" | "run" | "ok" | "error">("idle");
  const [steps, setSteps] = useState<ActivationStep[]>([]);
  const [activationError, setActivationError] = useState<string | null>(null);
  const activateCtl = useAnimationControls();

  // Tant que l'utilisateur n'a rien coché, on suit la watchlist réelle du moteur. Ensuite
  // on garde ses choix, mais seulement pour des conversations que le moteur connaît :
  // jamais d'identifiants d'exemple envoyés au moteur.
  useEffect(() => {
    if (!touched.current) {
      setConvs(source);
      return;
    }
    if (!connected) return;
    setConvs((prev) => {
      const mine = new Map(prev.map((c) => [c.threadId, c]));
      return source.map((w) => {
        const c = mine.get(w.threadId);
        return c ? { ...w, watch: c.watch, mode: c.mode } : w;
      });
    });
  }, [source, connected]);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    trame.getSettings().then((res) => {
      if (!live || !res.ok || touched.current) return;
      setBrain(res.settings.brain);
      setCountdown(res.settings.safety.countdownSeconds);
    });
    return () => {
      live = false;
    };
  }, [connected]);

  const edit = (fn: (cs: WatchEntity[]) => WatchEntity[]) => {
    touched.current = true;
    setConvs(fn);
  };
  const watched = convs.filter((c) => c.watch);
  const autoCount = watched.filter((c) => c.mode === "auto").length;
  const draftCount = watched.length - autoCount;
  const setModeAll = (mode: "draft" | "auto") => edit((cs) => cs.map((c) => (c.watch ? { ...c, mode } : c)));
  const toggleWatch = (id: string) => edit((cs) => cs.map((c) => (c.threadId === id ? { ...c, watch: !c.watch } : c)));
  const setWatchMany = (ids: string[], watch: boolean) => {
    const set = new Set(ids);
    edit((cs) => cs.map((c) => (set.has(c.threadId) ? { ...c, watch } : c)));
  };
  const setMode = (id: string, mode: "draft" | "auto") =>
    edit((cs) => cs.map((c) => (c.threadId === id ? { ...c, mode } : c)));
  const pickBrain = (b: BrainId) => {
    touched.current = true;
    setBrain(b);
  };

  const [probeError, setProbeError] = useState<string | null>(null);
  const runProbe = async () => {
    setProbe("running");
    setProbeDone(0);
    setProbeError(null);
    const res = await trame.selftest();
    if (!res.ok) {
      setProbe("fail");
      setProbeError(res.error);
      return;
    }
    if (!res.selftestOk) {
      setProbe("fail");
      setProbeError("Teams n'est pas repéré. Ouvre une conversation et vérifie à nouveau. Tu peux continuer : tout restera en brouillon.");
      return;
    }
    for (let i = 1; i <= PROBE_CHECKS.length; i++) {
      setProbeDone(i);
      await new Promise((r) => setTimeout(r, 250));
    }
    setProbe("ok");
  };

  const go = (delta: number) => {
    if (activation === "error") {
      setActivation("idle");
      setSteps([]);
      setActivationError(null);
    }
    setDir(delta);
    setStep((n) => Math.min(TOTAL - 1, Math.max(0, n + delta)));
  };

  // « Réglages » (qui marque l'onboarding comme fait) passe en dernier : un échec avant
  // laisse le wizard à refaire, jamais un panneau sans watchlist.
  const plan = (): ActivationStep[] => [
    { id: "watchlist", label: `${watched.length} conversation${watched.length > 1 ? "s" : ""} suivie${watched.length > 1 ? "s" : ""}`, status: "idle" },
    ...(soul ? [{ id: "soul" as const, label: `Ta voix (${soul.name})`, status: "idle" as Status }] : []),
    { id: "settings", label: "Réglages enregistrés", status: "idle" },
  ];

  const runStep = async (id: StepId) => {
    if (id === "settings") {
      const cur = await trame.getSettings();
      if (!cur.ok) return cur;
      // GitHub n'est touché que si l'état de connexion est connu.
      const github = trame.githubStatus ? { github: { ...cur.settings.github, enabled: githubConnected } } : {};
      return trame.updateSettings({ brain, ...github, onboarded: true });
    }
    if (id === "watchlist") return trame.saveWatchlist(convs.map(({ threadId, watch, mode }) => ({ threadId, watch, mode })));
    return trame.uploadSoul(soul!.name, soul!.content);
  };

  /** Enchaîne les étapes ; une étape déjà réussie n'est pas rejouée au « Réessayer ». */
  const activate = async () => {
    if (!live) return;
    onStart?.();
    const todo = activation === "error" ? steps : plan();
    setSteps(todo);
    setActivation("run");
    setActivationError(null);
    for (const st of todo) {
      if (st.status === "ok") continue;
      const set = (status: Status) => setSteps((all) => all.map((x) => (x.id === st.id ? { ...x, status } : x)));
      set("run");
      const res = await runStep(st.id);
      if (!res.ok) {
        set("error");
        setActivation("error");
        setActivationError(res.error);
        activateCtl.start(shake);
        return;
      }
      set("ok");
    }
    setActivation("ok");
    setTimeout(onFinish, 700);
  };

  const githubConnected = trame.githubStatus?.loggedIn ?? false;
  const canContinue =
    (step !== 2 || probe === "ok" || probe === "fail") &&
    (activation === "idle" || activation === "error") &&
    (step !== TOTAL - 1 || live);
  const last = step === TOTAL - 1;
  // Étapes facultatives encore vides : le bouton principal devient « Plus tard », en retrait.
  const skippable = (step === 5 && !soul) || (step === 6 && !githubConnected);
  const canGoBack = step > 0 && activation !== "run" && activation !== "ok";

  const screens: { title: string; sub: string; body?: React.ReactNode }[] = [
    {
      title: "Bonjour",
      sub: "Trame lit tes conversations Teams et prépare tes réponses, dans ta voix. Sans toucher à ton compte.",
      body: (
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ ...pop, delay: 0.25 }}
          className={cn(
            "flex items-center gap-2 rounded-full px-3 py-1.5 text-sm",
            !live ? "bg-muted text-muted-foreground" : trame.state.selftestOk ? "bg-success/10 text-success" : "bg-warning/10 text-warning"
          )}
        >
          {!live ? (
            <><Loader2 className="size-4 animate-spin" /> Démarrage du moteur…</>
          ) : trame.state.selftestOk ? (
            <><Check className="size-4" /> Microsoft Teams détecté</>
          ) : (
            <>Teams n'est pas encore ouvert</>
          )}
        </motion.div>
      ),
    },
    {
      title: "Qui rédige ?",
      sub: "Tu pourras changer à tout moment.",
      body: <BrainPicker value={brain} onChange={pickBrain} />,
    },
    {
      title: "Vérification de Teams",
      sub: "Ouvre une conversation dans Teams, puis lance la vérification.",
      body: (
        <div className="flex w-full flex-col items-center gap-4">
          <GroupList>
            {PROBE_CHECKS.map((label, i) => {
              const status: Status =
                probeDone > i ? "ok" : probe === "fail" ? "error" : probe === "running" && probeDone === i ? "run" : "idle";
              return (
                <div key={label} className="flex items-center gap-3 px-4 py-3.5">
                  <StatusDot status={status} />
                  <span className={cn("flex-1 transition-colors duration-300", status === "idle" && "text-muted-foreground")}>{label}</span>
                </div>
              );
            })}
            <AnimatePresence initial={false}>
              {probe === "fail" && probeError && (
                <motion.div
                  key="fail"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <p role="alert" className="px-4 py-3 text-sm text-muted-foreground">{probeError}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </GroupList>
          <Button variant="outline" className="rounded-full px-6" disabled={probe === "running"} onClick={runProbe}>
            {probe === "running" && <Loader2 className="size-4 animate-spin" />}
            {probe === "ok" || probe === "fail" ? "Vérifier à nouveau" : probe === "running" ? "Vérification…" : "Vérifier"}
          </Button>
        </div>
      ),
    },
    {
      title: "Quelles conversations ?",
      sub: "Trame ne lit que celles que tu choisis.",
      body: (
        <ConversationList
          className="h-[clamp(6rem,calc(100dvh-30rem),26rem)]"
          items={convs}
          onBulk={setWatchMany}
          renderRow={(c) => (
            <motion.button
              type="button"
              role="checkbox"
              aria-checked={c.watch}
              whileTap={{ scale: 0.985 }}
              onClick={() => toggleWatch(c.threadId)}
              className="flex w-full items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent"
            >
              <InitialsAvatar name={c.displayName} className={cn("size-8", !c.watch && "opacity-50")} />
              <span className={cn("flex-1 truncate text-left transition-colors", !c.watch && "text-muted-foreground")}>{c.displayName}</span>
              <SelectCircle checked={c.watch} />
            </motion.button>
          )}
        />
      ),
    },
    {
      title: "Qui envoie ?",
      sub: "Pour chaque conversation : toi, ou Trame après un court délai.",
      body: (
        <div className="flex w-full flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 text-left">
            <ModeCard mode="draft" count={draftCount} total={watched.length} countdown={countdown} onAll={() => setModeAll("draft")} />
            <ModeCard mode="auto" count={autoCount} total={watched.length} countdown={countdown} onAll={() => setModeAll("auto")} />
          </div>
          <ConversationList
            className="h-[clamp(6rem,calc(100dvh-39rem),22rem)]"
            fewClassName="max-h-[clamp(6rem,calc(100dvh-39rem),22rem)]"
            items={watched}
            filters={false}
            footer={
              <span className="flex w-full justify-between gap-3">
                <span className="tabular-nums">
                  {draftCount} en brouillon · {autoCount} en auto
                </span>
                <span>Conseil : commence en brouillon.</span>
              </span>
            }
            renderRow={(c) => (
              <div className={cn("flex items-center gap-3 px-4 py-2.5 transition-colors duration-300", c.mode === "auto" && "bg-warning/[0.05]")}>
                <InitialsAvatar name={c.displayName} className="size-8" />
                <div className="flex min-w-0 flex-1 flex-col text-left">
                  <span className="truncate">{c.displayName}</span>
                  <span className="truncate text-xs text-muted-foreground">{SURFACE_HINT[c.surface]}</span>
                </div>
                <div className="shrink-0">
                  <Segment value={c.mode} onChange={(v) => setMode(c.threadId, v)} />
                </div>
              </div>
            )}
          />
        </div>
      ),
    },
    {
      title: "Ta voix",
      sub: "Dépose ton SOUL.md : ta façon d'écrire, ton rôle, ce que Trame doit refuser.",
      body: (
        <div className="flex w-full flex-col items-center gap-3">
          <SoulDrop value={soul} onChange={setSoul} />
          <SoulHelp />
        </div>
      ),
    },
    {
      title: "GitHub",
      sub: "Pour retrouver les PR et issues dont on te parle. En lecture seule.",
      body: (
        <div className="flex w-full flex-col gap-2">
          <GithubConnect trame={trame} />

        </div>
      ),
    },
    {
      title: "Tout est prêt",
      sub: "Rien ne part sans toi, sauf dans les conversations en Auto.",
      body: (
        <div className="flex w-full flex-col gap-3">
          <GroupList>
            {([
              ["Cerveau", brain === "claude" ? "Claude" : "Copilot"],
              ["Conversations", `${watched.length}`],
              ["En auto", `${watched.filter((c) => c.mode === "auto").length}`],
              ["GitHub", githubConnected ? `Connecté · ${trame.githubStatus?.account ?? ""}` : "Non connecté", !githubConnected],
              ["Ta voix", soul ? soul.name : "Plus tard", !soul],
            ] as [string, string, boolean?][]).map(([label, value, muted], i) => (
              <motion.div
                key={label}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 + i * 0.07 }}
                className="flex items-center justify-between px-4 py-3"
              >
                <span className="text-muted-foreground">{label}</span>
                <span className={cn("truncate pl-4", muted ? "text-muted-foreground" : "font-medium")}>{value}</span>
              </motion.div>
            ))}
          </GroupList>
          <AnimatePresence initial={false}>
            {steps.length > 0 && (
              <motion.div
                key="activation"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <motion.div animate={activateCtl}>
                  <GroupList>
                    {steps.map((st) => (
                      <div key={st.id} className="flex items-center gap-3 px-4 py-3">
                        <StatusDot status={st.status} />
                        <span
                          className={cn(
                            "flex-1 transition-colors duration-300",
                            st.status === "idle" && "text-muted-foreground",
                            st.status === "error" && "text-destructive"
                          )}
                        >
                          {st.label}
                        </span>
                      </div>
                    ))}
                    <AnimatePresence initial={false}>
                      {activationError && (
                        <motion.div
                          key="err"
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="px-4 py-3 text-sm text-destructive">
                            {activationError} Rien n'est perdu : tes choix sont gardés, tu peux réessayer.
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </GroupList>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ),
    },
  ];

  const s = screens[step];

  return (
    <div className="relative flex h-full flex-col">
      <AnimatePresence initial={false}>
        {canGoBack && (
          <motion.div
            key="back"
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -6 }}
            className="absolute top-4 left-4 z-10"
          >
            <Button variant="ghost" size="sm" className="gap-0.5 rounded-full pl-1.5 text-muted-foreground" onClick={() => go(-1)}>
              <ChevronLeft className="size-4" /> Retour
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex flex-1 items-center justify-center overflow-hidden px-6">
        <AnimatePresence mode="wait" custom={dir} initial={false}>
          <motion.div
            key={step}
            custom={dir}
            variants={slide}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="flex max-h-full w-full max-w-md flex-col items-center gap-6 overflow-y-auto pt-12 pb-4 text-center"
          >
            <div className="flex flex-col gap-2">
              <h1 className="text-3xl font-semibold tracking-tight text-balance">{s.title}</h1>
              <p className="text-balance text-muted-foreground">{s.sub}</p>
            </div>
            {s.body}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex shrink-0 flex-col items-center gap-4 px-6 pt-4 pb-8">
        <motion.div
          key={canContinue ? "on" : "off"}
          initial={canContinue && step === 2 ? { scale: 0.94 } : false}
          animate={{ scale: 1 }}
          transition={pop}
        >
          <Button
            size="lg"
            variant={skippable ? "secondary" : "default"}
            className={cn(
              "h-12 min-w-44 rounded-full px-10 text-base transition-colors",
              activation === "ok" && "bg-success hover:bg-success"
            )}
            disabled={!canContinue}
            onClick={() => (last ? activate() : go(1))}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={last ? activation : skippable ? "skip" : "next"}
                initial={{ y: 10, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -10, opacity: 0 }}
                className="flex items-center gap-2"
              >
                {!last && (skippable ? "Plus tard" : "Continuer")}
                {last && activation === "idle" && (live ? "Activer Trame" : <><Loader2 className="size-4 animate-spin" /> Démarrage du moteur…</>)}
                {last && activation === "run" && <><Loader2 className="size-4 animate-spin" /> Activation…</>}
                {last && activation === "ok" && <><Check className="size-4" strokeWidth={3} /> Terminé</>}
                {last && activation === "error" && <><RotateCcw className="size-4" /> Réessayer</>}
              </motion.span>
            </AnimatePresence>
          </Button>
        </motion.div>

        <div className="flex items-center gap-1.5">
          {Array.from({ length: TOTAL }).map((_, i) => (
            <motion.span
              key={i}
              animate={{ width: i === step ? 20 : 6 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className={cn("h-1.5 rounded-full transition-colors", i <= step ? "bg-primary" : "bg-muted-foreground/30", i < step && "bg-primary/50")}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SoulDrop({ value, onChange }: { value: Soul | null; onChange: (s: Soul) => void }) {
  const [state, setState] = useState<"idle" | "drag" | "ok" | "error">(value ? "ok" : "idle");
  const [error, setError] = useState("");
  const file = value ? { name: value.name, lines: value.content.split("\n").length } : null;
  const input = useRef<HTMLInputElement>(null);
  const controls = useAnimationControls();

  const reject = (msg: string) => {
    setError(msg);
    setState("error");
    controls.start(shake);
    setTimeout(() => setState((cur) => (cur === "error" ? (value ? "ok" : "idle") : cur)), 2600);
  };

  const accept = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.(md|txt)$/i.test(f.name)) return reject("Seuls les fichiers .md ou .txt sont acceptés");
    if (f.size > SOUL_MAX_BYTES) return reject("Fichier trop lourd : 64 Ko maximum");
    onChange({ name: f.name, content: await f.text() });
    setState("ok");
  };

  return (
    <motion.div animate={controls} className="w-full">
      <motion.div
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (state !== "drag") setState("drag");
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setState(file ? "ok" : "idle");
        }}
        onDrop={(e) => {
          e.preventDefault();
          accept(e.dataTransfer.files[0]);
        }}
        animate={{ scale: state === "drag" ? 1.02 : 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 25 }}
        className={cn(
          "flex w-full cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed p-7 transition-colors duration-200",
          state === "idle" && "text-muted-foreground hover:border-primary/60 hover:text-foreground",
          state === "drag" && "border-primary bg-primary/5 text-foreground",
          state === "ok" && "border-success/60 bg-success/5 text-foreground",
          state === "error" && "border-destructive/60 bg-destructive/5 text-foreground"
        )}
      >
        <input ref={input} type="file" accept=".md,.txt" className="hidden" onChange={(e) => accept(e.target.files?.[0])} />
        <SoulGhost state={state} />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={state === "ok" ? "ok" : state}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, delay: state === "ok" ? 0.4 : 0 }}
            className="flex flex-col items-center gap-0.5 text-center"
          >
            {state === "ok" && file ? (
              <>
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <FileText className="size-4" /> {file.name}
                </span>
                <span className="text-xs text-muted-foreground">Ta voix est prête · {file.lines} lignes · clique pour remplacer</span>
              </>
            ) : (
              <span className="text-sm">
                {state === "drag" ? "Lâche, je l'attrape" : state === "error" ? error : "Glisse ton SOUL.md ici ou clique pour choisir"}
              </span>
            )}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

const SURFACE_HINT = {
  dm: "Privé · à chaque message",
  group: "Groupe · si on te mentionne",
  channel: "Canal · si on te mentionne",
} as const;

function ModeCard({
  mode,
  count,
  total,
  countdown,
  onAll,
}: {
  mode: "draft" | "auto";
  count: number;
  total: number;
  countdown: number;
  onAll: () => void;
}) {
  const auto = mode === "auto";
  const allSet = total > 0 && count === total;
  return (
    <Card
      className={cn(
        "gap-1.5 rounded-2xl p-3.5 shadow-none transition-colors duration-300",
        auto && count > 0 && "border-warning/40 bg-warning/5"
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className={cn("grid size-8 place-items-center rounded-full", auto ? "bg-warning/15 text-warning" : "bg-primary/10 text-link")}>
          {auto ? <Timer className="size-4" /> : <PenLine className="size-4" />}
        </span>
        <span className="font-semibold">{auto ? "Auto" : "Brouillon"}</span>
        <span className="relative ml-auto h-7 overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={count}
              initial={{ y: 14, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -14, opacity: 0 }}
              transition={pop}
              className={cn("block text-xl font-semibold tabular-nums", auto && count > 0 && "text-warning")}
            >
              {count}
            </motion.span>
          </AnimatePresence>
        </span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {auto ? (
          <>
            Envoi seul après <strong className="font-medium text-foreground">{countdown} s</strong>, annulable par la pause.
          </>
        ) : (
          "Trame prépare, tu relis et tu envoies."
        )}
      </p>
      <button
        onClick={onAll}
        disabled={allSet}
        className="mt-auto self-start text-xs font-medium text-link transition-opacity hover:underline disabled:pointer-events-none disabled:opacity-40"
      >
        {allSet ? `Toutes en ${auto ? "auto" : "brouillon"}` : `Tout en ${auto ? "auto" : "brouillon"}`}
      </button>
    </Card>
  );
}

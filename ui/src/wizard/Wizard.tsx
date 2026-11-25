import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { ArrowRight, Check, FileText, GitBranch, Loader2, RotateCcw, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { BrainPicker, BrainId } from "@/components/BrainPicker";
import { ConversationList } from "@/components/ConversationList";
import { GroupList, InitialsAvatar, Segment, SelectCircle, StatusDot, Status, pop, shake } from "@/components/kit";
import { cn } from "@/lib/utils";
import { SOUL_MAX_BYTES, Trame } from "@/api";
import { mockConversations } from "@/mockData";
import { WatchEntity } from "@/types";

const TOTAL = 8;
const PROBE_CHECKS = ["Fenêtre Teams trouvée", "Dernier message lu", "Zone de saisie repérée"];

const slide = {
  enter: (dir: number) => ({ x: dir * 48, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir * -48, opacity: 0 }),
};

type Soul = { name: string; content: string };
type StepId = "settings" | "watchlist" | "soul";
type ActivationStep = { id: StepId; label: string; status: Status };

export function Wizard({ trame, onStart, onFinish }: { trame: Trame; onStart?: () => void; onFinish: () => void }) {
  const { connected } = trame;
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [brain, setBrain] = useState<BrainId>(trame.state.brain);
  const [probe, setProbe] = useState<"idle" | "running" | "ok">("idle");
  const [probeDone, setProbeDone] = useState(0);
  const source = connected ? trame.state.watchlist : mockConversations;
  const [convs, setConvs] = useState<WatchEntity[]>(source);
  const touched = useRef(false);
  const [github, setGithub] = useState(true);
  const [soul, setSoul] = useState<Soul | null>(null);
  const [activation, setActivation] = useState<"idle" | "run" | "ok" | "error">("idle");
  const [steps, setSteps] = useState<ActivationStep[]>([]);
  const [activationError, setActivationError] = useState<string | null>(null);
  const activateCtl = useAnimationControls();

  // Tant que l'utilisateur n'a rien coché, on suit la watchlist réelle du moteur.
  useEffect(() => {
    if (!touched.current) setConvs(source);
  }, [source]);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    trame.getSettings().then((res) => {
      if (!live || !res.ok || touched.current) return;
      setBrain(res.settings.brain);
      setGithub(res.settings.github.enabled);
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
  const pickGithub = (v: boolean) => {
    touched.current = true;
    setGithub(v);
  };

  const runProbe = () => {
    setProbe("running");
    setProbeDone(0);
    PROBE_CHECKS.forEach((_, i) =>
      setTimeout(() => {
        setProbeDone(i + 1);
        if (i === PROBE_CHECKS.length - 1) setProbe("ok");
      }, 600 * (i + 1))
    );
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

  const plan = (): ActivationStep[] => [
    { id: "settings", label: "Réglages enregistrés", status: "idle" },
    { id: "watchlist", label: `${watched.length} conversation${watched.length > 1 ? "s" : ""} sous surveillance`, status: "idle" },
    ...(soul ? [{ id: "soul" as const, label: `Ta voix importée (${soul.name})`, status: "idle" as Status }] : []),
  ];

  const runStep = async (id: StepId) => {
    if (id === "settings") {
      const cur = await trame.getSettings();
      if (!cur.ok) return cur;
      return trame.updateSettings({ brain, github: { ...cur.settings.github, enabled: github }, onboarded: true });
    }
    if (id === "watchlist") return trame.saveWatchlist(convs.map(({ threadId, watch, mode }) => ({ threadId, watch, mode })));
    return trame.uploadSoul(soul!.name, soul!.content);
  };

  /** Enchaîne les étapes ; une étape déjà réussie n'est pas rejouée au « Réessayer ». */
  const activate = async () => {
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

  const canContinue = (step !== 2 || probe === "ok") && (activation === "idle" || activation === "error");
  const last = step === TOTAL - 1;

  const screens: { title: string; sub: string; body?: React.ReactNode }[] = [
    {
      title: "Bienvenue dans Trame",
      sub: "Ton assistant répond sur Teams, dans ta voix, en pilotant l'app — sans toucher à ta connexion.",
      body: (
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ ...pop, delay: 0.25 }}
          className="flex items-center gap-2 rounded-full bg-success/10 px-3 py-1.5 text-sm text-success"
        >
          <Check className="size-4" /> Microsoft Teams détecté
        </motion.div>
      ),
    },
    {
      title: "Choisis le cerveau",
      sub: "Qui rédige tes réponses. Modifiable à tout moment.",
      body: <BrainPicker value={brain} onChange={pickBrain} />,
    },
    {
      title: "Un petit test",
      sub: "Envoie-toi un message sur Teams, puis lance le test : Trame vérifie qu'il sait le lire et répondre.",
      body: (
        <div className="flex w-full flex-col items-center gap-4">
          <GroupList>
            {PROBE_CHECKS.map((label, i) => {
              const status: Status = probeDone > i ? "ok" : probe === "running" && probeDone === i ? "run" : "idle";
              return (
                <div key={label} className="flex items-center gap-3 px-4 py-3.5">
                  <StatusDot status={status} />
                  <span className={cn("flex-1 transition-colors duration-300", status === "idle" && "text-muted-foreground")}>{label}</span>
                </div>
              );
            })}
            <AnimatePresence initial={false}>
              {probe === "ok" && (
                <motion.div
                  key="preview"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="px-4 py-3">
                    <div className="text-xs text-muted-foreground">Ce que Trame a lu</div>
                    <div className="mt-1 rounded-xl bg-muted/50 px-3 py-2 text-sm">« Test Trame 👋 »</div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </GroupList>
          <Button variant="outline" className="rounded-full px-6" disabled={probe === "running"} onClick={runProbe}>
            {probe === "running" && <Loader2 className="size-4 animate-spin" />}
            {probe === "ok" ? "Relancer le test" : probe === "running" ? "Test en cours…" : "Lancer le test"}
          </Button>
        </div>
      ),
    },
    {
      title: "Qui surveiller ?",
      sub: "Coche les conversations que Trame doit suivre. Recherche et filtres pour aller vite.",
      body: (
        <ConversationList
          items={convs}
          onBulk={setWatchMany}
          renderRow={(c) => (
            <motion.button
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
      title: "Brouillon ou auto ?",
      sub: "Brouillon : tu valides. Auto : Trame envoie après un court délai annulable.",
      body: (
        <ConversationList
          items={watched}
          filters={false}
          renderRow={(c) => (
            <div className="flex items-center gap-3 px-4 py-2.5">
              <InitialsAvatar name={c.displayName} className="size-8" />
              <span className="flex-1 truncate">{c.displayName}</span>
              <Segment value={c.mode} onChange={(v) => setMode(c.threadId, v)} />
            </div>
          )}
        />
      ),
    },
    {
      title: "Ta voix",
      sub: "Dépose ton SOUL.md — ta façon d'écrire, ton rôle, ce que Trame refuse. Ou plus tard.",
      body: <SoulDrop value={soul} onChange={setSoul} />,
    },
    {
      title: "Contexte GitHub",
      sub: "En lecture seule, consulté quand un message parle code. Trame n'écrit jamais.",
      body: (
        <GroupList>
          <div className="flex items-center gap-3 px-4 py-3.5">
            <GitBranch className={cn("size-5 transition-colors", github ? "text-primary" : "text-muted-foreground")} />
            <span className="flex-1">Activer le contexte GitHub</span>
            <Switch checked={github} onCheckedChange={pickGithub} />
          </div>
        </GroupList>
      ),
    },
    {
      title: "Tout est prêt",
      sub: "Trame veille sur tes conversations et te propose des réponses. Tu gardes la main.",
      body: (
        <div className="flex w-full flex-col gap-3">
          <GroupList>
            {[
              ["Cerveau", brain === "claude" ? "Claude" : "Copilot"],
              ["Surveillées", `${watched.length}`],
              ["En auto", `${watched.filter((c) => c.mode === "auto").length}`],
              ["GitHub", github ? "Activé" : "Désactivé"],
              ["Ta voix", soul ? soul.name : "Plus tard"],
            ].map(([label, value], i) => (
              <motion.div
                key={label}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 + i * 0.07 }}
                className="flex items-center justify-between px-4 py-3"
              >
                <span className="text-muted-foreground">{label}</span>
                <span className="truncate pl-4 font-medium">{value}</span>
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
    <div className="flex h-full flex-col">
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
            className="flex max-h-full w-full max-w-md flex-col items-center gap-6 overflow-y-auto py-8 text-center"
          >
            <div className="flex flex-col gap-2">
              <h1 className="text-3xl font-semibold tracking-tight text-balance">{s.title}</h1>
              <p className="text-balance text-muted-foreground">{s.sub}</p>
            </div>
            {s.body}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex flex-col items-center gap-4 px-6 pb-8">
        <motion.div
          key={canContinue ? "on" : "off"}
          initial={canContinue && step === 2 ? { scale: 0.94 } : false}
          animate={{ scale: 1 }}
          transition={pop}
        >
          <Button
            size="lg"
            className={cn(
              "h-12 min-w-44 rounded-full px-10 text-base transition-colors",
              activation === "ok" && "bg-success hover:bg-success"
            )}
            disabled={!canContinue}
            onClick={() => (last ? activate() : go(1))}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={last ? activation : "next"}
                initial={{ y: 10, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -10, opacity: 0 }}
                className="flex items-center gap-2"
              >
                {!last && <>Continuer <ArrowRight className="size-4" /></>}
                {last && activation === "idle" && "Activer Trame"}
                {last && activation === "run" && <><Loader2 className="size-4 animate-spin" /> Activation…</>}
                {last && activation === "ok" && <><Check className="size-4" strokeWidth={3} /> C'est parti</>}
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

        <button
          onClick={() => go(-1)}
          className={cn("text-sm text-muted-foreground transition-opacity hover:text-foreground", (step === 0 || activation === "run" || activation === "ok") && "pointer-events-none opacity-0")}
        >
          Retour
        </button>
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
        onDragLeave={() => setState(file ? "ok" : "idle")}
        onDrop={(e) => {
          e.preventDefault();
          accept(e.dataTransfer.files[0]);
        }}
        animate={{ scale: state === "drag" ? 1.02 : 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 25 }}
        className={cn(
          "flex w-full cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed p-8 transition-colors duration-200",
          state === "idle" && "text-muted-foreground hover:border-primary/60 hover:text-foreground",
          state === "drag" && "border-primary bg-primary/5 text-foreground",
          state === "ok" && "border-success/60 bg-success/5 text-foreground",
          state === "error" && "border-destructive/60 bg-destructive/5 text-foreground"
        )}
      >
        <input ref={input} type="file" accept=".md,.txt" className="hidden" onChange={(e) => accept(e.target.files?.[0])} />
        <AnimatePresence mode="popLayout" initial={false}>
          {state === "ok" && file ? (
            <motion.div key="ok" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={pop} className="flex flex-col items-center gap-2">
              <span className="grid size-10 place-items-center rounded-full bg-success text-white">
                <Check className="size-5" strokeWidth={3} />
              </span>
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <FileText className="size-4" /> {file.name}
              </span>
              <span className="text-xs text-muted-foreground">{file.lines} lignes · clique pour remplacer</span>
            </motion.div>
          ) : (
            <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-2">
              <motion.span animate={{ y: state === "drag" ? -4 : 0 }}>
                <UploadCloud className={cn("size-7", state === "drag" && "text-primary")} />
              </motion.span>
              <span className="text-sm">
                {state === "drag" ? "Lâche pour déposer" : state === "error" ? error : "Glisse ton SOUL.md ici ou clique pour choisir"}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

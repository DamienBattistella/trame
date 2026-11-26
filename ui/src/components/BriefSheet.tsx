import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import {
  Check,
  CircleDot,
  Copy,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GroupList, InitialsAvatar, SectionLabel, Status, StatusDot, pop, shake, spring } from "@/components/kit";
import { openExternal } from "@/desktop";
import { cn } from "@/lib/utils";
import { Trame } from "@/api";
import { Brief, BriefGithubItem } from "@/types";

export interface BriefTarget {
  threadId: string;
  displayName: string;
}

type Phase = "loading" | "empty" | "generating" | "done" | "error";

// Le POST est un seul appel : les deux premières étapes avancent au minuteur, la fin suit la réponse.
const STEP_DELAYS = [1100, 2600];

export function BriefSheet({
  trame,
  target,
  onClose,
  dock = false,
}: {
  trame: Trame;
  target: BriefTarget | null;
  onClose: () => void;
  /** Panneau ancré à droite de la discussion (comme T3 Code), au lieu d'un tiroir. */
  dock?: boolean;
}) {
  const [shown, setShown] = useState<BriefTarget | null>(target);
  const [phase, setPhase] = useState<Phase>("loading");
  const [steps, setSteps] = useState<Status[]>(["idle", "idle", "idle"]);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [previous, setPrevious] = useState<Brief | null>(null);
  const seq = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const progressCtl = useAnimationControls();
  const { lastMessages, github } = trame.briefPrefs;

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const generate = async (t: BriefTarget, prev: Brief | null) => {
    const n = ++seq.current;
    clearTimers();
    setPrevious(prev);
    setPhase("generating");
    setSteps(["run", "idle", "idle"]);
    timers.current.push(setTimeout(() => setSteps(["ok", "run", "idle"]), STEP_DELAYS[0]));
    if (github) timers.current.push(setTimeout(() => setSteps(["ok", "ok", "run"]), STEP_DELAYS[1]));

    const res = await trame.generateBrief(t.threadId);
    if (n !== seq.current) return;
    clearTimers();
    if (!res.ok) {
      // La progression est indicative : l'étape en échec vient de la réponse du moteur.
      // 409 = conversation non ouverte dans Teams ou partage d'écran : c'est la lecture.
      const readFailed = res.status === 409 || /lecture|teams/i.test(res.error);
      setSteps((s) => {
        const running = s.findIndex((x) => x === "run");
        const failed = readFailed ? 0 : running < 0 ? 0 : running;
        return s.map((x, j) => (j === failed ? "error" : j < failed ? "ok" : "idle"));
      });
      setPhase("error");
      progressCtl.start(shake);
      toast.error(`Résumé impossible pour « ${t.displayName} »`, {
        description: `${res.error} Rien n'a été perdu${prev ? ", le résumé précédent est conservé" : ""}.`,
      });
      return;
    }
    setSteps(["ok", "ok", "ok"]);
    // Laisse la dernière coche rebondir avant d'afficher le résultat.
    timers.current.push(
      setTimeout(() => {
        if (n !== seq.current) return;
        setBrief(res.brief);
        setPhase("done");
      }, 550)
    );
  };

  useEffect(() => {
    if (!target) {
      seq.current++;
      clearTimers();
      return;
    }
    setShown(target);
    setBrief(null);
    setPrevious(null);
    setPhase("loading");
    const n = ++seq.current;
    trame.getGithubStatus();
    trame.getBrief(target.threadId).then((res) => {
      if (n !== seq.current) return;
      if (res.ok && res.brief) {
        setBrief(res.brief);
        setPhase("done");
      } else if (!res.ok && res.status === 404) {
        setSteps(["error", "idle", "idle"]);
        setPhase("error");
        progressCtl.start(shake);
        toast.error(`Résumé impossible pour « ${target.displayName} »`, {
          description: `${res.error} Rien n'a été perdu.`,
        });
      } else if (dock) {
        // Le panneau suit la discussion choisie : on ne lance pas un appel au cerveau
        // à chaque clic dans la barre latérale, seulement à la demande.
        setPhase("empty");
      } else {
        generate(target, null);
      }
    });
  }, [target?.threadId]);

  useEffect(() => clearTimers, []);

  const stepRows = [
    `Lecture des ${lastMessages} derniers messages`,
    "Résumé de la discussion",
    ...(github ? ["Recherche GitHub"] : []),
  ];

  const Header = dock ? DockHeader : SheetHeader;
  const Title = dock ? DockTitle : SheetTitle;
  const Description = dock ? DockDescription : SheetDescription;
  const Footer = dock ? DockFooter : SheetFooter;

  const content = (
    <>
        <Header className="flex-row items-center gap-3 px-5 py-4 pr-12">
          <InitialsAvatar name={shown?.displayName ?? ""} />
          <div className="flex min-w-0 flex-col">
            <Title className="truncate">{shown?.displayName}</Title>
            <Description className="text-xs">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={phase === "done" && brief ? brief.generatedAt : phase}
                  initial={{ y: 6, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -6, opacity: 0 }}
                  className="inline-block"
                >
                  {phase === "done" && brief
                    ? `Généré à ${brief.generatedAt}`
                    : phase === "loading" || phase === "empty"
                      ? "Résumé et contexte"
                      : phase === "error"
                        ? "La génération n'a pas abouti"
                        : "Génération en cours…"}
                </motion.span>
              </AnimatePresence>
            </Description>
          </div>
          {dock && (
            <Button variant="ghost" size="icon" className="absolute top-3.5 right-3 size-8 rounded-full" aria-label="Fermer le résumé" onClick={onClose}>
              <X className="size-4" />
            </Button>
          )}
        </Header>
        <Separator />

        <ScrollArea className="min-h-0 flex-1">
          <AnimatePresence mode="wait" initial={false}>
            {phase === "loading" && (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
              >
                <Loader2 className="size-4 animate-spin" /> Recherche d'un brief récent…
              </motion.div>
            )}

            {phase === "empty" && shown && (
              <motion.div
                key="empty"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center gap-3 px-6 py-16 text-center"
              >
                <p className="text-sm text-muted-foreground">Pas encore de résumé pour cette discussion.</p>
                <Button size="sm" className="rounded-full" onClick={() => generate(shown, null)}>
                  <RefreshCw className="size-4" /> Résumer
                </Button>
              </motion.div>
            )}

            {(phase === "generating" || phase === "error") && (
              <motion.div
                key="progress"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="flex flex-col gap-4 px-5 py-5"
              >
                <motion.div animate={progressCtl}>
                  <GroupList>
                  {stepRows.map((label, i) => (
                    <div key={label} className="flex items-center gap-3 px-4 py-3">
                      <StatusDot status={steps[i]} />
                      <span
                        className={cn(
                          "text-sm transition-colors duration-300",
                          steps[i] === "idle" && "text-muted-foreground",
                          steps[i] === "error" && "text-destructive"
                        )}
                      >
                        {label}
                      </span>
                    </div>
                  ))}
                  </GroupList>
                </motion.div>
                <AnimatePresence>
                  {phase === "error" && shown && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="flex gap-2 overflow-hidden"
                    >
                      <Button size="sm" className="rounded-full" onClick={() => generate(shown, previous)}>
                        <RotateCcw className="size-4" /> Réessayer
                      </Button>
                      {previous && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="rounded-full"
                          onClick={() => {
                            setBrief(previous);
                            setPhase("done");
                          }}
                        >
                          Revenir au brief précédent
                        </Button>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}

            {phase === "done" && brief && (
              <motion.div key={`done-${brief.generatedAt}`} exit={{ opacity: 0 }}>
                <BriefResult brief={brief} githubConnected={trame.githubStatus?.loggedIn ?? true} />
              </motion.div>
            )}
          </AnimatePresence>
        </ScrollArea>

        <AnimatePresence initial={false}>
          {phase === "done" && brief && shown && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              transition={spring}
            >
              <Separator />
              <Footer className="mt-0 gap-2 px-5 py-3">
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="rounded-full" onClick={() => generate(shown, brief)}>
                  <RefreshCw className="size-4" /> Régénérer
                </Button>
                <CopyButton brief={brief} />
              </div>
              <span className="text-xs text-muted-foreground tabular-nums">
                Basé sur {brief.sources.messages} message{brief.sources.messages > 1 ? "s" : ""} ·{" "}
                {brief.sources.reposSearched} dépôt{brief.sources.reposSearched > 1 ? "s" : ""} consulté
                {brief.sources.reposSearched > 1 ? "s" : ""}
              </span>
              </Footer>
            </motion.div>
          )}
        </AnimatePresence>
    </>
  );

  if (dock) {
    return <div className="relative flex h-full min-h-0 flex-col">{content}</div>;
  }
  return (
    <Sheet open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-[480px]" onOpenAutoFocus={(e) => e.preventDefault()}>
        {content}
      </SheetContent>
    </Sheet>
  );
}

const list = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };
const item = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: spring } };

function BriefResult({ brief, githubConnected }: { brief: Brief; githubConnected: boolean }) {
  return (
    <motion.div variants={list} initial="hidden" animate="show" className="flex flex-col gap-6 px-5 py-5">
      <motion.section variants={item}>
        <SectionLabel>Résumé</SectionLabel>
        <GroupList className="px-4 py-3 text-sm leading-relaxed">{brief.summary}</GroupList>
      </motion.section>

      {brief.openPoints.length > 0 && (
        <motion.section variants={item}>
          <SectionLabel>Points ouverts</SectionLabel>
          <GroupList>
            {brief.openPoints.map((p) => (
              <div key={p} className="px-4 py-2.5 text-sm">
                {p}
              </div>
            ))}
          </GroupList>
        </motion.section>
      )}

      {brief.topics.length > 0 && (
        <motion.section variants={item}>
          <SectionLabel>Sujets</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {brief.topics.map((t) => (
              <Badge key={t} variant="secondary" className="font-normal text-muted-foreground">
                {t}
              </Badge>
            ))}
          </div>
        </motion.section>
      )}

      <motion.section variants={item}>
        <SectionLabel>Sur GitHub</SectionLabel>
        {!brief.githubEnabled || brief.github.length === 0 ? (
          <GroupList className="px-4 py-3 text-sm text-muted-foreground">
            {!brief.githubEnabled
              ? "Contexte GitHub désactivé dans les réglages."
              : githubConnected
                ? "Rien trouvé sur GitHub pour ces sujets."
                : "Connecte GitHub dans Réglages pour chercher le contexte."}
          </GroupList>
        ) : (
          <GroupList>
            <motion.div variants={list} className="divide-y divide-border">
              {brief.github.map((g) => (
                <GithubRow key={g.url} g={g} />
              ))}
            </motion.div>
          </GroupList>
        )}
      </motion.section>
    </motion.div>
  );
}

const KIND_ICON = { pr: GitPullRequest, issue: CircleDot, commit: GitCommitHorizontal } as const;
const STATE = {
  open: { label: "ouverte", className: "bg-success/15 text-success" },
  merged: { label: "fusionnée", className: "bg-primary/15 text-link" },
  closed: { label: "fermée", className: "bg-secondary text-muted-foreground" },
} as const;

function GithubRow({ g }: { g: BriefGithubItem }) {
  const Icon = KIND_ICON[g.kind] ?? CircleDot;
  const state = g.state ? STATE[g.state] : null;
  return (
    <motion.button
      variants={item}
      onClick={() => openExternal(g.url)}
      title={g.url}
      className="flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-accent"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">
            {g.repo}
            {g.number !== null && `#${g.number}`}
          </span>
          {state && <Badge className={cn("px-1.5 py-0 font-normal", state.className)}>{state.label}</Badge>}
        </div>
        <span className="text-sm font-medium">{g.title}</span>
        {g.why && <span className="text-xs text-muted-foreground">{g.why}</span>}
      </div>
    </motion.button>
  );
}

function CopyButton({ brief }: { brief: Brief }) {
  const [done, setDone] = useState(false);
  const controls = useAnimationControls();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const text = [
      brief.summary,
      ...(brief.openPoints.length ? ["", "Points ouverts :", ...brief.openPoints.map((p) => `- ${p}`)] : []),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1800);
    } catch {
      controls.start(shake);
      toast.error("Copie impossible", { description: "Le presse-papiers est indisponible. Le brief reste affiché ici." });
    }
  };

  return (
    <motion.div animate={controls}>
      <Button
        size="sm"
        variant="ghost"
        className={cn("min-w-40 rounded-full transition-colors", done && "text-success")}
        onClick={copy}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={done ? "done" : "idle"}
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            transition={pop}
            className="flex items-center gap-2"
          >
            {done ? <><Check className="size-4" strokeWidth={3} /> Copié</> : <><Copy className="size-4" /> Copier le résumé</>}
          </motion.span>
        </AnimatePresence>
      </Button>
    </motion.div>
  );
}

function DockHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("relative flex flex-col gap-1.5", className)} {...props} />;
}
function DockTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn("font-semibold text-foreground", className)} {...props} />;
}
function DockDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
function DockFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-2", className)} {...props} />;
}

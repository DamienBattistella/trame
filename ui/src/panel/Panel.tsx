import { Suspense, lazy, useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { AlertTriangle, BookOpenText, Check, GitBranch, History, Loader2, MoreHorizontal, RotateCcw, Pencil, Plus, Send, Settings2, ShieldCheck, SlidersHorizontal, Sparkle, Trash2, Users, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { GithubLogo } from "@/brands";
import { toast } from "sonner";
import { TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BrainChoice } from "@/components/BrainConnect";
import { ConversationList, ConversationMeta } from "@/components/ConversationList";
import type { BriefTarget } from "@/components/BriefSheet";

const BriefSheet = lazy(() => import("@/components/BriefSheet").then((m) => ({ default: m.BriefSheet })));
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GithubConnect } from "@/components/GithubConnect";
import { EntourageSection } from "@/components/EntourageSection";
import { UpdatesRow } from "@/components/UpdatesRow";
import { DiagnosticRow } from "@/components/DiagnosticRow";
import { CountBadge, GroupList, InitialsAvatar, SectionLabel, Segment, pop, shake, spring } from "@/components/kit";
import { BranchIcon } from "@/icons";
import { cn } from "@/lib/utils";
import { mergeSettings, Result, Trame } from "@/api";
import { autostartEnabled, isDesktop, setAutostart } from "@/desktop";
import { DraftItem, LogItem, Settings, SettingsPatch, Surface } from "@/types";


type OpenBrief = (t: BriefTarget) => void;

const MotionCard = motion.create(Card);

/** Point d'entrée du brief ; grisé avec explication quand la fonction est coupée. */
function ContextButton({ trame, target, onBrief, compact }: { trame: Trame; target: BriefTarget; onBrief: OpenBrief; compact?: boolean }) {
  const enabled = trame.briefPrefs.enabled;
  const button = compact ? (
    <Button variant="ghost" size="icon" className="size-8 rounded-full" disabled={!enabled} aria-label="Résumé" onClick={() => onBrief(target)}>
      <BookOpenText className="size-4" />
    </Button>
  ) : (
    <Button variant="secondary" className="rounded-full" disabled={!enabled} onClick={() => onBrief(target)}>
      <BookOpenText className="size-4" /> Résumé
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* span : un bouton désactivé ne déclenche pas l'infobulle */}
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent>
        {enabled ? "Résumé de la conversation et liens GitHub" : "Résumé désactivé dans les réglages"}
      </TooltipContent>
    </Tooltip>
  );
}

export type PanelTab = "drafts" | "watchlist" | "logs" | "settings";

export function Panel({
  trame,
  tab,
  onTab,
  onRestartSetup,
}: {
  trame: Trame;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onRestartSetup: () => void;
}) {
  const { state } = trame;
  const [briefFor, setBriefFor] = useState<BriefTarget | null>(null);
  // Le brief n'est chargé qu'à la première ouverture, puis reste monté pour ses animations.
  const [briefUsed, setBriefUsed] = useState(false);
  useEffect(() => {
    if (briefFor) setBriefUsed(true);
  }, [briefFor]);

  return (
    <div className={cn("mx-auto flex h-full flex-col overflow-hidden px-6 pt-5 transition-[max-width] duration-300", tab === "settings" ? "max-w-5xl" : "max-w-3xl")}>
      <AnimatePresence initial={false}>
        {state.paused && (
          <motion.div
            key="paused"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="shrink-0 overflow-hidden"
          >
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2 text-sm">
              <AlertTriangle className="size-4 text-warning" /> Trame est en pause : aucun message n'est lu.
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {!trame.connected && !trame.demoMode && (
          <motion.div
            key="offline"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="shrink-0 overflow-hidden"
          >
            <div role="status" className="mb-4 flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm">
              <Loader2 className="size-4 animate-spin text-destructive" /> Moteur injoignable. Reconnexion… Rien ne peut partir pour l'instant.
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex min-h-0 flex-1 flex-col">

        <TabsContent value="drafts" className="flex-1 overflow-auto">
          <Drafts trame={trame} onBrief={setBriefFor} onChoose={() => onTab("watchlist")} />
        </TabsContent>
        <TabsContent value="watchlist" className="flex-1 overflow-auto">
          <Watchlist trame={trame} onBrief={setBriefFor} />
        </TabsContent>
        <TabsContent value="logs" className="flex-1 overflow-auto">
          <Logs logs={state.logs} />
        </TabsContent>
        <TabsContent value="settings" className="min-h-0 flex-1 overflow-hidden">
          <SettingsView trame={trame} onRestartSetup={onRestartSetup} />
        </TabsContent>
      </div>
      {briefUsed && (
        <Suspense fallback={null}>
          <BriefSheet trame={trame} target={briefFor} onClose={() => setBriefFor(null)} />
        </Suspense>
      )}
    </div>
  );
}

function Drafts({ trame, onBrief, onChoose }: { trame: Trame; onBrief: OpenBrief; onChoose: () => void }) {
  const drafts = trame.state.drafts;
  const [catching, setCatching] = useState<"idle" | "run" | "done">("idle");
  const [added, setAdded] = useState(0);
  const controls = useAnimationControls();

  const catchUp = async () => {
    setCatching("run");
    const res = await trame.catchUp();
    if (!res.ok) {
      setCatching("idle");
      controls.start(shake);
      toast.error("Rattrapage impossible", { description: `${res.error} Aucun message n'a été perdu.` });
      return;
    }
    const n = res.queued ?? 0;
    setAdded(n);
    setCatching("done");
    if (n > 0) toast.success(`${n} réponse${n > 1 ? "s" : ""} à relire`);
    else toast.info("Aucun message non lu");
    setTimeout(() => setCatching("idle"), 1800);
  };

  return (
    <div className="flex flex-col gap-4 py-5">
      <div className="flex items-center justify-between gap-3">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.p
            key={drafts.length === 0 ? "none" : "some"}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="ml-1 text-sm text-muted-foreground"
          >
            {drafts.length > 0 && `${drafts.length} réponse${drafts.length > 1 ? "s" : ""} à relire`}
          </motion.p>
        </AnimatePresence>
        <motion.div animate={controls}>
          <Button
            variant="ghost"
            size="sm"
            className={cn("rounded-full text-muted-foreground transition-colors", catching === "done" && "text-success")}
            disabled={catching !== "idle"}
            onClick={catchUp}
            title="Préparer une réponse pour chaque message non lu des conversations suivies"
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={catching}
                initial={{ y: 8, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -8, opacity: 0 }}
                className="flex items-center gap-2"
              >
                {catching === "idle" && <><History className="size-4" /> Rattraper les non-lus</>}
                {catching === "run" && <><Loader2 className="size-4 animate-spin" /> Lecture…</>}
                {catching === "done" && (
                  <>
                    <Check className="size-4" strokeWidth={3} />
                    {added > 0 ? `${added} ajouté${added > 1 ? "s" : ""}` : "Rien de neuf"}
                  </>
                )}
              </motion.span>
            </AnimatePresence>
          </Button>
        </motion.div>
      </div>

      <AnimatePresence initial={false} mode="popLayout">
        {drafts.length === 0 && (
          <EmptyDrafts key="empty" following={trame.state.watchlist.filter((w) => w.watch).length} onChoose={onChoose} />
        )}
        {drafts.map((d) => (
          <DraftCard key={d.id} draft={d} trame={trame} onBrief={onBrief} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function EmptyDrafts({ following, onChoose }: { following: number; onChoose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      className="flex flex-col items-center gap-3 py-16 text-center"
    >
      <motion.span
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ ...pop, delay: 0.1 }}
        className="grid size-12 place-items-center rounded-full bg-success/15 text-success"
      >
        <Check className="size-6" strokeWidth={3} />
      </motion.span>
      {following > 0 ? (
        <>
          <p className="font-medium">Rien à relire</p>
          <p className="max-w-xs text-sm text-muted-foreground">
            Trame suit {following} conversation{following > 1 ? "s" : ""}. Quand on t'y écrit, la réponse proposée apparaît ici.
          </p>
        </>
      ) : (
        <>
          <p className="font-medium">Aucune conversation suivie</p>
          <p className="max-w-xs text-sm text-muted-foreground">Trame ne lit que les conversations que tu choisis.</p>
          <Button variant="secondary" className="rounded-full" onClick={onChoose}>
            Choisir des conversations
          </Button>
        </>
      )}
    </motion.div>
  );
}

function DraftCard({ draft: d, trame, onBrief }: { draft: DraftItem; trame: Trame; onBrief: OpenBrief }) {
  const [text, setText] = useState(d.proposal);
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [compose, setCompose] = useState<"idle" | "opening">("idle");
  const [leaving, setLeaving] = useState<"sent" | "dismissed">("sent");
  const controls = useAnimationControls();
  const busy = status !== "idle" || compose === "opening";
  // Un nouveau message met à jour le brouillon sur place (même id). Sans modification de
  // ta part, la nouvelle proposition remplace l'ancienne ; sinon ton texte est gardé et
  // la nouvelle proposition t'est proposée.
  const base = useRef(d.proposal);
  const [fresher, setFresher] = useState<string | null>(null);
  useEffect(() => {
    if (d.proposal === base.current) return;
    if (text.trim() === base.current.trim()) {
      setText(d.proposal);
      setFresher(null);
    } else {
      setFresher(d.proposal);
    }
    base.current = d.proposal;
  }, [d.proposal]);
  const edited = text.trim() !== d.proposal.trim();
  const conversation = trame.state.watchlist.find((w) => w.threadId === d.threadId)?.displayName;
  const place = d.surface !== "dm" && conversation && conversation !== d.from ? conversation : null;

  const send = async () => {
    if (busy || !text.trim()) return;
    setStatus("sending");
    const res = await trame.sendDraft(d.id, text);
    if (!res.ok) {
      setStatus("idle");
      controls.start(shake);
      toast.error(`Échec de l'envoi à ${d.from}`, { description: `${res.error} Ta réponse est conservée.` });
      return;
    }
    setStatus("sent");
    setTimeout(() => {
      setLeaving("sent");
      trame.removeDraft(d.id);
    }, 700);
  };

  const openInTeams = async () => {
    setCompose("opening");
    const res = await trame.composeDraft(d.id, text);
    setCompose("idle");
    if (!res.ok) {
      controls.start(shake);
      toast.error("Impossible d'ouvrir la conversation dans Teams", {
        description: `${res.error} Ta réponse est conservée ici.`,
      });
      return;
    }
    toast.success("Réponse copiée dans Teams", { description: "Termine-la et envoie-la depuis Teams." });
  };

  const dismiss = async () => {
    setLeaving("dismissed");
    const res = await trame.dismissDraft(d.id);
    if (!res.ok) {
      controls.start(shake);
      toast.error("Impossible d'ignorer ce brouillon", { description: res.error });
    }
  };

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: -12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={leaving === "sent" ? { opacity: 0, scale: 0.96, y: -8 } : { opacity: 0, x: -48 }}
      transition={spring}
      aria-label={`Réponse à ${d.from}`}
    >
      <MotionCard
        animate={controls}
        className={cn(
          "gap-3 rounded-2xl p-4 shadow-none transition-colors duration-300",
          status === "sent" && "border-success/50"
        )}
      >
        <header className="flex items-center gap-3">
          <InitialsAvatar name={d.from} className="size-8" />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-medium">{d.from}</span>
              {place && <span className="truncate text-sm text-muted-foreground">dans {place}</span>}
            </div>
            {d.senderLabel && <span className="truncate text-xs text-muted-foreground">{d.senderLabel}</span>}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{d.receivedAt}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8 rounded-full" disabled={busy} aria-label="Plus d'actions">
                {compose === "opening" ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={openInTeams}>
                <Pencil /> Terminer dans Teams
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!trame.briefPrefs.enabled}
                onSelect={() => onBrief({ threadId: d.threadId, displayName: conversation ?? d.from })}
              >
                <BookOpenText /> Résumé de la conversation
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <div className="max-w-[85%] self-start rounded-2xl rounded-tl-md bg-muted px-3.5 py-2 text-sm">
          {d.incoming}
        </div>

        <div className="flex flex-col items-end gap-1.5">
          <Label htmlFor={`reply-${d.id}`} className="mr-1 text-xs font-normal text-muted-foreground">
            {edited ? "Ta réponse · modifiée" : "Réponse proposée · modifiable"}
          </Label>
          <Textarea
            id={`reply-${d.id}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              }
            }}
            disabled={busy}
            rows={1}
            className="field-sizing-content min-h-0 w-full max-w-[85%] resize-none rounded-2xl rounded-tr-md border-primary/30 bg-primary/10 px-3.5 py-2 text-sm leading-relaxed shadow-none focus-visible:border-primary/60 dark:bg-primary/15"
          />
          <AnimatePresence initial={false}>
            {fresher && fresher.trim() !== text.trim() && (
              <motion.div
                key="fresher"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="flex items-center gap-2 overflow-hidden text-xs text-muted-foreground"
              >
                Nouveau message : une autre réponse est proposée.
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 rounded-full text-link"
                  onClick={() => {
                    setText(fresher);
                    setFresher(null);
                  }}
                >
                  Utiliser
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
          {d.usedGithub && (
            <span className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <GithubLogo className="size-3.5" /> {d.usedGithub}
            </span>
          )}
        </div>

        <footer className="flex items-center gap-2 pt-1">
          <span className="hidden flex-1 items-center gap-1 text-xs text-muted-foreground sm:flex">
            <Kbd>Ctrl</Kbd>+<Kbd>Entrée</Kbd> pour envoyer
          </span>
          <div className="flex-1 sm:hidden" />
          <Button variant="ghost" className="rounded-full text-muted-foreground" disabled={busy} onClick={dismiss}>
            Ignorer
          </Button>
          <Button
            className={cn("min-w-28 rounded-full transition-colors", status === "sent" && "bg-success hover:bg-success")}
            disabled={busy || !text.trim()}
            onClick={send}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={status}
                initial={{ y: 8, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -8, opacity: 0 }}
                className="flex items-center gap-2"
              >
                {status === "idle" && <><Send className="size-4" /> Envoyer</>}
                {status === "sending" && <><Loader2 className="size-4 animate-spin" /> Envoi…</>}
                {status === "sent" && <><Check className="size-4" strokeWidth={3} /> Envoyé</>}
              </motion.span>
            </AnimatePresence>
          </Button>
        </footer>
      </MotionCard>
    </motion.article>
  );
}

function Watchlist({ trame, onBrief }: { trame: Trame; onBrief: OpenBrief }) {
  const report = (what: string) => (res: Result) => {
    if (!res.ok) toast.error(what, { description: `${res.error} Rien n'a été modifié.` });
  };
  return (
    <div className="flex flex-col gap-3 py-5">
      <SectionLabel>Conversations suivies</SectionLabel>
      <ConversationList
        items={trame.state.watchlist}
        onBulk={(ids, watch) => trame.setWatchMany(ids, watch).then(report("Mise à jour groupée impossible"))}
        className="h-[52vh]"
        renderRow={(c) => (
          <div className="group flex min-h-14 items-center gap-3 px-4 py-2">
            <InitialsAvatar name={c.displayName} className="size-8" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className={cn("truncate transition-colors duration-200", !c.watch && "text-muted-foreground", c.unread && "font-semibold text-foreground")}>{c.displayName}</span>
              {c.namedPeople.length > 0 && (
                <span className="truncate text-xs text-muted-foreground">réagit à {c.namedPeople.join(", ")}</span>
              )}
            </div>
            <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <ContextButton trame={trame} onBrief={onBrief} compact target={{ threadId: c.threadId, displayName: c.displayName }} />
            </span>
            <AnimatePresence initial={false}>
              {c.watch && (
                <motion.div
                  key="mode"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={spring}
                >
                  <Segment
                    label={`Mode pour ${c.displayName}`}
                    value={c.mode}
                    onChange={(v) => trame.setMode(c.threadId, v).then(report(`Impossible de changer le mode de « ${c.displayName} »`))}
                  />
                </motion.div>
              )}
            </AnimatePresence>
            <span className="flex w-16 justify-end">
              <ConversationMeta c={c} />
            </span>
            <Switch
              aria-label={`Suivre ${c.displayName}`}
              checked={c.watch}
              onCheckedChange={() => trame.toggleWatch(c.threadId).then(report(`Impossible de modifier « ${c.displayName} »`))}
            />
          </div>
        )}
      />
    </div>
  );
}

function Logs({ logs }: { logs: LogItem[] }) {
  const dot = { info: "bg-muted-foreground", warn: "bg-warning", sent: "bg-success", draft: "bg-primary" } as const;
  return (
    <div className="flex flex-col gap-3 py-5">
      <SectionLabel>Activité</SectionLabel>
      <GroupList>
        <ScrollArea className="h-[58vh]">
          {logs.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Aucune activité pour l'instant. Chaque message lu, réponse proposée ou envoi apparaîtra ici.
            </div>
          )}
          <AnimatePresence initial={false}>
            {logs.map((l) => (
              <motion.div
                key={`${l.at}-${l.text}`}
                layout
                initial={{ opacity: 0, y: -6, backgroundColor: "color-mix(in oklch, var(--primary) 12%, transparent)" }}
                animate={{ opacity: 1, y: 0, backgroundColor: "rgba(0,0,0,0)" }}
                transition={{ duration: 0.6 }}
                className="flex items-center gap-3 px-4 py-3 text-sm"
              >
                <span className={cn("size-2 shrink-0 rounded-full", dot[l.level])} />
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{l.at}</span>
                <span className="flex-1">{l.text}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </ScrollArea>
      </GroupList>
    </div>
  );
}

type Section = "brain" | "github" | "safety" | "brief";
type SaveState = "idle" | "saving" | "saved";

const COUNTDOWNS = [3, 5, 10];
const BRIEF_DEPTHS = [20, 30, 50];

/** Libellé de section + pastille d'état d'enregistrement (en cours → coche). */
function SaveIndicator({ state }: { state: SaveState }) {
  return (
    <span className="grid size-4 place-items-center">
        <AnimatePresence mode="popLayout" initial={false}>
          {state === "saving" && (
            <motion.span key="saving" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            </motion.span>
          )}
          {state === "saved" && (
            <motion.span
              key="saved"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={pop}
              className="grid size-4 place-items-center rounded-full bg-success text-success-foreground"
              aria-label="Enregistré"
            >
              <Check className="size-2.5" strokeWidth={3.5} />
            </motion.span>
          )}
        </AnimatePresence>
    </span>
  );
}

type SettingsPane = "general" | "brain" | "people" | "github" | "brief" | "safety" | "advanced";

function SettingsView({ trame, onRestartSetup }: { trame: Trame; onRestartSetup: () => void }) {
  const [pane, setPane] = useState<SettingsPane>("general");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<Record<Section, SaveState>>({ brain: "idle", github: "idle", safety: "idle", brief: "idle" });
  const seq = useRef<Record<Section, number>>({ brain: 0, github: 0, safety: 0, brief: 0 });
  const timers = useRef<Partial<Record<Section, ReturnType<typeof setTimeout>>>>({});
  const brainCtl = useAnimationControls();
  const githubCtl = useAnimationControls();
  const safetyCtl = useAnimationControls();
  const briefCtl = useAnimationControls();
  const ctl = { brain: brainCtl, github: githubCtl, safety: safetyCtl, brief: briefCtl };

  const load = async () => {
    setLoadError(null);
    const res = await trame.getSettings();
    if (res.ok) setSettings(res.settings);
    else setLoadError(res.error);
  };
  useEffect(() => {
    load();
  }, [trame.connected]);
  useEffect(() => () => Object.values(timers.current).forEach((t) => t && clearTimeout(t)), []);

  const mark = (section: Section, v: SaveState) => setSave((s) => ({ ...s, [section]: v }));

  /** Optimiste : on applique tout de suite, on annule si le moteur refuse. */
  const update = async (section: Section, patch: SettingsPatch) => {
    if (!settings) return;
    const prev = settings;
    setSettings(mergeSettings(settings, patch));
    const n = ++seq.current[section];
    if (timers.current[section]) clearTimeout(timers.current[section]);
    mark(section, "saving");
    const res = await trame.updateSettings(patch);
    if (n !== seq.current[section]) return;
    if (!res.ok) {
      setSettings(prev);
      mark(section, "idle");
      ctl[section].start(shake);
      toast.error("Réglage non enregistré", { description: `${res.error} Ton ancien réglage est conservé.` });
      return;
    }
    setSettings(res.settings);
    mark(section, "saved");
    timers.current[section] = setTimeout(() => mark(section, "idle"), 1600);
  };

  if (!settings) {
    return (
      <div className="flex max-w-xl flex-col items-center gap-3 py-16 text-sm text-muted-foreground">
        {loadError ? (
          <>
            <span>Impossible de charger les réglages. {loadError}</span>
            <Button variant="outline" size="sm" className="rounded-full" onClick={load}>
              Réessayer
            </Button>
          </>
        ) : (
          <span className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Chargement des réglages…
          </span>
        )}
      </div>
    );
  }

  const { github, safety, brief } = settings;
  const countdowns = Array.from(new Set([...COUNTDOWNS, safety.countdownSeconds])).sort((a, b) => a - b);
  const depths = Array.from(new Set([...BRIEF_DEPTHS, brief.lastMessages])).sort((a, b) => a - b);

  const panes: { id: SettingsPane; label: string; icon: React.ElementType; desc: string; state?: SaveState; body: React.ReactNode }[] = [
    {
      id: "general",
      label: "Général",
      icon: Settings2,
      desc: "Démarrage et comportement de l'application.",
      body: (
      <div>
        <GroupList>
          <UpdatesRow />
          <AutostartRow />
          <div className="px-4 py-2.5 text-xs text-muted-foreground">
            Fermer la fenêtre garde Trame actif dans la barre des tâches. Pour l'arrêter : clic droit sur l'icône, Quitter.
          </div>
        </GroupList>
      </div>
      ),
    },
    {
      id: "brain",
      label: "Cerveau",
      icon: Sparkle,
      desc: "Qui rédige tes réponses, et son état de connexion.",
      state: save.brain,
      body: (
      <motion.div animate={brainCtl}>
        <BrainChoice
          trame={trame}
          value={settings.brain}
          onChange={(brain) => brain !== settings.brain && update("brain", { brain })}
          size="md"
        />
      </motion.div>
      ),
    },
    {
      id: "people",
      label: "Entourage",
      icon: Users,
      desc: "Qui est qui au travail, pour adapter chaque réponse.",
      body: <EntourageSection trame={trame} />,
    },
    {
      id: "github",
      label: "GitHub",
      icon: GitBranch,
      desc: "Retrouver les PR et issues dont on te parle. En lecture seule.",
      state: save.github,
      body: (
      <motion.div animate={githubCtl}>
        <GithubConnect trame={trame} />
        <AnimatePresence initial={false}>
          {trame.githubStatus?.loggedIn && (
            <motion.div
              key="github-options"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <GroupList className="mt-3">
                <ToggleRow
                  label="Consulter GitHub pour les réponses"
                  checked={github.enabled}
                  onChange={(enabled) => update("github", { github: { ...github, enabled } })}
                />
                <ToggleRow
                  label="Chercher dans tous mes dépôts"
                  checked={github.allRepos}
                  disabled={!github.enabled}
                  onChange={(allRepos) => update("github", { github: { ...github, allRepos } })}
                />
                <div className="px-4 py-2.5 text-xs text-muted-foreground">Lecture seule · consulté seulement quand le message le justifie.</div>
              </GroupList>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      ),
    },
    {
      id: "brief",
      label: "Résumé",
      icon: BookOpenText,
      desc: "Résumé d'une conversation à la demande.",
      state: save.brief,
      body: (
      <motion.div animate={briefCtl}>
        <GroupList>
          <ToggleRow
            label="Résumé de conversation"
            checked={brief.enabled}
            onChange={(enabled) => update("brief", { brief: { ...brief, enabled } })}
          />
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className={cn("text-sm transition-colors", !brief.enabled && "text-muted-foreground")}>Messages lus pour le résumé</span>
            <Segment
              value={String(brief.lastMessages)}
              disabled={!brief.enabled}
              options={depths.map((n) => ({ value: String(n), label: String(n) }))}
              onChange={(v) => update("brief", { brief: { ...brief, lastMessages: Number(v) } })}
            />
          </div>
          <div className="px-4 py-2.5 text-xs text-muted-foreground">
            Depuis une réponse à relire (menu …) ou une conversation. GitHub en lecture seule.
          </div>
        </GroupList>
      </motion.div>
      ),
    },
    {
      id: "safety",
      label: "Sécurité",
      icon: ShieldCheck,
      desc: "Garde-fous avant tout envoi automatique.",
      state: save.safety,
      body: (
      <motion.div animate={safetyCtl}>
        <GroupList>
          <ToggleRow
            label="Pause pendant un partage d'écran"
            checked={safety.autoPauseOnScreenShare}
            onChange={(v) => update("safety", { safety: { ...safety, autoPauseOnScreenShare: v } })}
          />
          <ToggleRow
            label="Vérifier Teams au démarrage"
            checked={safety.selftestGate}
            onChange={(v) => update("safety", { safety: { ...safety, selftestGate: v } })}
          />
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm">Compte à rebours avant envoi auto</span>
            <Segment
              value={String(safety.countdownSeconds)}
              options={countdowns.map((n) => ({ value: String(n), label: `${n} s` }))}
              onChange={(v) => update("safety", { safety: { ...safety, countdownSeconds: Number(v) } })}
            />
          </div>
          <BlockedWords
            words={safety.neverAutoSendIfMessageContains}
            onChange={(words) => update("safety", { safety: { ...safety, neverAutoSendIfMessageContains: words } })}
          />
        </GroupList>
      </motion.div>
      ),
    },
    {
      id: "advanced",
      label: "Avancé",
      icon: SlidersHorizontal,
      desc: "Configuration et réinitialisation.",
      body: (
        <div className="flex flex-col gap-6">
      <div className="pb-4">
        <GroupList>
          <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
              <RotateCcw className="size-4" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">Reprendre la configuration</span>
              <span className="text-xs text-muted-foreground">Repasser par les étapes du premier lancement, réglages gardés.</span>
            </div>
            <Button variant="outline" size="sm" className="rounded-full" onClick={onRestartSetup}>
              Reprendre
            </Button>
          </div>
          <DiagnosticRow trame={trame} />
        </GroupList>
      </div>
          <DangerZone trame={trame} onReset={onRestartSetup} />
        </div>
      ),
    },
  ];
  const current = panes.find((p) => p.id === pane) ?? panes[0];

  return (
    <div className="flex h-full min-h-0 gap-6 py-5">
      <nav aria-label="Rubriques des réglages" className="flex w-48 shrink-0 flex-col gap-0.5">
        {panes.map((p) => {
          const Icon = p.icon;
          const active = p.id === current.id;
          return (
            <button
              key={p.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => setPane(p.id)}
              className={cn(
                "relative flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors",
                active ? "font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {active && <motion.span layoutId="settings-pane" transition={spring} className="absolute inset-0 rounded-xl bg-secondary" />}
              <Icon className={cn("relative size-4", p.id === "advanced" && active && "text-destructive")} />
              <span className="relative">{p.label}</span>
            </button>
          );
        })}
      </nav>

      <ScrollArea className="min-w-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
        <AnimatePresence mode="wait" initial={false}>
          <motion.section
            key={current.id}
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.15 }}
            aria-labelledby={`pane-${current.id}`}
            className="flex max-w-2xl flex-col gap-4 pr-3 pb-6"
          >
            <header className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <h2 id={`pane-${current.id}`} className="text-xl font-semibold tracking-tight">
                  {current.label}
                </h2>
                {current.state && <SaveIndicator state={current.state} />}
              </div>
              <p className="text-sm text-muted-foreground">{current.desc}</p>
            </header>
            {current.body}
          </motion.section>
        </AnimatePresence>
      </ScrollArea>
    </div>
  );
}

function DangerZone({ trame, onReset }: { trame: Trame; onReset: () => void }) {
  const [step, setStep] = useState<"idle" | "confirm" | "run">("idle");
  const controls = useAnimationControls();
  const reset = async () => {
    setStep("run");
    const res = await trame.factoryReset();
    if (!res.ok) {
      setStep("confirm");
      controls.start(shake);
      toast.error("Réinitialisation impossible", { description: `${res.error} Rien n'a été effacé.` });
      return;
    }
    toast.success("Trame réinitialisé", { description: "On reprend la configuration depuis le début." });
    onReset();
  };
  return (
    <motion.div animate={controls}>
      <SectionLabel>Zone de danger</SectionLabel>
      <div className="overflow-hidden rounded-2xl border border-destructive/40 bg-destructive/5">
        <div className="flex min-h-14 flex-wrap items-center gap-3 px-4 py-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-destructive/15 text-destructive">
            <Trash2 className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Réinitialiser Trame</span>
            <span className="text-xs text-muted-foreground">
              Réglages par défaut ; conversations suivies, brouillons, SOUL.md et entourage effacés. Tes connexions Claude et GitHub sont gardées.
            </span>
          </div>
          <AnimatePresence mode="popLayout" initial={false}>
            {step === "idle" ? (
              <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setStep("confirm")}
                >
                  Réinitialiser
                </Button>
              </motion.div>
            ) : (
              <motion.div key="confirm" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="flex items-center gap-2">
                <Button variant="ghost" size="sm" className="rounded-full" disabled={step === "run"} onClick={() => setStep("idle")}>
                  Annuler
                </Button>
                <Button
                  size="sm"
                  className="rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={step === "run"}
                  onClick={reset}
                >
                  {step === "run" && <Loader2 className="size-4 animate-spin" />}
                  Tout effacer
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}

function BlockedWords({ words, onChange }: { words: string[]; onChange: (w: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const controls = useAnimationControls();

  const add = () => {
    const w = draft.trim();
    if (!w) return;
    if (words.some((x) => x.toLowerCase() === w.toLowerCase())) {
      controls.start(shake);
      toast.info(`« ${w} » est déjà dans la liste`);
      return;
    }
    onChange([...words, w]);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-2.5 px-4 py-3">
      <span className="text-sm">Jamais d'envoi auto si le message contient…</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <AnimatePresence initial={false} mode="popLayout">
          {words.map((w) => (
            <motion.span
              key={w}
              layout
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.6, opacity: 0 }}
              transition={pop}
              className="flex items-center gap-1 rounded-full bg-secondary py-0.5 pl-2.5 pr-1 text-xs"
            >
              {w}
              <button
                onClick={() => onChange(words.filter((x) => x !== w))}
                aria-label={`Retirer « ${w} »`}
                className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </motion.span>
          ))}
        </AnimatePresence>
        <motion.form
          layout
          animate={controls}
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
          className="flex items-center gap-1"
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ajouter un mot…"
            className="h-7 w-36 rounded-full px-3 text-xs md:text-xs"
          />
          <AnimatePresence initial={false}>
            {draft.trim() && (
              <motion.button
                type="submit"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0 }}
                transition={pop}
                aria-label="Ajouter"
                className="grid size-6 place-items-center rounded-full bg-primary text-primary-foreground"
              >
                <Plus className="size-3.5" />
              </motion.button>
            )}
          </AnimatePresence>
        </motion.form>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <Label htmlFor={id} className={cn("font-normal transition-colors", disabled && "text-muted-foreground")}>{label}</Label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function AutostartRow() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    autostartEnabled().then(setOn);
  }, []);
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <Label htmlFor="autostart" className="font-normal">Lancer au démarrage de Windows</Label>
      <Switch
        id="autostart"
        checked={on}
        disabled={!isDesktop()}
        onCheckedChange={async (v) => {
          setOn(v);
          if (!(await setAutostart(v))) {
            setOn(!v);
            toast.error("Réglage non appliqué", { description: "Windows a refusé de modifier le démarrage automatique." });
          }
        }}
      />
    </div>
  );
}

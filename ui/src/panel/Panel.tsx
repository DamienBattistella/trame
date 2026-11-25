import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { AlertTriangle, BookOpenText, Check, History, Loader2, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BrainPicker } from "@/components/BrainPicker";
import { ConversationList } from "@/components/ConversationList";
import { BriefSheet, BriefTarget } from "@/components/BriefSheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GithubConnect } from "@/components/GithubConnect";
import { CountBadge, GroupList, InitialsAvatar, SectionLabel, Segment, pop, shake, spring } from "@/components/kit";
import { BranchIcon } from "@/icons";
import { cn } from "@/lib/utils";
import { mergeSettings, Result, Trame } from "@/api";
import { autostartEnabled, isDesktop, setAutostart } from "@/desktop";
import { DraftItem, LogItem, Settings, SettingsPatch, Surface } from "@/types";

const SURFACE = { dm: "1:1", group: "Groupe", channel: "Canal" } as const;

function SurfaceTag({ s }: { s: Surface }) {
  return <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{SURFACE[s]}</span>;
}

type OpenBrief = (t: BriefTarget) => void;

/** Point d'entrée du brief ; grisé avec explication quand la fonction est coupée. */
function ContextButton({ trame, target, onBrief, compact }: { trame: Trame; target: BriefTarget; onBrief: OpenBrief; compact?: boolean }) {
  const enabled = trame.briefPrefs.enabled;
  const button = compact ? (
    <Button variant="ghost" size="icon" className="size-8 rounded-full" disabled={!enabled} aria-label="Contexte" onClick={() => onBrief(target)}>
      <BookOpenText className="size-4" />
    </Button>
  ) : (
    <Button variant="secondary" className="rounded-full" disabled={!enabled} onClick={() => onBrief(target)}>
      <BookOpenText className="size-4" /> Contexte
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* span : un bouton désactivé ne déclenche pas l'infobulle */}
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent>
        {enabled ? "Résumé et contexte GitHub" : "Brief de conversation désactivé dans Réglages"}
      </TooltipContent>
    </Tooltip>
  );
}

export function Panel({ trame }: { trame: Trame }) {
  const { state } = trame;
  const [briefFor, setBriefFor] = useState<BriefTarget | null>(null);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col overflow-hidden px-6 pt-5">
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
              <AlertTriangle className="size-4 text-warning" /> Veille en pause — aucun message n'est traité.
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Tabs defaultValue="drafts" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="self-start rounded-full">
          <TabsTrigger value="drafts" className="rounded-full">
            Brouillons <CountBadge n={state.drafts.length} />
          </TabsTrigger>
          <TabsTrigger value="watchlist" className="rounded-full">Watchlist</TabsTrigger>
          <TabsTrigger value="logs" className="rounded-full">Journal</TabsTrigger>
          <TabsTrigger value="settings" className="rounded-full">Réglages</TabsTrigger>
        </TabsList>

        <TabsContent value="drafts" className="flex-1 overflow-auto">
          <Drafts trame={trame} onBrief={setBriefFor} />
        </TabsContent>
        <TabsContent value="watchlist" className="flex-1 overflow-auto">
          <Watchlist trame={trame} onBrief={setBriefFor} />
        </TabsContent>
        <TabsContent value="logs" className="flex-1 overflow-auto">
          <Logs logs={state.logs} />
        </TabsContent>
        <TabsContent value="settings" className="flex-1 overflow-auto">
          <SettingsView trame={trame} />
        </TabsContent>
      </Tabs>
      <BriefSheet trame={trame} target={briefFor} onClose={() => setBriefFor(null)} />
    </div>
  );
}

function Drafts({ trame, onBrief }: { trame: Trame; onBrief: OpenBrief }) {
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
    if (n > 0) toast.success(`${n} brouillon${n > 1 ? "s" : ""} ajouté${n > 1 ? "s" : ""}`);
    else toast.info("Aucun non-lu");
    setTimeout(() => setCatching("idle"), 1800);
  };

  return (
    <div className="flex flex-col gap-4 py-5">
      <div className="flex items-center justify-between">
        <SectionLabel>À relire</SectionLabel>
        <motion.div animate={controls}>
          <Button
            variant="outline"
            size="sm"
            className={cn("min-w-44 rounded-full transition-colors", catching === "done" && "border-success/50 text-success")}
            disabled={catching !== "idle"}
            onClick={catchUp}
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
                {catching === "run" && <><Loader2 className="size-4 animate-spin" /> Rattrapage…</>}
                {catching === "done" && (
                  <>
                    <Check className="size-4" strokeWidth={3} />
                    {added > 0 ? `${added} ajouté${added > 1 ? "s" : ""}` : "À jour"}
                  </>
                )}
              </motion.span>
            </AnimatePresence>
          </Button>
        </motion.div>
      </div>

      <AnimatePresence initial={false} mode="popLayout">
        {drafts.length === 0 && (
          <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="py-10 text-center text-muted-foreground">
            Rien à relire. 👌
          </motion.p>
        )}
        {drafts.map((d) => (
          <DraftCard key={d.id} draft={d} trame={trame} onBrief={onBrief} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function DraftCard({ draft: d, trame, onBrief }: { draft: DraftItem; trame: Trame; onBrief: OpenBrief }) {
  const [text, setText] = useState(d.proposal);
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [compose, setCompose] = useState<"idle" | "opening" | "open">("idle");
  const [leaving, setLeaving] = useState<"sent" | "dismissed">("sent");
  const controls = useAnimationControls();
  const busy = status !== "idle" || compose === "opening";

  const send = async () => {
    setStatus("sending");
    const res = await trame.sendDraft(d.id, text);
    if (!res.ok) {
      setStatus("idle");
      controls.start(shake);
      toast.error(`Échec de l'envoi à ${d.from}`, { description: `${res.error} Le brouillon est conservé.` });
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
    if (!res.ok) {
      setCompose("idle");
      controls.start(shake);
      toast.error("Impossible d'ouvrir la conversation dans Teams", {
        description: `${res.error} Le brouillon est conservé ici.`,
      });
      return;
    }
    setCompose("open");
    setTimeout(() => setCompose("idle"), 2500);
  };

  const dismiss = () => {
    setLeaving("dismissed");
    trame.dismissDraft(d.id);
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={leaving === "sent" ? { opacity: 0, scale: 0.96, y: -8 } : { opacity: 0, x: -48 }}
      transition={spring}
    >
      <motion.div
        animate={controls}
        className={cn(
          "flex flex-col gap-3 rounded-2xl border bg-card p-4 transition-colors duration-300",
          status === "sent" && "border-success/50"
        )}
      >
        <div className="flex items-center gap-3">
          <InitialsAvatar name={d.from} className="size-8" />
          <span className="font-medium">{d.from}</span>
          <SurfaceTag s={d.surface} />
          <span className="text-xs text-muted-foreground">{d.receivedAt}</span>
        </div>
        <div className="rounded-xl bg-muted/50 px-3 py-2 text-sm text-muted-foreground">{d.incoming}</div>
        {d.usedGithub && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <BranchIcon className="size-3.5 text-primary" /> Contexte : {d.usedGithub}
          </div>
        )}
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          className="min-h-20 rounded-xl"
        />
        <div className="flex gap-2">
          <Button
            className={cn("min-w-32 rounded-full transition-colors", status === "sent" && "bg-success hover:bg-success")}
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
          <Button
            variant="secondary"
            className={cn("min-w-44 rounded-full transition-colors", compose === "open" && "text-success")}
            disabled={busy}
            onClick={() => compose === "idle" && openInTeams()}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={compose}
                initial={{ y: 8, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -8, opacity: 0 }}
                className="flex items-center gap-2"
              >
                {compose === "idle" && <><Pencil className="size-4" /> Modifier dans Teams</>}
                {compose === "opening" && <><Loader2 className="size-4 animate-spin" /> Ouverture…</>}
                {compose === "open" && <><Check className="size-4" strokeWidth={3} /> Dans Teams</>}
              </motion.span>
            </AnimatePresence>
          </Button>
          <ContextButton
            trame={trame}
            onBrief={onBrief}
            target={{
              threadId: d.threadId,
              displayName: trame.state.watchlist.find((w) => w.threadId === d.threadId)?.displayName ?? d.from,
            }}
          />
          <div className="flex-1" />
          <Button variant="ghost" className="rounded-full" disabled={busy} onClick={dismiss}>
            <Trash2 className="size-4" /> Ignorer
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Watchlist({ trame, onBrief }: { trame: Trame; onBrief: OpenBrief }) {
  const report = (what: string) => (res: Result) => {
    if (!res.ok) toast.error(what, { description: `${res.error} La watchlist est revenue à son état précédent.` });
  };
  return (
    <div className="flex flex-col gap-3 py-5">
      <SectionLabel>Conversations surveillées</SectionLabel>
      <ConversationList
        items={trame.state.watchlist}
        onBulk={(ids, watch) => trame.setWatchMany(ids, watch).then(report("Mise à jour groupée impossible"))}
        className="h-[52vh]"
        renderRow={(c) => (
          <div className="flex items-center gap-3 px-4 py-2.5">
            <Switch
              checked={c.watch}
              onCheckedChange={() => trame.toggleWatch(c.threadId).then(report(`Impossible de modifier « ${c.displayName} »`))}
            />
            <InitialsAvatar name={c.displayName} className={cn("size-8", !c.watch && "opacity-50")} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className={cn("truncate transition-colors duration-200", !c.watch && "text-muted-foreground")}>{c.displayName}</span>
              {c.namedPeople.length > 0 && (
                <span className="truncate text-xs text-muted-foreground">réagit à : {c.namedPeople.join(", ")}</span>
              )}
            </div>
            <SurfaceTag s={c.surface} />
            <ContextButton trame={trame} onBrief={onBrief} compact target={{ threadId: c.threadId, displayName: c.displayName }} />
            <Segment
              value={c.mode}
              onChange={(v) => trame.setMode(c.threadId, v).then(report(`Impossible de changer le mode de « ${c.displayName} »`))}
              disabled={!c.watch}
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
          {logs.length === 0 && <div className="px-4 py-6 text-center text-sm text-muted-foreground">Aucune activité pour l'instant.</div>}
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
function SectionHeader({ children, state }: { children: React.ReactNode; state: SaveState }) {
  return (
    <div className="flex items-center gap-2">
      <SectionLabel>{children}</SectionLabel>
      <span className="mb-2 grid size-4 place-items-center">
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
              className="grid size-4 place-items-center rounded-full bg-success text-white"
              aria-label="Enregistré"
            >
              <Check className="size-2.5" strokeWidth={3.5} />
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </div>
  );
}

function SettingsView({ trame }: { trame: Trame }) {
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

  return (
    <div className="flex max-w-xl flex-col gap-6 py-5">
      <motion.div animate={brainCtl}>
        <SectionHeader state={save.brain}>Cerveau</SectionHeader>
        <BrainPicker
          value={settings.brain}
          onChange={(brain) => brain !== settings.brain && update("brain", { brain })}
          size="md"
        />
      </motion.div>

      <div>
        <SectionLabel>Application</SectionLabel>
        <GroupList>
          <AutostartRow />
          <div className="px-4 py-2.5 text-xs text-muted-foreground">
            Fermer la fenêtre la réduit dans la barre des tâches : Trame continue de veiller. « Quitter » depuis l'icône l'arrête.
          </div>
        </GroupList>
      </div>

      <motion.div animate={githubCtl}>
        <SectionHeader state={save.github}>Contexte GitHub</SectionHeader>
        <GithubConnect trame={trame} className="mb-3" />
        <GroupList>
          <ToggleRow
            label="Activer le contexte GitHub"
            checked={github.enabled}
            onChange={(enabled) => update("github", { github: { ...github, enabled } })}
          />
          <ToggleRow
            label="Tous les repos par défaut"
            checked={github.allRepos}
            disabled={!github.enabled}
            onChange={(allRepos) => update("github", { github: { ...github, allRepos } })}
          />
          <div className="px-4 py-2.5 text-xs text-muted-foreground">Lecture seule · consulté seulement quand le message le justifie.</div>
        </GroupList>
      </motion.div>

      <motion.div animate={briefCtl}>
        <SectionHeader state={save.brief}>Brief de conversation</SectionHeader>
        <GroupList>
          <ToggleRow
            label="Résumé et contexte GitHub"
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
            Bouton « Contexte » sur chaque conversation · GitHub en lecture seule, selon le réglage ci-dessus.
          </div>
        </GroupList>
      </motion.div>

      <motion.div animate={safetyCtl}>
        <SectionHeader state={save.safety}>Sécurité</SectionHeader>
        <GroupList>
          <ToggleRow
            label="Auto-pause pendant un partage d'écran"
            checked={safety.autoPauseOnScreenShare}
            onChange={(v) => update("safety", { safety: { ...safety, autoPauseOnScreenShare: v } })}
          />
          <ToggleRow
            label="Auto-test des sélecteurs au démarrage"
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
    </div>
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
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className={cn("text-sm transition-colors", disabled && "text-muted-foreground")}>{label}</span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
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
      <span className="text-sm">Lancer au démarrage de Windows</span>
      <Switch
        checked={on}
        disabled={!isDesktop()}
        onCheckedChange={(v) => {
          setOn(v);
          setAutostart(v);
        }}
      />
    </div>
  );
}

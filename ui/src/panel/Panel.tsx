import { Suspense, lazy, useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { AlertTriangle, BellRing, BookOpenText, Check, GitBranch, History, Loader2, MoreHorizontal, RotateCcw, Pencil, Plus, Send, Settings2, ShieldCheck, MessagesSquare, Activity, Plug, SlidersHorizontal, Sparkle, Trash2, Users, X } from "lucide-react";
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
import { ConversationSheet } from "@/components/ConversationSheet";
import { LogExportButtons } from "@/components/LogExportButtons";
import { ActivityLog } from "@/components/ActivityLog";
import { McpSettings } from "@/components/McpSettings";
import { TeamsWebSettings } from "@/components/TeamsWebSettings";
import { TeamsCheckBanner } from "@/components/TeamsCheck";
import { ChangelogRow } from "@/components/Changelog";
import { ModelPicker } from "@/components/ModelPicker";
import { Inbox } from "@/components/Inbox";
import { Meetings } from "@/components/Meetings";
import { CountBadge, GroupList, InitialsAvatar, SectionLabel, Segment, pop, shake, spring } from "@/components/kit";
import { BranchIcon } from "@/icons";
import { cn } from "@/lib/utils";
import { mergeSettings, Result, Trame } from "@/api";
import { autostartEnabled, isDesktop, notificationsEnabled, notify, setAutostart, setNotificationsEnabled } from "@/desktop";
import { DraftItem, Settings, SettingsPatch, Surface, WatchEntity } from "@/types";


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

export type PanelTab = "inbox" | "meetings" | "logs" | "settings";

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
    <div
      className={cn(
        "mx-auto flex h-full flex-col overflow-hidden",
        tab === "inbox" ? "w-full" : cn("px-6 pt-5", tab === "settings" ? "max-w-5xl" : "max-w-3xl")
      )}
    >
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

      <TeamsCheckBanner check={state.teamsCheck} onDetail={tab === "settings" ? undefined : () => onTab("settings")} />

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

        <TabsContent value="inbox" className="min-h-0 flex-1 overflow-hidden">
          <Inbox trame={trame} onBrief={setBriefFor} />
        </TabsContent>
        <TabsContent value="meetings" className="flex-1 overflow-auto">
          <Meetings trame={trame} />
        </TabsContent>
        <TabsContent value="logs" className="flex-1 overflow-auto">
          <ActivityLog logs={state.logs} trame={trame} />
        </TabsContent>
        <TabsContent value="settings" className="min-h-0 flex-1 overflow-hidden">
          <SettingsView trame={trame} onRestartSetup={onRestartSetup} onBrief={setBriefFor} />
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

function Watchlist({ trame, onBrief }: { trame: Trame; onBrief: OpenBrief }) {
  const [open, setOpen] = useState<WatchEntity | null>(null);
  const report = (what: string) => (res: Result) => {
    if (!res.ok) toast.error(what, { description: `${res.error} Rien n'a été modifié.` });
  };
  return (
    <div className="flex flex-col gap-3">
      <ConversationList
        items={trame.state.watchlist}
        sort={trame.conversationSort}
        onSortChange={trame.setConversationSort}
        onBulk={(ids, watch) => trame.setWatchMany(ids, watch).then(report("Mise à jour groupée impossible"))}
        onRefresh={() =>
          trame.refreshConversations().then((res) => {
            if (!res.ok) toast.error("Actualisation impossible", { description: res.error });
            else toast.success(`${res.count} conversation${res.count > 1 ? "s" : ""} dans Teams`);
          })
        }
        className="h-[52vh]"
        renderRow={(c) => (
          <div className="group flex min-h-14 items-center gap-3 px-4 py-2">
            <button
              type="button"
              onClick={() => setOpen(c)}
              title="Ouvrir la conversation"
              className="-my-1 -ml-1 flex min-w-0 flex-1 items-center gap-3 rounded-xl py-1 pl-1 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <InitialsAvatar name={c.displayName} presence={c.presence} className="size-8" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cn("truncate transition-colors duration-200", !c.watch && "text-muted-foreground", c.unread && "font-semibold text-foreground")}>{c.displayName}</span>
                {c.namedPeople.length > 0 && (
                  <span className="truncate text-xs text-muted-foreground">réagit à {c.namedPeople.join(", ")}</span>
                )}
              </span>
            </button>
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
      <ConversationSheet key={open?.threadId ?? "none"} trame={trame} conversation={open} onClose={() => setOpen(null)} />
    </div>
  );
}

type Section = "brain" | "github" | "safety" | "brief" | "followUps" | "telemetry" | "mcp";
type SaveState = "idle" | "saving" | "saved";

const COUNTDOWNS = [0, 3, 5, 10];
const BRIEF_DEPTHS = [20, 30, 50];
// Délai avant de proposer une relance, en heures ouvrées.
const FOLLOW_UP_DELAYS = [4, 24, 48];

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

type SettingsPane = "general" | "brain" | "conversations" | "people" | "github" | "brief" | "followUps" | "safety" | "telemetry" | "mcp" | "advanced";

function SettingsView({ trame, onRestartSetup, onBrief }: { trame: Trame; onRestartSetup: () => void; onBrief: OpenBrief }) {
  const [pane, setPane] = useState<SettingsPane>("general");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<Record<Section, SaveState>>({ brain: "idle", github: "idle", safety: "idle", brief: "idle", followUps: "idle", telemetry: "idle", mcp: "idle" });
  const seq = useRef<Record<Section, number>>({ brain: 0, github: 0, safety: 0, brief: 0, followUps: 0, telemetry: 0, mcp: 0 });
  const timers = useRef<Partial<Record<Section, ReturnType<typeof setTimeout>>>>({});
  const brainCtl = useAnimationControls();
  const githubCtl = useAnimationControls();
  const safetyCtl = useAnimationControls();
  const briefCtl = useAnimationControls();
  const followUpsCtl = useAnimationControls();
  const telemetryCtl = useAnimationControls();
  const mcpCtl = useAnimationControls();
  const ctl = { brain: brainCtl, github: githubCtl, safety: safetyCtl, brief: briefCtl, followUps: followUpsCtl, telemetry: telemetryCtl, mcp: mcpCtl };

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
    // Only the patched keys move: a late answer or rollback for one section must not
    // undo another section saved in the meantime.
    const keys = Object.keys(patch) as (keyof Settings)[];
    const slice = (from: Settings, onto: Settings): Settings => {
      const out = { ...onto } as Record<keyof Settings, unknown>;
      for (const k of keys) out[k] = from[k];
      return out as Settings;
    };
    const prev = settings;
    setSettings((cur) => (cur ? mergeSettings(cur, patch) : cur));
    const n = ++seq.current[section];
    if (timers.current[section]) clearTimeout(timers.current[section]);
    mark(section, "saving");
    const res = await trame.updateSettings(patch);
    if (n !== seq.current[section]) return;
    if (!res.ok) {
      setSettings((cur) => (cur ? slice(prev, cur) : cur));
      mark(section, "idle");
      ctl[section].start(shake);
      toast.error("Réglage non enregistré", { description: `${res.error} Ton ancien réglage est conservé.` });
      return;
    }
    setSettings((cur) => (cur ? slice(res.settings, cur) : res.settings));
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

  const { github, safety, brief, followUps } = settings;
  const countdowns = Array.from(new Set([...COUNTDOWNS, safety.countdownSeconds])).sort((a, b) => a - b);
  const depths = Array.from(new Set([...BRIEF_DEPTHS, brief.lastMessages])).sort((a, b) => a - b);
  const delays = Array.from(new Set([...FOLLOW_UP_DELAYS, followUps.delayHours])).sort((a, b) => a - b);

  const panes: { id: SettingsPane; label: string; icon: React.ElementType; desc: string; state?: SaveState; body: React.ReactNode }[] = [
    {
      id: "general",
      label: "Général",
      icon: Settings2,
      desc: "Démarrage et comportement de l'application.",
      body: (
      <div className="flex flex-col gap-6">
        <TeamsWebSettings trame={trame} />
        <GroupList>
          <UpdatesRow />
          <ChangelogRow />
          <NotificationsRow />
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
      <motion.div animate={brainCtl} className="flex flex-col gap-6">
        <BrainChoice
          trame={trame}
          value={settings.brain}
          onChange={(brain) => brain !== settings.brain && update("brain", { brain })}
          size="md"
        />
        <div>
          <SectionLabel>Modèle et effort</SectionLabel>
          <ModelPicker
            brain={settings.brain}
            value={settings.models}
            onChange={(models) => update("brain", { models: { ...settings.models, ...models } })}
          />
        </div>
      </motion.div>
      ),
    },
    {
      id: "conversations",
      label: "Conversations",
      icon: MessagesSquare,
      desc: "Quelles conversations Trame suit, et qui envoie : toi ou Trame.",
      body: <Watchlist trame={trame} onBrief={onBrief} />,
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
      id: "followUps",
      label: "Relances",
      icon: BellRing,
      desc: "Ne plus oublier une question restée sans réponse.",
      state: save.followUps,
      body: (
      <motion.div animate={followUpsCtl}>
        <GroupList>
          <ToggleRow
            label="Proposer des relances"
            checked={followUps.enabled}
            onChange={(enabled) => update("followUps", { followUps: { ...followUps, enabled } })}
          />
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className={cn("text-sm transition-colors", !followUps.enabled && "text-muted-foreground")}>Sans réponse depuis</span>
            <Segment
              value={String(followUps.delayHours)}
              disabled={!followUps.enabled}
              options={delays.map((n) => ({ value: String(n), label: `${n} h` }))}
              onChange={(v) => update("followUps", { followUps: { ...followUps, delayHours: Number(v) } })}
            />
          </div>
          <div className="px-4 py-2.5 text-xs text-muted-foreground">
            Heures ouvrées : le week-end ne compte pas, rien n'est proposé la nuit. Trame s'appuie sur les messages
            qu'il a déjà lus. La relance reste un brouillon : elle ne part que sur ton clic.
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
          <ToggleRow
            label="Marquer les envois auto d'un 🤖"
            hint="Tes interlocuteurs savent qu'une réponse est partie seule. Suivi d'un emoji selon le ton (😊 😔 😎 🎉 🤔). Rien n'est ajouté quand tu cliques sur « Envoyer »."
            checked={safety.markAutoReplies}
            onChange={(v) => update("safety", { safety: { ...safety, markAutoReplies: v } })}
          />
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="flex min-w-0 flex-col">
              <span className="text-sm">Compte à rebours avant envoi auto</span>
              {safety.countdownSeconds === 0 && (
                <span className="text-xs text-muted-foreground">Envoi immédiat : plus le temps de mettre en pause.</span>
              )}
            </span>
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
      id: "telemetry",
      label: "Journaux",
      icon: Activity,
      desc: "Traces et journaux OpenTelemetry pour comprendre ce que fait Trame.",
      state: save.telemetry,
      body: (
        <motion.div animate={telemetryCtl}>
          <TelemetrySettingsBody
            trame={trame}
            value={settings.telemetry}
            onChange={(telemetry) => update("telemetry", { telemetry: { ...settings.telemetry, ...telemetry } })}
          />
        </motion.div>
      ),
    },
    {
      id: "mcp",
      label: "MCP",
      icon: Plug,
      desc: "Laisser Claude Code, Copilot ou Jarvis lire tes discussions et te proposer des réponses.",
      state: save.mcp,
      body: (
        <motion.div animate={mcpCtl}>
          <McpSettings value={settings.mcp} onChange={(mcp) => update("mcp", { mcp })} />
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

function TelemetrySettingsBody({
  trame,
  value,
  onChange,
}: {
  trame: Trame;
  value: Settings["telemetry"];
  onChange: (t: Partial<Settings["telemetry"]>) => void;
}) {
  const [endpoint, setEndpoint] = useState(value.endpoint);
  useEffect(() => setEndpoint(value.endpoint), [value.endpoint]);
  const commit = () => endpoint.trim() !== value.endpoint && onChange({ endpoint: endpoint.trim() });
  return (
    <div className="flex flex-col gap-3">
      <GroupList>
        <ToggleRow label="Exporter les journaux OpenTelemetry" checked={value.enabled} onChange={(enabled) => onChange({ enabled })} />
        <div className="flex flex-col gap-1.5 px-4 py-3">
          <Label htmlFor="otel-endpoint" className={cn("font-normal", !value.enabled && "text-muted-foreground")}>
            Collecteur OTLP/HTTP
          </Label>
          <Input
            id="otel-endpoint"
            value={endpoint}
            disabled={!value.enabled}
            placeholder="http://localhost:4318"
            onChange={(e) => setEndpoint(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
            className="rounded-full font-mono text-sm"
            spellCheck={false}
          />
          <span className="text-xs text-muted-foreground">
            Vide : fichier local %APPDATA%\Trame\otel.jsonl (10 Mo, puis rotation).
          </span>
        </div>
        <ToggleRow
          label="Inclure le texte des messages"
          checked={value.includeContent}
          disabled={!value.enabled}
          onChange={(includeContent) => onChange({ includeContent })}
        />
        <div className="px-4 py-2.5 text-xs text-muted-foreground">
          Service « trame » : une trace par message traité (rédaction, recherche GitHub, lecture et saisie dans Teams) et
          chaque ligne du Journal. Sans cette option, le texte des messages n'est jamais exporté.
        </div>
      </GroupList>
      <GroupList>
        <div className="flex min-h-14 flex-wrap items-center gap-3 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Export manuel</span>
            <span className="text-xs text-muted-foreground">Journal, erreurs du moteur et dernières traces, en un seul texte.</span>
          </div>
          <LogExportButtons trame={trame} />
        </div>
      </GroupList>
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
              Réglages par défaut ; conversations suivies, brouillons, SOUL.md effacés, entourage remis à celui livré avec Trame. Tes connexions Claude et GitHub sont gardées.
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
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-col">
        <Label htmlFor={id} className={cn("font-normal transition-colors", disabled && "text-muted-foreground")}>{label}</Label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function NotificationsRow() {
  const [on, setOn] = useState(notificationsEnabled);
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-col">
        <Label htmlFor="notifications" className="font-normal">Notification Windows à chaque message reçu</Label>
        <span className="text-xs text-muted-foreground">
          Pour toutes les conversations, suivies ou non. Rien quand Trame est au premier plan.
        </span>
      </div>
      <Switch
        id="notifications"
        checked={on && isDesktop()}
        disabled={!isDesktop()}
        onCheckedChange={async (v) => {
          setOn(v);
          setNotificationsEnabled(v);
          if (v && !(await notify("Trame", "Les notifications sont activées."))) {
            toast.error("Notification non affichée", { description: "Windows a refusé la notification. Vérifie Paramètres › Système › Notifications." });
          }
        }}
      />
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

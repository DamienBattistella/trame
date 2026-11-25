import { useEffect, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { AlertTriangle, Check, History, Loader2, Pencil, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BrainPicker, BrainId } from "@/components/BrainPicker";
import { ConversationList } from "@/components/ConversationList";
import { CountBadge, GroupList, InitialsAvatar, SectionLabel, Segment, shake, spring } from "@/components/kit";
import { BranchIcon } from "@/icons";
import { cn } from "@/lib/utils";
import { useTrame } from "@/api";
import { autostartEnabled, isDesktop, setAutostart } from "@/desktop";
import { DraftItem, LogItem, Surface } from "@/types";

type Trame = ReturnType<typeof useTrame>;

const SURFACE = { dm: "1:1", group: "Groupe", channel: "Canal" } as const;

function SurfaceTag({ s }: { s: Surface }) {
  return <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{SURFACE[s]}</span>;
}

export function Panel({ trame }: { trame: Trame }) {
  const { state } = trame;

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
          <Drafts trame={trame} />
        </TabsContent>
        <TabsContent value="watchlist" className="flex-1 overflow-auto">
          <Watchlist trame={trame} />
        </TabsContent>
        <TabsContent value="logs" className="flex-1 overflow-auto">
          <Logs logs={state.logs} />
        </TabsContent>
        <TabsContent value="settings" className="flex-1 overflow-auto">
          <SettingsView brain={state.brain} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Drafts({ trame }: { trame: Trame }) {
  const drafts = trame.state.drafts;
  const [catching, setCatching] = useState(false);

  const catchUp = () => {
    setCatching(true);
    setTimeout(() => {
      setCatching(false);
      toast.info("Rattrapage terminé — les non-lus arrivent en brouillons");
    }, 1400);
  };

  return (
    <div className="flex flex-col gap-4 py-5">
      <div className="flex items-center justify-between">
        <SectionLabel>À relire</SectionLabel>
        <Button variant="outline" size="sm" className="rounded-full" disabled={catching} onClick={catchUp}>
          {catching ? <Loader2 className="size-4 animate-spin" /> : <History className="size-4" />}
          {catching ? "Rattrapage…" : "Rattraper les non-lus"}
        </Button>
      </div>

      <AnimatePresence initial={false} mode="popLayout">
        {drafts.length === 0 && (
          <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="py-10 text-center text-muted-foreground">
            Rien à relire. 👌
          </motion.p>
        )}
        {drafts.map((d) => (
          <DraftCard key={d.id} draft={d} trame={trame} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function DraftCard({ draft: d, trame }: { draft: DraftItem; trame: Trame }) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [leaving, setLeaving] = useState<"sent" | "dismissed">("sent");
  const controls = useAnimationControls();

  const send = async () => {
    setStatus("sending");
    const ok = await trame.sendDraft(d.id);
    if (!ok) {
      setStatus("idle");
      controls.start(shake);
      toast.error(`Échec de l'envoi à ${d.from} — le brouillon est conservé`);
      return;
    }
    setStatus("sent");
    setTimeout(() => {
      setLeaving("sent");
      trame.removeDraft(d.id);
    }, 700);
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
        <Textarea defaultValue={d.proposal} disabled={status !== "idle"} className="min-h-20 rounded-xl" />
        <div className="flex gap-2">
          <Button
            className={cn("min-w-32 rounded-full transition-colors", status === "sent" && "bg-success hover:bg-success")}
            disabled={status !== "idle"}
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
          <Button variant="secondary" className="rounded-full" disabled={status !== "idle"}>
            <Pencil className="size-4" /> Modifier dans Teams
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" className="rounded-full" disabled={status !== "idle"} onClick={dismiss}>
            <Trash2 className="size-4" /> Ignorer
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Watchlist({ trame }: { trame: Trame }) {
  return (
    <div className="flex flex-col gap-3 py-5">
      <SectionLabel>Conversations surveillées</SectionLabel>
      <ConversationList
        items={trame.state.watchlist}
        onBulk={trame.setWatchMany}
        className="h-[52vh]"
        renderRow={(c) => (
          <div className="flex items-center gap-3 px-4 py-2.5">
            <Switch checked={c.watch} onCheckedChange={() => trame.toggleWatch(c.threadId)} />
            <InitialsAvatar name={c.displayName} className={cn("size-8", !c.watch && "opacity-50")} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className={cn("truncate transition-colors duration-200", !c.watch && "text-muted-foreground")}>{c.displayName}</span>
              {c.namedPeople.length > 0 && (
                <span className="truncate text-xs text-muted-foreground">réagit à : {c.namedPeople.join(", ")}</span>
              )}
            </div>
            <SurfaceTag s={c.surface} />
            <Segment value={c.mode} onChange={(v) => trame.setMode(c.threadId, v)} disabled={!c.watch} />
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

function SettingsView({ brain: initialBrain }: { brain: BrainId }) {
  const [brain, setBrain] = useState<BrainId>(initialBrain);
  return (
    <div className="flex max-w-xl flex-col gap-6 py-5">
      <div>
        <SectionLabel>Cerveau</SectionLabel>
        <BrainPicker value={brain} onChange={setBrain} size="md" />
      </div>

      <div>
        <SectionLabel>Application</SectionLabel>
        <GroupList>
          <AutostartRow />
          <div className="px-4 py-2.5 text-xs text-muted-foreground">
            Fermer la fenêtre la réduit dans la barre des tâches : Trame continue de veiller. « Quitter » depuis l'icône l'arrête.
          </div>
        </GroupList>
      </div>

      <div>
        <SectionLabel>Contexte GitHub</SectionLabel>
        <GroupList>
          <ToggleRow label="Activer le contexte GitHub" defaultChecked />
          <ToggleRow label="Tous les repos par défaut" defaultChecked />
          <div className="px-4 py-2.5 text-xs text-muted-foreground">Lecture seule · consulté seulement quand le message le justifie.</div>
        </GroupList>
      </div>

      <div>
        <SectionLabel>Sécurité</SectionLabel>
        <GroupList>
          <ToggleRow label="Auto-pause pendant un partage d'écran" defaultChecked />
          <ToggleRow label="Auto-test des sélecteurs au démarrage" defaultChecked />
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm">Compte à rebours avant envoi auto</span>
            <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs">5 s</span>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm">Jamais d'envoi auto si le message contient…</span>
            <span className="text-xs text-muted-foreground">RH, confidentiel, salaire</span>
          </div>
        </GroupList>
      </div>
    </div>
  );
}

function ToggleRow({ label, defaultChecked }: { label: string; defaultChecked?: boolean }) {
  const [on, setOn] = useState(!!defaultChecked);
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm">{label}</span>
      <Switch checked={on} onCheckedChange={setOn} />
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

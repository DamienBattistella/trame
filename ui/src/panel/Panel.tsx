import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { Send, Pencil, Trash2, History, AlertTriangle } from "lucide-react";
import { GroupList, Segment, InitialsAvatar, SectionLabel } from "@/components/kit";
import { BranchIcon } from "@/icons";
import { cn } from "@/lib/utils";
import { useTrame } from "@/api";
import { DraftItem, LogItem, Surface, WatchEntity } from "@/types";

const SURFACE = { dm: "1:1", group: "Groupe", channel: "Canal" } as const;

function SurfaceTag({ s }: { s: Surface }) {
  return <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{SURFACE[s]}</span>;
}

export function Panel({ trame }: { trame: ReturnType<typeof useTrame> }) {
  const { state } = trame;
  const drafts = state.drafts;

  return (
    <div className="mx-auto h-full max-w-3xl overflow-hidden px-6 pt-5">
      {state.paused && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2 text-sm">
          <AlertTriangle className="size-4 text-warning" /> Veille en pause — aucun message n'est traité.
        </div>
      )}
      <Tabs defaultValue="drafts" className="flex h-full flex-col">
        <TabsList className="self-start rounded-full">
          <TabsTrigger value="drafts" className="rounded-full">
            Brouillons
            {drafts.length > 0 && (
              <span className="ml-1.5 rounded-full bg-primary/15 px-1.5 text-xs text-primary">{drafts.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="watchlist" className="rounded-full">Watchlist</TabsTrigger>
          <TabsTrigger value="logs" className="rounded-full">Journal</TabsTrigger>
          <TabsTrigger value="settings" className="rounded-full">Réglages</TabsTrigger>
        </TabsList>

        <TabsContent value="drafts" className="flex-1 overflow-auto">
          <Drafts drafts={drafts} onSend={trame.sendDraft} onDismiss={trame.dismissDraft} />
        </TabsContent>
        <TabsContent value="watchlist" className="flex-1 overflow-auto">
          <Watchlist items={state.watchlist} onToggle={trame.toggleWatch} onMode={trame.setMode} />
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

function Drafts({ drafts, onSend, onDismiss }: { drafts: DraftItem[]; onSend: (id: string) => void; onDismiss: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-4 py-5">
      <div className="flex items-center justify-between">
        <SectionLabel>À relire</SectionLabel>
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => toast.info("Rattrapage lancé — brouillons uniquement")}>
          <History className="size-4" /> Rattraper les non-lus
        </Button>
      </div>

      {drafts.length === 0 && <p className="py-10 text-center text-muted-foreground">Rien à relire. 👌</p>}

      {drafts.map((d) => (
        <div key={d.id} className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
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
          <Textarea defaultValue={d.proposal} className="min-h-20 rounded-xl" />
          <div className="flex gap-2">
            <Button className="rounded-full" onClick={() => { toast.success(`Envoyé à ${d.from}`); onSend(d.id); }}>
              <Send className="size-4" /> Envoyer
            </Button>
            <Button variant="secondary" className="rounded-full"><Pencil className="size-4" /> Modifier dans Teams</Button>
            <div className="flex-1" />
            <Button variant="ghost" className="rounded-full" onClick={() => onDismiss(d.id)}><Trash2 className="size-4" /> Ignorer</Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Watchlist({ items, onToggle, onMode }: { items: WatchEntity[]; onToggle: (id: string) => void; onMode: (id: string, m: "draft" | "auto") => void }) {
  return (
    <div className="flex flex-col gap-3 py-5">
      <SectionLabel>Conversations surveillées</SectionLabel>
      <GroupList>
        {items.map((c) => (
          <div key={c.threadId} className="flex items-center gap-3 px-4 py-3">
            <Switch checked={c.watch} onCheckedChange={() => onToggle(c.threadId)} />
            <InitialsAvatar name={c.displayName} className={cn("size-8", !c.watch && "opacity-50")} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className={cn("truncate", !c.watch && "text-muted-foreground")}>{c.displayName}</span>
              {c.namedPeople.length > 0 && (
                <span className="truncate text-xs text-muted-foreground">réagit à : {c.namedPeople.join(", ")}</span>
              )}
            </div>
            <SurfaceTag s={c.surface} />
            <Segment value={c.mode} onChange={(v) => onMode(c.threadId, v)} disabled={!c.watch} />
          </div>
        ))}
      </GroupList>
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
          {logs.map((l, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className={cn("size-2 shrink-0 rounded-full", dot[l.level])} />
              <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{l.at}</span>
              <span className="flex-1">{l.text}</span>
            </div>
          ))}
        </ScrollArea>
      </GroupList>
    </div>
  );
}

function SettingsView({ brain: initialBrain }: { brain: "claude" | "copilot" }) {
  const [brain, setBrain] = useState<"claude" | "copilot">(initialBrain);
  return (
    <div className="flex max-w-xl flex-col gap-6 py-5">
      <div>
        <SectionLabel>Cerveau</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          {([["claude", "Claude", "via ton abonnement"], ["copilot", "Copilot", "via GitHub"]] as const).map(([v, name, desc]) => (
            <button
              key={v}
              onClick={() => setBrain(v)}
              className={cn(
                "flex flex-col items-center gap-0.5 rounded-2xl border-2 p-4 transition-colors",
                brain === v ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
              )}
            >
              <span className="font-semibold">{name}</span>
              <span className="text-xs text-muted-foreground">{desc}</span>
            </button>
          ))}
        </div>
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

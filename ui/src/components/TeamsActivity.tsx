import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, AtSign, Bell, Loader2, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Reply, SmilePlus } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Trame, TeamsActivityItem, TeamsCall } from "@/api";

type Filter = "all" | "mentions" | "reactions" | "calls";
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "Tout" },
  { key: "mentions", label: "Mentions et réponses" },
  { key: "reactions", label: "Réactions" },
  { key: "calls", label: "Appels" },
];

/** « 14:05 » aujourd'hui, sinon « 27/11 14:05 ». */
export function activityTime(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${hm}`;
}

/** « 3 min 20 s », « 45 s ». */
export function callDuration(s: number): string {
  if (!s) return "";
  const m = Math.floor(s / 60);
  return m ? `${m} min${s % 60 ? ` ${s % 60} s` : ""}` : `${s} s`;
}

type Row =
  | { type: "activity"; at: string | null; item: TeamsActivityItem }
  | { type: "call"; at: string | null; item: TeamsCall };

/** Le volet « Activité » de Teams lu par Trame : mentions, réponses et réactions à tes messages,
 *  dans toutes les conversations, et derniers appels. Un clic ouvre la conversation dans la liste
 *  (non suivie si elle n'y était pas). */
export function TeamsActivity({
  trame,
  open,
  onOpenChange,
  onOpened,
}: {
  trame: Trame;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpened: (threadId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [activity, setActivity] = useState<TeamsActivityItem[]>([]);
  const [calls, setCalls] = useState<TeamsCall[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    void trame.teamsActivity().then((res) => {
      if (!alive) return;
      setLoading(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSupported(res.supported);
      setActivity(res.activity);
      setCalls(res.calls);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    const acts: Row[] = activity
      .filter((a) => (filter === "mentions" ? a.kind === "mention" || a.kind === "reply" : filter === "reactions" ? a.kind === "reaction" : filter === "all"))
      .map((item) => ({ type: "activity", at: item.at, item }));
    const cs: Row[] = filter === "all" || filter === "calls" ? calls.map((item) => ({ type: "call", at: item.at, item })) : [];
    return [...acts, ...cs].sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  }, [activity, calls, filter]);

  const choose = async (threadId: string | null) => {
    if (!threadId || opening) return;
    if (!trame.state.watchlist.some((w) => w.threadId === threadId)) {
      setOpening(threadId);
      const res = await trame.openOlder(threadId);
      setOpening(null);
      if (!res.ok) {
        toast.error("Conversation introuvable dans la liste de Teams", { description: res.error });
        return;
      }
    }
    onOpened(threadId);
    onOpenChange(false);
  };

  const missed = calls.filter((c) => c.missed).length;

  return (
    <Dialog open={open} onOpenChange={(o) => !opening && onOpenChange(o)}>
      <DialogContent className="flex max-h-[min(42rem,calc(100dvh-4rem))] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>Activité Teams</DialogTitle>
          <DialogDescription>Mentions, réponses et réactions à tes messages, dans toutes tes conversations, et derniers appels.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5 px-5 pb-3" role="tablist" aria-label="Filtrer l'activité">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs",
                filter === f.key ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-accent",
              )}
            >
              {f.label}
              {f.key === "calls" && missed > 0 && <span className="ml-1 tabular-nums">({missed} manqué{missed > 1 ? "s" : ""})</span>}
            </button>
          ))}
        </div>
        {!supported && (
          <p className="mx-5 mb-3 flex gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm" role="status">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>Le pilote Teams actuel ne sait pas lire l'activité de Teams.</span>
          </p>
        )}
        {error && (
          <p className="mx-5 mb-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" role="alert">
            {error}
          </p>
        )}
        <ul aria-label="Activité Teams" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {loading && (
            <li className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Lecture de l'activité de Teams…
            </li>
          )}
          {!loading && supported && !error && rows.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">Rien de récent ici.</li>
          )}
          {!loading &&
            rows.map((r, i) => {
              const threadId = r.item.threadId;
              const busy = opening !== null && opening === threadId;
              return (
                <li key={`${r.type}-${i}`}>
                  <button
                    type="button"
                    onClick={() => void choose(threadId)}
                    disabled={!threadId || Boolean(opening)}
                    className="flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
                      {busy ? <Loader2 className="size-4 animate-spin" /> : r.type === "call" ? <CallIcon call={r.item} /> : <ActivityIcon kind={r.item.kind} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      {r.type === "call" ? <CallText call={r.item} /> : <ActivityText item={r.item} />}
                    </span>
                    <span className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">{activityTime(r.at)}</span>
                  </button>
                </li>
              );
            })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function ActivityIcon({ kind }: { kind: TeamsActivityItem["kind"] }) {
  if (kind === "mention") return <AtSign className="size-4 text-primary" />;
  if (kind === "reply") return <Reply className="size-4" />;
  if (kind === "reaction") return <SmilePlus className="size-4" />;
  return <Bell className="size-4" />;
}

function CallIcon({ call }: { call: TeamsCall }) {
  if (call.missed) return <PhoneMissed className="size-4 text-destructive" />;
  if (call.direction === "outgoing") return <PhoneOutgoing className="size-4" />;
  return call.durationS ? <PhoneIncoming className="size-4" /> : <Phone className="size-4" />;
}

const VERB: Record<TeamsActivityItem["kind"], string> = {
  mention: "t'a mentionné",
  reply: "a répondu",
  reaction: "a réagi à ton message",
  other: "",
};

function ActivityText({ item }: { item: TeamsActivityItem }) {
  return (
    <>
      <span className="block truncate text-sm">
        <span className="font-medium">{item.from || "Quelqu'un"}</span> {VERB[item.kind] || item.type}
        {item.conversation && <span className="text-muted-foreground"> · {item.conversation}</span>}
      </span>
      {item.preview && <span className="block truncate text-xs text-muted-foreground">{item.preview}</span>}
    </>
  );
}

function CallText({ call }: { call: TeamsCall }) {
  const who = call.with || "Correspondant inconnu";
  const what = call.missed ? "Appel manqué" : call.direction === "outgoing" ? "Appel sortant" : "Appel entrant";
  const length = callDuration(call.durationS);
  return (
    <>
      <span className={cn("block truncate text-sm", call.missed && "text-destructive")}>
        <span className="font-medium">{who}</span>
      </span>
      <span className="block truncate text-xs text-muted-foreground">
        {what}
        {length && ` · ${length}`}
      </span>
    </>
  );
}

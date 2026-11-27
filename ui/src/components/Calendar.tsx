import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Info,
  Loader2,
  MessagesSquare,
  NotebookPen,
  RefreshCw,
  Repeat,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { Trame } from "@/api";
import type { Meeting } from "@/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InitialsAvatar, Segment } from "@/components/kit";
import { ReportDialog } from "@/components/ReportDialog";
import { memory, type Fetch } from "@/components/Meetings";
import { cn } from "@/lib/utils";
import { useMedia } from "@/lib/useMedia";
import { durationLabel, durationMinutes, fold, occurrences, shortPath, slotOf } from "@/lib/meetings";
import {
  addDays,
  byDay,
  dayLabel,
  hourRange,
  isoDay,
  isoWeek,
  layoutDay,
  monthGrid,
  monthLabel,
  parseDay,
  rangeLabel,
  relativeLabel,
  untimed,
  visibleDays,
  WEEKDAY_SHORT,
  type Placed,
} from "@/lib/calendar";
import type { ReportSession } from "@/types";

/** Hauteur d'une heure dans la grille. */
const HOUR = 64;

type Tone = "saved" | "available" | "none";

/** Une couleur par état de transcription, pas par réunion : vert enregistrée, violet Teams à récupérer, neutre sans. */
const TONE: Record<Tone, { label: string; block: string; dot: string; title: string }> = {
  saved: {
    label: "Transcription enregistrée",
    block: "border-success/45 bg-success/12 hover:bg-success/18",
    dot: "bg-success",
    title: "text-success",
  },
  available: {
    label: "Transcription à récupérer",
    block: "border-teams/50 bg-teams/14 hover:bg-teams/20",
    dot: "bg-teams",
    title: "text-[color-mix(in_oklch,var(--teams)_55%,var(--foreground))]",
  },
  none: {
    label: "Sans transcription",
    block: "border-border bg-muted/50 hover:bg-muted",
    dot: "bg-muted-foreground/60",
    title: "text-foreground",
  },
};

const timeZone = (() => {
  try {
    return new Intl.DateTimeFormat("fr-FR", { timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
})();

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/**
 * Calendrier des réunions Teams que Trame a lues : la semaine (ou un jour) en grille
 * horaire, comme l'agenda de Teams ou d'Outlook. La couleur dit l'état de la transcription ;
 * un clic ouvre le volet de la réunion (transcription, détails, compte-rendu).
 * Même liste que Réunions, partagée en mémoire : rien n'est relu dans Teams sans demande.
 */
export function Calendar({ trame }: { trame: Trame }) {
  const [meetings, setMeetings] = useState<Meeting[] | null>(memory.meetings);
  const [fetches, setFetches] = useState<Record<string, Fetch>>(memory.fetches);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const [anchor, setAnchor] = useState(() => new Date());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<ReportSession | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const view = trame.calendarView;
  const wide = useMedia("(min-width: 80rem)");

  useEffect(() => {
    memory.meetings = meetings;
    memory.fetches = fetches;
  }, [meetings, fetches]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // Au premier affichage, la liste gardée sur le poste, comme dans Réunions.
  useEffect(() => {
    if (memory.meetings) return;
    void trame.knownMeetings().then((res) => {
      if (!res.ok || res.meetings.length === 0 || memory.meetings) return;
      memory.readAt = res.readAt;
      memory.directory = res.directory;
      setMeetings(res.meetings);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async () => {
    setLoading(true);
    setError(null);
    const res = await trame.listMeetings();
    setLoading(false);
    if (!res.ok) {
      setError({ message: res.error, status: res.status });
      return;
    }
    memory.readAt = new Date();
    memory.directory = res.directory;
    setMeetings(res.meetings);
    setFetches((f) => Object.fromEntries(Object.entries(f).filter(([, x]) => x.state === "error")));
  };

  const savedOf = (m: Meeting) => {
    const f = fetches[m.meetingId];
    return f?.state === "ok" ? { path: f.saved.path, name: f.saved.name } : m.saved;
  };
  const toneOf = (m: Meeting): Tone => (savedOf(m) ? "saved" : m.transcript ? "available" : "none");

  const days = useMemo(() => visibleDays(anchor, view), [anchor, view]);
  const perDay = useMemo(() => byDay(meetings ?? []), [meetings]);
  const counts = useMemo(() => occurrences(meetings ?? []), [meetings]);
  const placedByDay = useMemo(() => days.map((d) => layoutDay(perDay.get(isoDay(d)) ?? [])), [days, perDay]);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todayShown = days.some((d) => isoDay(d) === isoDay(now));
  // L'heure actuelle reste dans la grille quand aujourd'hui est affiché, même tôt le matin ou le soir.
  const range = useMemo(
    () => hourRange([...placedByDay.flat(), ...(todayShown ? [{ start: nowMinutes, end: nowMinutes + 30 }] : [])]),
    [placedByDay, todayShown, Math.floor(nowMinutes / 30)] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const allDay = days.map((d) => untimed(perDay.get(isoDay(d)) ?? []));
  const shownCount = placedByDay.reduce((n, p) => n + p.length, 0) + allDay.reduce((n, a) => n + a.length, 0);
  const latest = useMemo(
    () => (meetings ?? []).map((m) => m.date).filter((d): d is string => !!d).sort().pop() ?? null,
    [meetings]
  );

  const step = (dir: -1 | 1) => setAnchor((a) => addDays(a, dir * (view === "week" ? 7 : 1)));
  const today = isoDay(now);
  const onToday = days.some((d) => isoDay(d) === today);

  const fetchOne = async (m: Meeting) => {
    setFetches((f) => ({ ...f, [m.meetingId]: { state: "run" } }));
    const res = await trame.saveTranscript(m, memory.directory || undefined);
    if (!res.ok) {
      const kind = res.status === 404 ? "none" : res.status === 403 ? "denied" : "other";
      setFetches((f) => ({ ...f, [m.meetingId]: { state: "error", error: res.error, kind } }));
      toast.error("Transcription non récupérée", { description: res.error });
      return;
    }
    memory.directory = res.directory;
    setFetches((f) => ({ ...f, [m.meetingId]: { state: "ok", saved: res } }));
    setMeetings((ms) => ms?.map((x) => (x.meetingId === m.meetingId ? { ...x, organizer: res.organizer || x.organizer, saved: { path: res.path, name: res.name } } : x)) ?? ms);
    toast.success("Transcription enregistrée", { description: res.name, action: { label: "Ouvrir", onClick: () => void openFile(res.path) } });
  };
  const openFile = async (path: string, reveal = false) => {
    const res = await trame.openTranscript(path, reveal);
    if (!res.ok) toast.error(reveal ? "Fichier non affiché" : "Fichier non ouvert", { description: res.error });
  };
  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast.success("Chemin copié", { description: path });
    } catch {
      toast.error("Chemin non copié");
    }
  };
  const startReport = async (m: Meeting) => {
    setStarting(m.meetingId);
    const res = await trame.startReport(m, savedOf(m)?.path ?? undefined);
    setStarting(null);
    if (res.ok) {
      setSelectedId(null);
      setReport(res.report);
    } else toast.error("Compte-rendu impossible", { description: res.error });
  };

  const detail = (m: Meeting) => (
    <MeetingCard
      meeting={m}
      now={now}
      tone={toneOf(m)}
      saved={savedOf(m)}
      fetch={fetches[m.meetingId]}
      repeats={counts.get(fold(m.title)) ?? 1}
      reporting={starting === m.meetingId}
      onClose={() => setSelectedId(null)}
      onFetch={() => void fetchOne(m)}
      onOpen={(p) => void openFile(p)}
      onReveal={(p) => void openFile(p, true)}
      onCopy={(p) => void copyPath(p)}
      onReport={() => void startReport(m)}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 pb-4">
      {report && <ReportDialog trame={trame} session={report} onClose={() => setReport(null)} />}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-lg font-semibold">Calendrier</h1>
        <span className="text-base text-muted-foreground first-letter:uppercase tabular-nums" aria-live="polite">
          {rangeLabel(days)}
        </span>
        <span className="rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground tabular-nums">
          Semaine {isoWeek(days[0])}
        </span>
        <div className="flex-1" />
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => setAnchor(new Date())} disabled={onToday && view === "week"}>
          Aujourd'hui
        </Button>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" className="rounded-full" aria-label={view === "week" ? "Semaine précédente" : "Jour précédent"} onClick={() => step(-1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="outline" size="icon-sm" className="rounded-full" aria-label={view === "week" ? "Semaine suivante" : "Jour suivant"} onClick={() => step(1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <Segment
          label="Vue du calendrier"
          value={view}
          onChange={trame.setCalendarView}
          options={[
            { value: "day", label: "Jour" },
            { value: "week", label: "Semaine" },
          ]}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Relire les réunions dans Teams" onClick={load} disabled={loading}>
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Relire les réunions dans Teams</TooltipContent>
        </Tooltip>
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-xl bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">Réunions non relues : {error.message}</span>
          <Button variant="ghost" size="sm" className="h-7 rounded-full" onClick={load}>Réessayer</Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-5">
        {wide && (
          <aside aria-label="Navigation du calendrier" className="flex w-60 shrink-0 flex-col gap-5 3xl:w-64">
            <MiniMonth anchor={anchor} days={days} today={today} busy={perDay} onPick={setAnchor} />
            <Legend />
            <p className="px-1 text-xs text-pretty text-muted-foreground">
              Les réunions Teams que Trame a lues, terminées ou en cours. {meetings ? "" : "Aucune liste lue pour l'instant."}
            </p>
          </aside>
        )}

        <section
          aria-label={`Réunions du ${rangeLabel(days)}`}
          aria-busy={loading}
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-card"
        >
          <Grid
            days={days}
            today={today}
            now={now}
            range={range}
            placedByDay={placedByDay}
            allDay={allDay}
            selectedId={selectedId}
            toneOf={toneOf}
            onSelect={setSelectedId}
            detail={detail}
          />
          {shownCount === 0 && (
            <EmptyOverlay
              loading={loading}
              listed={meetings !== null}
              latest={latest}
              onLoad={load}
              onLatest={() => latest && setAnchor(parseDay(latest)!)}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function Grid({
  days,
  today,
  now,
  range,
  placedByDay,
  allDay,
  selectedId,
  toneOf,
  onSelect,
  detail,
}: {
  days: Date[];
  today: string;
  now: Date;
  range: { from: number; to: number };
  placedByDay: Placed<Meeting>[][];
  allDay: Meeting[][];
  selectedId: string | null;
  toneOf: (m: Meeting) => Tone;
  onSelect: (id: string | null) => void;
  detail: (m: Meeting) => React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const hours = Array.from({ length: range.to - range.from }, (_, i) => range.from + i);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowTop = ((nowMinutes - range.from * 60) / 60) * HOUR;
  const nowVisible = days.some((d) => isoDay(d) === today) && nowMinutes >= range.from * 60 && nowMinutes <= range.to * 60;
  const cols = { gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` };
  const hasAllDay = allDay.some((a) => a.length > 0);

  // À l'ouverture et en changeant de période : l'heure actuelle, sinon la première réunion, un peu au-dessus.
  const firstKey = days.map(isoDay).join();
  const anyPlaced = placedByDay.some((p) => p.length > 0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = Math.min(...placedByDay.flat().map((p) => p.start), Infinity);
    const target = nowVisible ? nowMinutes : first === Infinity ? range.from * 60 : first;
    el.scrollTop = Math.max(0, ((target - range.from * 60) / 60) * HOUR - HOUR);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstKey, anyPlaced]);

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">
      <div className="sticky top-0 z-20 grid border-b bg-card" style={cols}>
        <div className="flex items-end justify-end pr-2 pb-2 text-[11px] text-muted-foreground">{timeZone}</div>
        {days.map((d) => {
          const iso = isoDay(d);
          const isToday = iso === today;
          const weekend = d.getDay() === 0 || d.getDay() === 6;
          return (
            <div key={iso} className={cn("flex min-w-0 items-center gap-1.5 border-l px-2 py-2.5 lg:px-3", weekend && "text-muted-foreground")}>
              <span
                className={cn(
                  "grid h-7 min-w-7 place-items-center rounded-lg px-1 text-lg font-medium tabular-nums",
                  isToday && "bg-foreground text-background"
                )}
                aria-current={isToday ? "date" : undefined}
              >
                {d.getDate()}
              </span>
              <span className="truncate text-sm text-muted-foreground first-letter:uppercase">
                {days.length === 1 ? dayLabel(d) : WEEKDAY_SHORT[(d.getDay() + 6) % 7]}
              </span>
            </div>
          );
        })}
      </div>

      {hasAllDay && (
        <div className="sticky top-[3.25rem] z-20 grid border-b bg-card" style={cols}>
          <div className="flex items-center justify-end pr-2 text-[11px] text-muted-foreground">Sans heure</div>
          {allDay.map((items, i) => (
            <div key={i} className="flex min-w-0 flex-col gap-1 border-l p-1">
              {items.map((m) => (
                <EventPopover key={m.meetingId} open={selectedId === m.meetingId} onOpen={(o) => onSelect(o ? m.meetingId : null)} detail={detail(m)}>
                  <button
                    type="button"
                    className={cn("truncate rounded-md border px-2 py-1 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60", TONE[toneOf(m)].block, TONE[toneOf(m)].title)}
                  >
                    {m.title}
                  </button>
                </EventPopover>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="relative grid" style={{ ...cols, height: hours.length * HOUR }}>
        <div className="relative">
          {hours.map((h, i) => (
            <span key={h} className="absolute right-2 -translate-y-1/2 text-[11px] text-muted-foreground tabular-nums" style={{ top: i * HOUR }}>
              {i === 0 ? "" : `${pad(h)}:00`}
            </span>
          ))}
          {nowVisible && (
            <span
              className="absolute right-1 z-10 -translate-y-1/2 rounded-md bg-destructive px-1 text-[11px] font-medium text-destructive-foreground tabular-nums"
              style={{ top: nowTop }}
            >
              {hhmm(nowMinutes)}
            </span>
          )}
        </div>
        {days.map((d, di) => {
          const iso = isoDay(d);
          const weekend = d.getDay() === 0 || d.getDay() === 6;
          return (
            <div key={iso} className={cn("relative border-l", weekend && "bg-muted/25")}>
              {hours.map((h, i) => (
                <div key={h} aria-hidden className={cn("absolute inset-x-0 border-t border-border/60", i === 0 && "border-t-0")} style={{ top: i * HOUR }} />
              ))}
              {placedByDay[di].map((p) => (
                <EventBlock
                  key={p.item.meetingId}
                  placed={p}
                  from={range.from}
                  tone={toneOf(p.item)}
                  selected={selectedId === p.item.meetingId}
                  onSelect={(open) => onSelect(open ? p.item.meetingId : null)}
                  detail={detail(p.item)}
                />
              ))}
              {nowVisible && iso === today && (
                <div aria-hidden className="pointer-events-none absolute inset-x-0 z-10" style={{ top: nowTop }}>
                  <span className="absolute -top-[5px] -left-[5px] size-2.5 rounded-full bg-destructive" />
                  <div className="h-0.5 bg-destructive" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Le volet s'ancre sur le bloc cliqué, à droite (à gauche s'il manque la place). */
function EventPopover({ open, onOpen, detail, children }: { open: boolean; onOpen: (open: boolean) => void; detail: React.ReactNode; children: React.ReactNode }) {
  return (
    <Popover open={open} onOpenChange={onOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={10}
        collisionPadding={16}
        className="max-h-(--radix-popover-content-available-height) w-[min(26rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {detail}
      </PopoverContent>
    </Popover>
  );
}

function EventBlock({
  placed: p,
  from,
  tone,
  selected,
  onSelect,
  detail,
}: {
  placed: Placed<Meeting>;
  from: number;
  tone: Tone;
  selected: boolean;
  onSelect: (open: boolean) => void;
  detail: React.ReactNode;
}) {
  const m = p.item;
  const top = ((p.start - from * 60) / 60) * HOUR;
  const height = Math.max(((p.end - p.start) / 60) * HOUR - 3, 20);
  const short = height < 44;
  const { start, end } = slotOf(m);
  const style: React.CSSProperties = {
    top: top + 1,
    height,
    left: `calc(${(p.column / p.columns) * 100}% + 3px)`,
    width: `calc(${100 / p.columns}% - 6px)`,
  };
  return (
    <EventPopover open={selected} onOpen={onSelect} detail={detail}>
      <button
        type="button"
        style={style}
        aria-label={`${m.title}, ${start} à ${end}, ${TONE[tone].label.toLowerCase()}`}
        className={cn(
          "absolute z-[1] flex min-w-0 overflow-hidden rounded-lg border px-2 text-left outline-none transition-[background-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring/60",
          short ? "items-center gap-1.5 py-0" : "flex-col py-1.5",
          TONE[tone].block,
          selected && "z-[2] border-2 shadow-md"
        )}
      >
        <span className={cn("truncate text-[13px] leading-tight font-medium", TONE[tone].title)}>{m.title}</span>
        <span className="truncate text-xs leading-tight text-muted-foreground tabular-nums">
          {short ? start : `${start} à ${end}`}
        </span>
        {!short && height > 76 && tone === "available" && (
          <span className="mt-auto flex items-center gap-1 truncate text-xs text-muted-foreground">
            <Download className="size-3 shrink-0" /> À récupérer
          </span>
        )}
        {!short && height > 76 && tone === "saved" && (
          <span className="mt-auto flex items-center gap-1 truncate text-xs text-muted-foreground">
            <FileText className="size-3 shrink-0" /> Transcription
          </span>
        )}
      </button>
    </EventPopover>
  );
}

function MeetingCard({
  meeting: m,
  now,
  tone,
  saved,
  fetch,
  repeats,
  reporting,
  onClose,
  onFetch,
  onOpen,
  onReveal,
  onCopy,
  onReport,
}: {
  meeting: Meeting;
  now: Date;
  tone: Tone;
  saved: { path: string; name: string } | null;
  fetch?: Fetch;
  repeats: number;
  reporting: boolean;
  onClose: () => void;
  onFetch: () => void;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
  onCopy: (path: string) => void;
  onReport: () => void;
}) {
  const { start, end } = slotOf(m);
  const day = parseDay(m.date);
  const duration = durationLabel(durationMinutes(start, end));
  const relative = relativeLabel(m, now);
  const running = fetch?.state === "run";
  const got = fetch?.state === "ok" ? fetch.saved : null;
  const refused = fetch?.state === "error" ? fetch : null;
  const when = [day ? dayLabel(day) : m.when || "Date inconnue", start && end ? `${start} à ${end}` : null].filter(Boolean).join(", ");

  const reportButton = (
    <Button size="sm" className="rounded-full" onClick={onReport} disabled={reporting || running || !m.transcript}>
      {reporting ? <Loader2 className="size-4 animate-spin" /> : <NotebookPen className="size-4" />}
      {reporting ? "Préparation…" : "Compte-rendu"}
    </Button>
  );

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2.5 px-5 pt-4 pb-3">
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium">
            <span className={cn("size-2 rounded-full", TONE[tone].dot)} /> {TONE[tone].label}
          </span>
          {relative && <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-muted-foreground">{relative}</span>}
          <div className="flex-1" />
          <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Fermer" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <h2 className="text-xl leading-snug font-semibold text-balance">{m.title}</h2>
        <p className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums first-letter:uppercase">
          <Clock className="size-4 shrink-0" />
          <span className="first-letter:uppercase">{when}</span>
          {duration && <span>· {duration}</span>}
        </p>
        <div className="flex items-center gap-2">
          {m.organizer ? (
            <>
              <InitialsAvatar name={m.organizer} className="size-7" />
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">Organisée par {m.organizer}</span>
            </>
          ) : (
            <span className="min-w-0 flex-1 text-sm text-muted-foreground">Organisation connue une fois la transcription relue</span>
          )}
          {m.transcript ? (
            reportButton
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">{reportButton}</span>
              </TooltipTrigger>
              <TooltipContent>Il faut une transcription pour un compte-rendu</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <Tabs defaultValue="transcript" className="gap-0">
        <TabsList variant="line" className="h-9 w-full justify-start gap-4 border-b px-5">
          <TabsTrigger value="transcript" className="flex-none px-0">
            <FileText /> Transcription
          </TabsTrigger>
          <TabsTrigger value="details" className="flex-none px-0">
            <Info /> Détails
          </TabsTrigger>
        </TabsList>

        <TabsContent value="transcript" className="flex flex-col gap-3 px-5 py-4">
          <div className="rounded-xl border bg-muted/40 p-4">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-medium">
                <FileText className="size-4 text-link" /> Transcription
              </span>
              {saved && <span className="text-xs text-muted-foreground">Sur ce poste</span>}
            </div>
            <p className="text-sm text-pretty text-muted-foreground">
              {running
                ? "Trame relit la transcription dans sa fenêtre Teams…"
                : saved
                  ? `Enregistrée en .vtt, prête pour un compte-rendu.`
                  : refused
                    ? refused.error
                    : m.transcript
                      ? "Disponible dans Teams, pas encore enregistrée sur ce poste."
                      : "Teams n'a pas de transcription pour cette réunion."}
            </p>
          </div>

          {(saved || got) && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-sm">
              <Fact icon={<FileText className="size-4" />} label="Fichier" value={saved?.name ?? got?.name ?? ""} />
              {got && got.speakers.length > 0 && <Fact icon={<Users className="size-4" />} label="Intervenants" value={got.speakers.join(", ")} />}
              {saved && <Fact icon={<FolderOpen className="size-4" />} label="Dossier" value={shortPath(saved.path)} />}
            </dl>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {saved ? (
              <>
                <Chip onClick={() => onOpen(saved.path)} icon={<FileText className="size-3.5" />}>Ouvrir</Chip>
                <Chip onClick={() => onReveal(saved.path)} icon={<FolderOpen className="size-3.5" />}>Afficher dans le dossier</Chip>
                <Chip onClick={() => onCopy(saved.path)} icon={<Copy className="size-3.5" />}>Copier le chemin</Chip>
              </>
            ) : (
              m.transcript &&
              refused?.kind !== "none" &&
              refused?.kind !== "denied" && (
                <Chip onClick={onFetch} disabled={running} icon={running ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}>
                  {running ? "Récupération…" : "Récupérer la transcription"}
                </Chip>
              )
            )}
          </div>
        </TabsContent>

        <TabsContent value="details" className="px-5 py-4">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2.5 text-sm">
            <Fact icon={<CalendarClock className="size-4" />} label="Date" value={day ? dayLabel(day) + " " + day.getFullYear() : m.when || "Inconnue"} />
            {start && end && <Fact icon={<Clock className="size-4" />} label="Horaire" value={`${start} à ${end}${duration ? ` · ${duration}` : ""}`} />}
            <Fact icon={<Repeat className="size-4" />} label="Série" value={repeats > 1 ? `${repeats} occurrences dans la liste` : "Réunion ponctuelle"} />
            {m.chat && m.chat !== m.title && <Fact icon={<MessagesSquare className="size-4" />} label="Conversation" value={m.chat} />}
          </dl>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Fact({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <>
      <dt className="flex items-center gap-2 text-muted-foreground">
        {icon} {label}
      </dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  );
}

function Chip({ icon, children, onClick, disabled }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-xs font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60"
    >
      {icon}
      {children}
    </button>
  );
}

function MiniMonth({
  anchor,
  days,
  today,
  busy,
  onPick,
}: {
  anchor: Date;
  days: Date[];
  today: string;
  busy: Map<string, Meeting[]>;
  onPick: (d: Date) => void;
}) {
  const [month, setMonth] = useState(() => new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  useEffect(() => setMonth(new Date(anchor.getFullYear(), anchor.getMonth(), 1)), [anchor]);
  const shown = new Set(days.map(isoDay));
  const grid = monthGrid(month);
  return (
    <div className="rounded-2xl border bg-card p-3">
      <div className="mb-2 flex items-center justify-between pl-1">
        <span className="text-sm font-medium first-letter:uppercase">{monthLabel(month)}</span>
        <div className="flex">
          <Button variant="ghost" size="icon-sm" className="size-7 rounded-full" aria-label="Mois précédent" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}>
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" className="size-7 rounded-full" aria-label="Mois suivant" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
      <div role="grid" aria-label={monthLabel(month)} className="grid grid-cols-7 gap-y-0.5 text-center text-xs">
        <div role="row" className="contents">
          {["L", "M", "M", "J", "V", "S", "D"].map((l, i) => (
            <span key={i} role="columnheader" aria-label={WEEKDAY_SHORT[i]} className="py-1 text-muted-foreground">{l}</span>
          ))}
        </div>
        {grid.map((week) => {
          const inView = week.some((d) => shown.has(isoDay(d)));
          return (
            <div key={isoDay(week[0])} role="row" className={cn("col-span-7 grid grid-cols-7 rounded-lg", inView && days.length > 1 && "bg-secondary")}>
              {week.map((d) => {
                const iso = isoDay(d);
                const out = d.getMonth() !== month.getMonth();
                const has = busy.has(iso);
                return (
                  <button
                    key={iso}
                    type="button"
                    role="gridcell"
                    aria-selected={shown.has(iso)}
                    aria-label={`${dayLabel(d)}${has ? `, ${busy.get(iso)!.length} réunion${busy.get(iso)!.length > 1 ? "s" : ""}` : ""}`}
                    onClick={() => onPick(d)}
                    className={cn(
                      "relative mx-auto grid size-7 place-items-center rounded-full tabular-nums outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60",
                      out && "text-muted-foreground/60",
                      days.length === 1 && shown.has(iso) && "bg-secondary",
                      iso === today && "bg-primary font-semibold text-primary-foreground hover:bg-primary"
                    )}
                  >
                    {d.getDate()}
                    {has && iso !== today && <span aria-hidden className="absolute bottom-0.5 size-1 rounded-full bg-link" />}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <ul className="flex flex-col gap-2 px-1 text-xs text-muted-foreground" aria-label="Légende">
      {(Object.keys(TONE) as Tone[]).map((t) => (
        <li key={t} className="flex items-center gap-2">
          <span className={cn("size-2.5 rounded-sm", TONE[t].dot)} /> {TONE[t].label}
        </li>
      ))}
    </ul>
  );
}

function EmptyOverlay({
  loading,
  listed,
  latest,
  onLoad,
  onLatest,
}: {
  loading: boolean;
  listed: boolean;
  latest: string | null;
  onLoad: () => void;
  onLatest: () => void;
}) {
  const latestDay = parseDay(latest);
  return (
    <div className="pointer-events-none absolute inset-0 top-14 grid place-items-center p-6">
      <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-2 rounded-2xl border bg-card/95 px-6 py-6 text-center shadow-sm">
        <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
          {loading ? <Loader2 className="size-5 animate-spin" /> : <CalendarClock className="size-5" />}
        </span>
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">Trame parcourt tes conversations de réunion dans Teams…</p>
        ) : !listed ? (
          <>
            <div className="text-sm font-medium">Tes réunions ne sont pas encore lues</div>
            <p className="text-sm text-pretty text-muted-foreground">
              Trame ouvre tes conversations de réunion récentes dans sa fenêtre Teams, en lecture seule, pour les placer ici.
            </p>
            <Button className="mt-2 rounded-full" onClick={onLoad}>Chercher mes réunions</Button>
          </>
        ) : (
          <>
            <div className="text-sm font-medium">Aucune réunion sur cette période</div>
            {latestDay ? (
              <Button variant="outline" className="mt-2 rounded-full" onClick={onLatest}>
                Aller à la dernière ({dayLabel(latestDay)})
              </Button>
            ) : (
              <p className="text-sm text-pretty text-muted-foreground">Trame ne connaît que les réunions qu'il a lues dans Teams.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

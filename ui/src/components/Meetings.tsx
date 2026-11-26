import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  CalendarClock,
  Clock,
  Copy,
  Download,
  FileCheck2,
  FileText,
  FileWarning,
  FileX2,
  FolderOpen,
  FolderSearch,
  Loader2,
  Lock,
  MoreHorizontal,
  NotebookPen,
  RefreshCw,
  Repeat,
  Search,
  SearchX,
  Unplug,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Trame } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GroupList, InitialsAvatar, SectionLabel, pop } from "@/components/kit";
import { cn } from "@/lib/utils";
import { useMedia } from "@/lib/useMedia";
import { dayOf, durationLabel, durationMinutes, fold, groupByPeriod, matches, occurrences, shortDate, shortPath, slotOf } from "@/lib/meetings";
import { Meeting, ReportSession, SavedTranscript } from "@/types";
import { ReportDialog } from "@/components/ReportDialog";

type Fetch =
  | { state: "queued" }
  | { state: "run" }
  | { state: "ok"; saved: SavedTranscript }
  | { state: "error"; error: string; kind: "none" | "denied" | "other" };

/** Le motif d'un refus : « none » et « denied » ne servent à rien de réessayer. */
const kindOf = (status?: number): "none" | "denied" | "other" => (status === 404 ? "none" : status === 403 ? "denied" : "other");

type ListError = { message: string; status?: number };

// La liste survit au changement d'onglet : la relire rouvre les conversations de réunion dans Teams.
const memory: { meetings: Meeting[] | null; directory: string; readAt: Date | null; fetches: Record<string, Fetch> } = {
  meetings: null,
  directory: "",
  readAt: null,
  fetches: {},
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const clock = (d: Date) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** Réunions Teams terminées et leur transcription, enregistrée en .vtt sur le poste
 *  (lisible par le skill meeting-report). Trame ouvre chaque conversation de réunion dans
 *  sa fenêtre Teams et relit l'onglet « Transcript » : rien n'est écrit dans Teams. */
export function Meetings({ trame }: { trame: Trame }) {
  const [meetings, setMeetings] = useState<Meeting[] | null>(memory.meetings);
  const [readAt, setReadAt] = useState<Date | null>(memory.readAt);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ListError | null>(null);
  const [directory, setDirectory] = useState(memory.directory);
  const [fetches, setFetches] = useState<Record<string, Fetch>>(memory.fetches);
  const [query, setQuery] = useState("");
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stopBatch = useRef(false);
  // Compte-rendu (skill meeting-report) ouvert dans le dialogue, et la réunion qui le prépare.
  const [report, setReport] = useState<ReportSession | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  // Fenêtre moyenne ou large : la liste et, à côté, le détail de la réunion choisie.
  const split = useMedia("(min-width: 80rem)");

  useEffect(() => {
    Object.assign(memory, { meetings, readAt, directory, fetches });
  }, [meetings, readAt, directory, fetches]);

  useEffect(() => {
    if (directory) return;
    void trame.getTranscriptsFolder().then((res) => res.ok && setDirectory((d) => d || res.directory));
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
    setMeetings(res.meetings);
    setReadAt(new Date());
    setDirectory(res.directory);
    // Un fichier relu depuis le disque remplace l'état d'une récupération précédente.
    setFetches((f) => Object.fromEntries(Object.entries(f).filter(([, x]) => x.state === "error")));
  };

  const setFetch = (id: string, f: Fetch) => setFetches((all) => ({ ...all, [id]: f }));

  const fetchOne = async (m: Meeting, quiet = false): Promise<Fetch> => {
    setFetch(m.meetingId, { state: "run" });
    const res = await trame.saveTranscript(m, undefined);
    const next: Fetch = res.ok
      ? { state: "ok", saved: res }
      : { state: "error", error: res.error, kind: kindOf(res.status) };
    setFetch(m.meetingId, next);
    if (res.ok) {
      setDirectory(res.directory);
      setMeetings((ms) => ms?.map((x) => (x.meetingId === m.meetingId ? { ...x, organizer: res.organizer || x.organizer, saved: { path: res.path, name: res.name } } : x)) ?? ms);
      if (!quiet)
        toast.success("Transcription enregistrée", {
          description: res.name,
          action: { label: "Ouvrir", onClick: () => void openFile(res.path) },
        });
    }
    return next;
  };

  const savedOf = (m: Meeting) => {
    const f = fetches[m.meetingId];
    return f?.state === "ok" ? { path: f.saved.path, name: f.saved.name } : m.saved;
  };
  // « Nouvelles » : avec transcription, pas encore sur le disque, sans refus définitif.
  const fresh = (meetings ?? []).filter((m) => {
    const f = fetches[m.meetingId];
    return m.transcript && !savedOf(m) && !(f?.state === "error" && f.kind !== "other") && f?.state !== "run";
  });

  const fetchAll = async () => {
    const todo = [...fresh];
    stopBatch.current = false;
    setFetches((all) => ({ ...all, ...Object.fromEntries(todo.map((m) => [m.meetingId, { state: "queued" } as Fetch])) }));
    setBatch({ done: 0, total: todo.length });
    let saved = 0;
    let failed = 0;
    for (const [i, m] of todo.entries()) {
      if (stopBatch.current) {
        setFetches((all) => Object.fromEntries(Object.entries(all).filter(([, f]) => f.state !== "queued")));
        break;
      }
      const r = await fetchOne(m, true);
      if (r.state === "ok") saved += 1;
      else failed += 1;
      setBatch({ done: i + 1, total: todo.length });
    }
    setBatch(null);
    if (saved || failed)
      (failed ? toast.warning : toast.success)(`${plural(saved, "transcription enregistrée", "transcriptions enregistrées")}`, {
        description: failed ? `${plural(failed, "réunion")} non ${failed > 1 ? "récupérées" : "récupérée"} : le motif est sur la ligne.` : undefined,
      });
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

  const counts = useMemo(() => occurrences(meetings ?? []), [meetings]);
  const visible = useMemo(() => (meetings ?? []).filter((m) => matches(m, query)), [meetings, query]);
  const groups = useMemo(() => groupByPeriod(visible, new Date()), [visible]);
  const savedCount = (meetings ?? []).filter((m) => savedOf(m)).length;
  const searchable = (meetings?.length ?? 0) > 6;
  // Sans choix, la plus récente de la liste affichée ; un filtre qui la cache passe à la suivante visible.
  const selected = split ? (visible.find((m) => m.meetingId === selectedId) ?? groups[0]?.items[0] ?? null) : null;

  const startReport = async (m: Meeting) => {
    setStarting(m.meetingId);
    const res = await trame.startReport(m, savedOf(m)?.path);
    setStarting(null);
    if (res.ok) setReport(res.report);
    else toast.error("Compte-rendu impossible", { description: res.error });
  };

  return (
    <div className="flex flex-col gap-5 pb-6">
      {report && <ReportDialog trame={trame} session={report} onClose={() => setReport(null)} />}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Réunions</h1>
          <p className="max-w-xl text-sm text-pretty text-muted-foreground">
            Les transcriptions de tes réunions Teams terminées, enregistrées en <code>.vtt</code> sur ce poste pour un compte-rendu.
            Trame les relit dans sa fenêtre Teams, sans rien y écrire.
          </p>
        </div>
        <FolderButton trame={trame} directory={directory} onChange={setDirectory} onCopy={copyPath} />
      </div>

      <div className={cn("flex flex-col gap-5", selected && "grid grid-cols-[minmax(0,1fr)_24rem] items-start gap-x-8 3xl:grid-cols-[minmax(0,1fr)_28rem]")}>
      <div className="flex min-w-0 flex-col gap-5">
      {meetings && (
        <div className="flex flex-wrap items-center gap-2">
          {searchable && (
            <div className="relative w-full max-w-64">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Filtrer les réunions par titre"
                placeholder="Filtrer par titre"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                className="h-8 rounded-full pr-8 pl-9 text-sm [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Effacer le filtre"
                  onClick={() => setQuery("")}
                  className="absolute top-1/2 right-2 grid size-5 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          )}
          <p className="min-w-0 flex-1 text-xs text-pretty text-muted-foreground tabular-nums" aria-live="polite">
            {plural(meetings.length, "réunion")}
            {savedCount > 0 && ` · ${plural(savedCount, "enregistrée")}`}
            {readAt && ` · lue à ${clock(readAt)}`}
          </p>
          {batch ? (
            <Button variant="secondary" size="sm" className="rounded-full tabular-nums" onClick={() => (stopBatch.current = true)}>
              <Loader2 className="size-4 animate-spin" /> Arrêter · {batch.done}/{batch.total}
            </Button>
          ) : (
            fresh.length > 1 && (
              <Button variant="outline" size="sm" className="rounded-full" onClick={fetchAll} disabled={loading}>
                <Download className="size-4" /> Récupérer les {fresh.length} nouvelles
              </Button>
            )
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Relire la liste dans Teams" onClick={load} disabled={loading || !!batch}>
                <RefreshCw className={cn("size-4", loading && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Relire la liste dans Teams</TooltipContent>
          </Tooltip>
        </div>
      )}

      {error && meetings && (
        <div role="alert" className="flex items-center gap-2 rounded-xl bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">Liste non relue : {error.message}</span>
          <Button variant="ghost" size="sm" className="h-7 rounded-full" onClick={load}>Réessayer</Button>
        </div>
      )}

      {!meetings ? (
        loading ? (
          <LoadingList />
        ) : error ? (
          <ListProblem error={error} onRetry={load} />
        ) : (
          <EmptyCard
            icon={<CalendarClock className="size-5" />}
            title="Tes réunions terminées"
            text="Trame ouvre tour à tour tes conversations de réunion récentes dans sa fenêtre Teams, en lecture seule, pour trouver celles qui ont une transcription."
            action={<Button className="rounded-full" onClick={load}>Chercher mes réunions</Button>}
          />
        )
      ) : meetings.length === 0 ? (
        <EmptyCard
          icon={<SearchX className="size-5" />}
          title="Aucune réunion terminée"
          text="Tes conversations de réunion récentes n'ont pas de récapitulatif. Une réunion apparaît ici une fois terminée."
          action={<Button variant="outline" className="rounded-full" onClick={load} disabled={loading}>Relire la liste</Button>}
        />
      ) : visible.length === 0 ? (
        <EmptyCard
          icon={<SearchX className="size-5" />}
          title={`Aucune réunion pour « ${query.trim()} »`}
          text="Le filtre porte sur le titre de la réunion."
          action={<Button variant="outline" className="rounded-full" onClick={() => setQuery("")}>Tout afficher</Button>}
        />
      ) : (
        <div className="flex flex-col gap-5" aria-busy={loading}>
          {groups.map(({ period, items }) => (
            <section key={period.key} aria-label={period.label}>
              <SectionLabel>{period.label}</SectionLabel>
              <GroupList>
                {items.map((m) => (
                  <MeetingRow
                    key={m.meetingId}
                    meeting={m}
                    relative={period.relative}
                    fetch={fetches[m.meetingId]}
                    saved={savedOf(m)}
                    repeats={counts.get(fold(m.title)) ?? 1}
                    filtered={fold(query) === fold(m.title)}
                    batching={!!batch}
                    onFetch={() => void fetchOne(m)}
                    onOpen={(p) => void openFile(p)}
                    onReveal={(p) => void openFile(p, true)}
                    onCopy={(p) => void copyPath(p)}
                    onSeries={() => setQuery(m.title)}
                    reporting={starting === m.meetingId}
                    onReport={() => void startReport(m)}
                    selected={selected?.meetingId === m.meetingId}
                    onSelect={split ? () => setSelectedId(m.meetingId) : undefined}
                  />
                ))}
              </GroupList>
            </section>
          ))}
        </div>
      )}
      </div>
      {selected && (
        <MeetingDetail
          meeting={selected}
          fetch={fetches[selected.meetingId]}
          saved={savedOf(selected)}
          repeats={counts.get(fold(selected.title)) ?? 1}
          filtered={fold(query) === fold(selected.title)}
          batching={!!batch}
          onFetch={() => void fetchOne(selected)}
          onOpen={(p) => void openFile(p)}
          onReveal={(p) => void openFile(p, true)}
          onCopy={(p) => void copyPath(p)}
          onSeries={() => setQuery(selected.title)}
          reporting={starting === selected.meetingId}
          onReport={() => void startReport(selected)}
        />
      )}
      </div>
    </div>
  );
}

/** Le dossier en version courte ; le chemin complet, le changer, l'ouvrir ou le copier dans la bulle. */
function FolderButton({ trame, directory, onChange, onCopy }: {
  trame: Trame; directory: string; onChange: (d: string) => void; onCopy: (p: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(directory);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setDraft(directory);
      setProblem(null);
    }
  }, [open, directory]);
  const changed = draft.trim() !== "" && draft.trim() !== directory;

  const save = async () => {
    setBusy(true);
    const res = await trame.setTranscriptsFolder(draft.trim());
    setBusy(false);
    if (!res.ok) return setProblem(res.error);
    onChange(res.directory);
    setOpen(false);
    toast.success("Dossier des transcriptions changé", { description: res.directory });
  };
  const reveal = async () => {
    const res = await trame.openTranscriptsFolder(directory || undefined);
    if (!res.ok) setProblem(res.error);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="max-w-full shrink-0 rounded-full text-muted-foreground hover:text-foreground" aria-label={`Dossier des transcriptions : ${directory || "par défaut"}`}>
          <FolderOpen className="size-4" />
          <span className="truncate">{shortPath(directory) || "Documents › Trame › Transcriptions"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[26rem] max-w-[calc(100vw-2rem)]">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (changed) void save();
          }}
        >
          <div>
            <label htmlFor="transcripts-dir" className="text-sm font-medium">Dossier des transcriptions</label>
            <p className="text-xs text-muted-foreground">Chaque .vtt y est enregistré sous la date et le titre de la réunion.</p>
          </div>
          <Input
            id="transcripts-dir"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setProblem(null);
            }}
            spellCheck={false}
            aria-invalid={!!problem}
            className="font-mono text-xs"
          />
          {problem && <p role="alert" className="text-xs text-destructive">{problem}</p>}
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={reveal} disabled={!directory}>
              <FolderOpen className="size-4" /> Ouvrir
            </Button>
            <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={() => onCopy(directory)} disabled={!directory}>
              <Copy className="size-4" /> Copier le chemin
            </Button>
            <div className="flex-1" />
            <Button type="submit" size="sm" className="rounded-full" disabled={!changed || busy}>
              {busy && <Loader2 className="size-4 animate-spin" />} Enregistrer
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

type RowProps = {
  meeting: Meeting;
  relative: boolean;
  fetch?: Fetch;
  saved: { path: string; name: string } | null;
  repeats: number;
  filtered: boolean;
  batching: boolean;
  onFetch: () => void;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
  onCopy: (path: string) => void;
  onSeries: () => void;
  reporting: boolean;
  onReport: () => void;
  /** Fenêtre partagée liste + détail : la ligne se choisit d'un clic. */
  selected?: boolean;
  onSelect?: () => void;
};

type RowState = "none" | "available" | "queued" | "run" | "saved" | "partial" | "denied" | "error";

function rowState(m: Meeting, fetch: Fetch | undefined, saved: RowProps["saved"]): RowState {
  if (!m.transcript) return "none";
  if (fetch?.state === "run" || fetch?.state === "queued") return fetch.state;
  if (fetch?.state === "error") return fetch.kind === "denied" ? "denied" : fetch.kind === "none" ? "none" : "error";
  if (fetch?.state === "ok" && !fetch.saved.complete) return "partial";
  return saved ? "saved" : "available";
}

const STATE_ICON: Record<RowState, { icon: React.ReactNode; label: string }> = {
  none: { icon: <FileX2 className="size-4 text-muted-foreground/70" />, label: "Pas de transcription" },
  available: { icon: <FileText className="size-4 text-muted-foreground" />, label: "Transcription disponible dans Teams" },
  queued: { icon: <Clock className="size-4 text-muted-foreground" />, label: "En attente" },
  run: { icon: <Loader2 className="size-4 animate-spin text-link" />, label: "Lecture dans Teams" },
  saved: { icon: <FileCheck2 className="size-4 text-success" />, label: "Transcription enregistrée sur ce poste" },
  partial: { icon: <FileWarning className="size-4 text-warning" />, label: "Transcription enregistrée, relecture incomplète" },
  denied: { icon: <Lock className="size-4 text-destructive" />, label: "Accès refusé" },
  error: { icon: <AlertTriangle className="size-4 text-destructive" />, label: "Transcription non récupérée" },
};

function MeetingRow({ meeting: m, relative, fetch, saved, repeats, filtered, batching, onFetch, onOpen, onReveal, onCopy, onSeries, reporting, onReport, selected, onSelect }: RowProps) {
  const state = rowState(m, fetch, saved);
  const { start, end } = slotOf(m);
  const duration = durationLabel(durationMinutes(start, end));
  const when = [
    relative ? "" : shortDate(m.date, new Date()) || (m.date ? "" : m.when || "Date inconnue"),
    start && end ? `${start}–${end}` : "",
    duration,
    m.organizer,
  ].filter(Boolean).join(" · ");
  const got = fetch?.state === "ok" ? fetch.saved : null;
  const detail =
    state === "run" ? "Lecture dans Teams…"
    : state === "queued" ? "En attente"
    : state === "partial" ? "Relecture incomplète : la liste n'a pas été lue jusqu'au bout. Réessaie."
    : fetch?.state === "error" && state !== "none" ? fetch.error
    : got ? `${plural(got.cues, "prise de parole", "prises de parole")} · ${plural(got.speakers.length, "intervenant")}`
    : "";
  const tone = state === "denied" || state === "error" ? "text-destructive" : "text-muted-foreground";
  const path = got?.path ?? saved?.path ?? "";
  // Ce qui reste visible au repos : la reprise d'une erreur ; le reste paraît au survol ou au focus.
  const reveal = "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-state=open]]:opacity-100";

  return (
    <div
      data-testid="meeting-row"
      data-state={state}
      aria-busy={state === "run" || undefined}
      className={cn(
        "group relative flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40 focus-within:bg-accent/40",
        selected && "bg-accent/70 hover:bg-accent/70 focus-within:bg-accent/70"
      )}
    >
      {onSelect && (
        // Toute la ligne choisit la réunion ; les boutons de la ligne passent au-dessus.
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={`Détails de ${m.title}`}
          className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
        />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="relative grid size-8 shrink-0 place-items-center rounded-full bg-muted/60" role="img" aria-label={STATE_ICON[state].label}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={state} className="grid place-items-center" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={pop}>
                {STATE_ICON[state].icon}
              </motion.span>
            </AnimatePresence>
          </span>
        </TooltipTrigger>
        <TooltipContent side="left">{STATE_ICON[state].label}</TooltipContent>
      </Tooltip>

      <div className={cn("min-w-0 flex-1", onSelect && "pointer-events-none")}>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-sm font-medium", state === "none" && "text-muted-foreground")}>{m.title}</span>
          {repeats > 1 && !filtered && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onSeries}
                  aria-label={`Réunion récurrente : afficher ses ${repeats} occurrences`}
                  className="pointer-events-auto relative inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <Repeat className="size-3" /> {repeats}
                </button>
              </TooltipTrigger>
              <TooltipContent>Réunion récurrente : afficher ses {repeats} occurrences</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground tabular-nums">{when}</div>
        {detail && (
          <div className={cn("truncate text-xs", tone)} title={detail} role={state === "error" || state === "denied" ? "alert" : undefined}>
            {detail}
          </div>
        )}
      </div>

      <div className="relative flex shrink-0 items-center gap-1">
        {(state === "available" || state === "saved" || state === "partial") && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("rounded-full", !reporting && reveal)}
            onClick={onReport}
            disabled={batching || reporting}
            aria-label={`Compte-rendu de ${m.title}`}
            title="Appliquer le skill de compte-rendu à la transcription (récupérée d'abord si besoin)"
          >
            {reporting ? <Loader2 className="size-4 animate-spin" /> : <NotebookPen className="size-4" />}
            {reporting ? "Préparation…" : "Compte-rendu"}
          </Button>
        )}
        {state === "available" && (
          <Button variant="ghost" size="sm" className={cn("rounded-full", reveal)} onClick={onFetch} disabled={batching} aria-label={`Récupérer la transcription de ${m.title}`}>
            <Download className="size-4" /> Récupérer
          </Button>
        )}
        {state === "error" && (
          <Button variant="ghost" size="sm" className="rounded-full" onClick={onFetch} disabled={batching}>
            <RefreshCw className="size-4" /> Réessayer
          </Button>
        )}
        {(state === "saved" || state === "partial") && path && (
          <>
            <Button variant="ghost" size="sm" className={cn("rounded-full", reveal)} onClick={() => onOpen(path)} aria-label={`Ouvrir la transcription de ${m.title}`}>
              <FileText className="size-4" /> Ouvrir
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className={cn("rounded-full", state !== "partial" && reveal)} aria-label={`Autres actions pour ${m.title}`}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onReveal(path)}>
                  <FolderSearch className="size-4" /> Afficher dans le dossier
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onCopy(path)}>
                  <Copy className="size-4" /> Copier le chemin
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onFetch} disabled={batching}>
                  <RefreshCw className="size-4" /> Récupérer à nouveau
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </div>
  );
}

const longDate = (m: Meeting) => {
  const d = dayOf(m.date);
  return d ? new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d) : m.when || "Date inconnue";
};

/** Fenêtre moyenne ou large : la réunion choisie en entier, titre non tronqué, et ses actions à découvert. */
function MeetingDetail({ meeting: m, fetch, saved, repeats, filtered, batching, onFetch, onOpen, onReveal, onCopy, onSeries, reporting, onReport }: Omit<RowProps, "relative" | "selected" | "onSelect">) {
  const state = rowState(m, fetch, saved);
  const { start, end } = slotOf(m);
  const duration = durationLabel(durationMinutes(start, end));
  const got = fetch?.state === "ok" ? fetch.saved : null;
  const path = got?.path ?? saved?.path ?? "";
  const name = got?.name ?? saved?.name ?? "";
  const reportButton = (variant: "default" | "outline") => (
    <Button variant={variant} size="sm" className="rounded-full" onClick={onReport} disabled={batching || reporting} title="Appliquer le skill de compte-rendu à la transcription (récupérée d'abord si besoin)">
      {reporting ? <Loader2 className="size-4 animate-spin" /> : <NotebookPen className="size-4" />}
      {reporting ? "Préparation…" : "Compte-rendu"}
    </Button>
  );
  const facts: [string, React.ReactNode][] = [
    ["Date", <span className="first-letter:uppercase">{longDate(m)}</span>],
    ...(start && end ? [["Horaire", `${start}–${end}${duration ? ` · ${duration}` : ""}`] as [string, string]] : []),
    ...(m.organizer ? [["Organisation", m.organizer] as [string, string]] : []),
    ...(repeats > 1
      ? [[
          "Série",
          filtered ? (
            plural(repeats, "occurrence")
          ) : (
            <button type="button" onClick={onSeries} className="inline-flex items-center gap-1 font-medium text-link hover:underline">
              <Repeat className="size-3.5" /> {plural(repeats, "occurrence")}
            </button>
          ),
        ] as [string, React.ReactNode]]
      : []),
  ];

  return (
    <aside aria-label="Détails de la réunion" className="sticky top-0 flex flex-col gap-5 rounded-2xl border bg-card p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted/60" aria-hidden>
          {STATE_ICON[state].icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-balance break-words">{m.title}</h2>
          <p className="text-sm text-muted-foreground">{STATE_ICON[state].label}</p>
        </div>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-col gap-3 border-t pt-4">
        <h3 className="text-sm font-medium text-muted-foreground">Transcription</h3>
        {(state === "saved" || state === "partial") && path ? (
          <>
            <div className="flex flex-col gap-1">
              <span className="font-mono text-xs break-all">{name || shortPath(path)}</span>
              {got && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {plural(got.cues, "prise de parole", "prises de parole")} · {plural(got.speakers.length, "intervenant")}
                </span>
              )}
              {state === "partial" && <span className="text-xs text-warning">Relecture incomplète : la liste n'a pas été lue jusqu'au bout. Réessaie.</span>}
            </div>
            {got && got.speakers.length > 0 && (
              <ul className="flex flex-col gap-1.5" aria-label="Intervenants">
                {got.speakers.slice(0, 8).map((s) => (
                  <li key={s} className="flex min-w-0 items-center gap-2 text-sm">
                    <InitialsAvatar name={s} className="size-6 text-[10px]" />
                    <span className="truncate">{s}</span>
                  </li>
                ))}
                {got.speakers.length > 8 && <li className="pl-8 text-xs text-muted-foreground">et {got.speakers.length - 8} autres</li>}
              </ul>
            )}
            <div className="flex flex-wrap gap-1.5">
              {reportButton("default")}
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => onOpen(path)}>
                <FileText className="size-4" /> Ouvrir
              </Button>
            </div>
            <div className="-mt-1 -ml-2.5 flex flex-wrap">
              <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground hover:text-foreground" onClick={() => onReveal(path)}>
                <FolderSearch className="size-4" /> Afficher dans le dossier
              </Button>
              <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground hover:text-foreground" onClick={() => onCopy(path)}>
                <Copy className="size-4" /> Copier le chemin
              </Button>
              <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground hover:text-foreground" onClick={onFetch} disabled={batching}>
                <RefreshCw className="size-4" /> Récupérer à nouveau
              </Button>
            </div>
          </>
        ) : state === "available" ? (
          <>
            <p className="text-sm text-pretty text-muted-foreground">Disponible dans Teams, pas encore enregistrée sur ce poste.</p>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" className="rounded-full" onClick={onFetch} disabled={batching}>
                <Download className="size-4" /> Récupérer la transcription
              </Button>
              {reportButton("outline")}
            </div>
          </>
        ) : state === "run" || state === "queued" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" /> {state === "run" ? "Lecture dans Teams…" : "En attente"}
          </p>
        ) : state === "error" || state === "denied" ? (
          <>
            <p role="alert" className="text-sm text-pretty text-destructive">{fetch?.state === "error" ? fetch.error : STATE_ICON[state].label}</p>
            {state === "error" && (
              <Button variant="outline" size="sm" className="self-start rounded-full" onClick={onFetch} disabled={batching}>
                <RefreshCw className="size-4" /> Réessayer
              </Button>
            )}
          </>
        ) : (
          <p className="text-sm text-pretty text-muted-foreground">Teams n'a pas de transcription pour cette réunion.</p>
        )}
      </div>
    </aside>
  );
}

function EmptyCard({ icon, title, text, action }: { icon: React.ReactNode; title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-10 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">{icon}</span>
      <div className="text-sm font-medium">{title}</div>
      <p className="max-w-md text-sm text-pretty text-muted-foreground">{text}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Le moteur ne lit pas la liste : pilote sans transcriptions, partage d'écran, Teams injoignable. */
function ListProblem({ error, onRetry }: { error: ListError; onRetry: () => void }) {
  if (error.status === 501)
    return (
      <EmptyCard
        icon={<Unplug className="size-5" />}
        title="Réunions indisponibles avec ce mode Teams"
        text={`${error.message} Les transcriptions se lisent avec Teams intégré (Réglages › Avancé).`}
      />
    );
  return (
    <EmptyCard
      icon={<AlertTriangle className="size-5" />}
      title={error.status === 409 ? "Partage d'écran en cours" : "Liste non lue"}
      text={error.message}
      action={<Button variant="outline" className="rounded-full" onClick={onRetry}>Réessayer</Button>}
    />
  );
}

/** Squelette de la liste pendant que Trame parcourt Teams. */
function LoadingList() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <p role="status" className="ml-1 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Trame parcourt tes conversations de réunion dans Teams…
      </p>
      <GroupList aria-hidden="true">
        {[62, 48, 70, 55, 40].map((w, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-2.5">
            <span className="size-8 shrink-0 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3.5 animate-pulse rounded bg-muted" style={{ width: `${w}%` }} />
              <div className="h-3 w-40 animate-pulse rounded bg-muted/70" />
            </div>
          </div>
        ))}
      </GroupList>
    </div>
  );
}

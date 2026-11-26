import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, CalendarClock, Check, FileText, FolderOpen, Loader2, Lock, RefreshCw, SearchX } from "lucide-react";
import { toast } from "sonner";
import { Trame } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GroupList, SectionLabel, spring } from "@/components/kit";
import { cn } from "@/lib/utils";
import { Meeting, SavedTranscript } from "@/types";

type Fetch =
  | { state: "run" }
  | { state: "ok"; saved: SavedTranscript }
  | { state: "error"; error: string; kind: "none" | "denied" | "other" };

/** Le motif d'un refus, pour une icône et un libellé clairs. */
const kindOf = (status?: number): "none" | "denied" | "other" => (status === 404 ? "none" : status === 403 ? "denied" : "other");

/** Réunions Teams terminées et leur transcription, enregistrée en .vtt sur le poste
 *  (lisible par le skill meeting-report). Trame ouvre chaque conversation de réunion dans
 *  sa fenêtre Teams et relit l'onglet « Transcript » : rien n'est écrit dans Teams. */
export function Meetings({ trame }: { trame: Trame }) {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [directory, setDirectory] = useState("");
  const [fetches, setFetches] = useState<Record<string, Fetch>>({});

  const load = async () => {
    setLoading(true);
    setError(null);
    const res = await trame.listMeetings();
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMeetings(res.meetings);
    setDirectory((d) => d || res.directory);
  };

  const fetchOne = async (m: Meeting) => {
    setFetches((f) => ({ ...f, [m.meetingId]: { state: "run" } }));
    const res = await trame.saveTranscript(m, directory.trim() || undefined);
    if (res.ok) {
      setFetches((f) => ({ ...f, [m.meetingId]: { state: "ok", saved: res } }));
      setDirectory(res.directory);
      if (res.organizer) setMeetings((ms) => ms?.map((x) => (x.meetingId === m.meetingId ? { ...x, organizer: res.organizer } : x)) ?? ms);
      toast.success("Transcription enregistrée", { description: res.name });
    } else {
      setFetches((f) => ({ ...f, [m.meetingId]: { state: "error", error: res.error, kind: kindOf(res.status) } }));
    }
  };

  const openFolder = async () => {
    const res = await trame.openTranscriptsFolder(directory.trim() || undefined);
    if (!res.ok) toast.error("Dossier non ouvert", { description: res.error });
    else setDirectory(res.directory);
  };

  const withTranscript = meetings?.filter((m) => m.transcript).length ?? 0;

  return (
    <div className="flex flex-col gap-5 pb-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Réunions</h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            Transcriptions de tes réunions Teams terminées, enregistrées en <code>.vtt</code> sur ce poste : prêtes pour un compte-rendu.
            Trame les relit dans sa fenêtre Teams, sans rien y écrire ni démarrer.
          </p>
        </div>
        <Button variant="outline" size="sm" className="rounded-full" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {meetings ? "Actualiser" : "Chercher mes réunions"}
        </Button>
      </div>

      <div>
        <SectionLabel>Dossier des transcriptions</SectionLabel>
        <div className="flex gap-2">
          <Input
            aria-label="Dossier des transcriptions"
            value={directory}
            placeholder="Documents\Trame\Transcriptions"
            onChange={(e) => setDirectory(e.target.value)}
            className="font-mono text-xs"
          />
          <Button variant="outline" size="sm" onClick={openFolder} className="shrink-0">
            <FolderOpen className="size-4" /> Ouvrir le dossier
          </Button>
        </div>
      </div>

      <div>
        <SectionLabel>
          {meetings ? `${withTranscript} réunion${withTranscript > 1 ? "s" : ""} avec transcription` : "Réunions récentes"}
        </SectionLabel>
        <GroupList aria-busy={loading}>
          {error && (
            <div role="alert" className="flex items-center gap-2 px-4 py-4 text-sm text-destructive">
              <AlertTriangle className="size-4 shrink-0" /> {error}
            </div>
          )}
          {!error && !meetings && (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
              {loading ? <Loader2 className="size-5 animate-spin" /> : <CalendarClock className="size-5" />}
              {loading
                ? "Trame parcourt tes conversations de réunion dans Teams…"
                : "« Chercher mes réunions » ouvre tour à tour tes conversations de réunion récentes dans la fenêtre Teams de Trame."}
            </div>
          )}
          {!error && meetings?.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
              <SearchX className="size-5" /> Aucune réunion terminée dans tes conversations de réunion récentes.
            </div>
          )}
          {meetings?.map((m) => (
            <MeetingRow key={m.meetingId} meeting={m} fetch={fetches[m.meetingId]} onFetch={() => fetchOne(m)} />
          ))}
        </GroupList>
      </div>
    </div>
  );
}

function MeetingRow({ meeting: m, fetch, onFetch }: { meeting: Meeting; fetch?: Fetch; onFetch: () => void }) {
  const busy = fetch?.state === "run";
  return (
    <div className="flex flex-col gap-2 px-4 py-3" data-testid="meeting-row">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{m.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {m.when || m.date || "Date inconnue"}
            {m.organizer && ` · organisée par ${m.organizer}`}
          </div>
        </div>
        {m.transcript ? (
          <Button size="sm" variant={fetch?.state === "ok" ? "outline" : "default"} className="shrink-0 rounded-full" onClick={onFetch} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : fetch?.state === "ok" ? <Check className="size-4" /> : <FileText className="size-4" />}
            {busy ? "Lecture…" : fetch?.state === "ok" ? "Récupérer à nouveau" : "Récupérer le .vtt"}
          </Button>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">Pas de transcription</span>
        )}
      </div>
      <AnimatePresence initial={false}>
        {fetch && fetch.state !== "run" && (
          <motion.div
            key={fetch.state}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring}
            className="overflow-hidden"
          >
            {fetch.state === "ok" ? (
              <div className={cn("rounded-lg px-3 py-2 text-xs", fetch.saved.complete ? "bg-success/10" : "bg-warning/10")}>
                <div className="font-mono break-all">{fetch.saved.path}</div>
                <div className="mt-0.5 text-muted-foreground">
                  {fetch.saved.cues} prise{fetch.saved.cues > 1 ? "s" : ""} de parole · {fetch.saved.speakers.length} intervenant
                  {fetch.saved.speakers.length > 1 ? "s" : ""}
                  {!fetch.saved.complete && " · relecture incomplète : la liste n'a pas pu être lue jusqu'au bout, réessaie"}
                </div>
              </div>
            ) : (
              <div role="alert" className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {fetch.kind === "denied" ? <Lock className="size-3.5 shrink-0" /> : <AlertTriangle className="size-3.5 shrink-0" />}
                {fetch.error}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Ban, Brain, Check, ChevronDown, ChevronRight, Copy, FileText, FolderOpen, Loader2, Lock, Puzzle, Save, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { StepLine } from "@/components/ReflectionPanel";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import type { Trame } from "@/api";
import type { ReflectionRun, ReportSession, ReportTurn } from "@/types";

const VTT_START = "=== Transcription (fichier .vtt, texte complet) ===";
const VTT_END = "=== Fin de la transcription ===";
const VTT_PREVIEW_LINES = 14;

const STATUS: Record<ReportSession["status"], string> = {
  running: "Le cerveau travaille…",
  waiting: "En attente de ta réponse",
  done: "Terminé",
  error: "Échec",
  cancelled: "Arrêté",
};

/**
 * Compte-rendu d'une réunion : le skill appliqué au .vtt, en direct. À gauche l'échange
 * (étapes, réflexion du modèle, questions et réponses), à droite le compte-rendu et le
 * prompt exact envoyé au cerveau. Rien ne part dans Teams.
 */
export function ReportDialog({ trame, session, onClose }: { trame: Trame; session: ReportSession | null; onClose: () => void }) {
  const [s, setS] = useState<ReportSession | null>(session);
  const [tab, setTab] = useState<"report" | "prompt">("report");
  useEffect(() => setS(session), [session?.id]);

  // Suit la session tant qu'elle tourne (la réflexion arrive, elle, par le WebSocket).
  useEffect(() => {
    if (!s || (s.status !== "running" && s.status !== "waiting")) return;
    let live = true;
    const tick = async () => {
      const res = await trame.getReport(s.id);
      if (live && res.ok) setS((old) => (old && res.report.rev < old.rev ? old : res.report));
    };
    const timer = setInterval(tick, s.status === "running" ? 400 : 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.id, s?.status]);

  if (!s) return null;
  const busy = s.status === "running";
  const stop = async () => {
    const res = await trame.cancelReport(s.id);
    if (res.ok) setS(res.report);
    else toast.error("Impossible d'arrêter", { description: res.error });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="report-dialog" className="flex h-[88vh] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
        <header className="flex items-start gap-3 border-b px-6 py-4 pr-12">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-secondary">
            <FileText className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base">Compte-rendu · {s.title}</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className="inline-flex items-center gap-1">
                <Puzzle className="size-3" /> <span className="font-mono">{s.skill}</span>
              </span>
              <span>· {s.provider}{s.model ? ` (${s.model})` : ""}</span>
              <span>· {s.cues} prises de parole</span>
              <span className={cn("font-medium", s.status === "error" && "text-destructive", s.status === "waiting" && "text-link")}>
                · {STATUS[s.status]}
              </span>
            </DialogDescription>
          </div>
          {(busy || s.status === "waiting") && (
            <Button variant="outline" size="sm" className="rounded-full" onClick={stop}>
              <Ban className="size-4" /> Arrêter
            </Button>
          )}
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <Exchange trame={trame} s={s} onChange={setS} />
          <section className="flex min-h-0 flex-col border-l">
            <div role="tablist" className="flex gap-1 border-b px-4 pt-2">
              {(["report", "prompt"] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  type="button"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                    tab === t ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t === "report" ? "Compte-rendu" : "Prompt envoyé"}
                </button>
              ))}
            </div>
            {tab === "report" ? <ReportPane trame={trame} s={s} onChange={setS} /> : <PromptPane s={s} />}
          </section>
        </div>

        <footer className="flex items-center gap-1.5 border-t px-6 py-2.5 text-xs text-muted-foreground">
          <Lock className="size-3" /> Rien n'est publié dans Teams. Aucun script du skill n'est exécuté : ce qu'il propose de faire ailleurs
          (issues, dépôt) reste du texte à copier.
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function Exchange({ trame, s, onChange }: { trame: Trame; s: ReportSession; onChange: (s: ReportSession) => void }) {
  const end = useRef<HTMLDivElement>(null);
  const runs = useMemo(() => new Map(trame.reflections.map((r) => [r.id, r])), [trame.reflections]);
  const assistantRuns = new Set(s.turns.map((t) => t.runId));
  const pending = s.status === "running" && s.runId && !assistantRuns.has(s.runId) ? runs.get(s.runId) : undefined;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [s.turns.length, pending?.rev, s.status]);
  const last = s.turns[s.turns.length - 1];

  return (
    <section className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <ol className="flex flex-col gap-4" aria-label="Échange">
          {s.turns.map((t, i) => (
            <li key={i}>{t.role === "user" ? <UserTurn turn={t} /> : <AssistantTurn turn={t} run={runs.get(t.runId)} />}</li>
          ))}
          {pending && (
            <li>
              <RunSteps run={pending} live />
            </li>
          )}
          {s.status === "running" && !pending && (
            <li className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Préparation…
            </li>
          )}
          {s.status === "error" && (
            <li role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {s.error}
            </li>
          )}
          {s.status === "cancelled" && <li className="text-sm text-muted-foreground">Compte-rendu arrêté.</li>}
        </ol>
        <div ref={end} />
      </div>
      {s.status === "waiting" && last?.role === "assistant" && last.question && (
        <AnswerBox trame={trame} s={s} turn={last} onChange={onChange} />
      )}
    </section>
  );
}

function RunSteps({ run, live = false }: { run: ReflectionRun; live?: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => setOpen(live), [live]);
  return (
    <div className="flex flex-col gap-2" data-testid="report-run">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <Brain className="size-3.5" /> Réflexion et étapes
        {live && <Loader2 className="size-3 animate-spin" />}
      </button>
      {open && (
        <ol className="flex flex-col gap-2 border-l pl-3">
          {run.steps.map((step, i) => (
            <li key={i}>
              <StepLine step={step} live={live && i === run.steps.length - 1} />
            </li>
          ))}
          {!live && !run.reasoning && (
            <li className="text-xs text-muted-foreground">Ce cerveau ne transmet pas le texte de sa réflexion : seules les étapes sont affichées.</li>
          )}
        </ol>
      )}
    </div>
  );
}

function AssistantTurn({ turn, run }: { turn: ReportTurn; run?: ReflectionRun }) {
  return (
    <div className="flex flex-col gap-2">
      {run && <RunSteps run={run} />}
      {turn.text && <p className="text-sm leading-relaxed whitespace-pre-wrap">{turn.text}</p>}
      {turn.report && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="size-3.5" /> Compte-rendu {turn.report.length.toLocaleString("fr-FR")} caractères (onglet de droite)
        </p>
      )}
      {turn.question && (
        <div data-testid="report-question" className="rounded-xl border border-link/40 bg-link/5 px-3 py-2 text-sm">
          <span className="text-xs font-medium text-link">Question</span>
          <p className="mt-0.5 whitespace-pre-wrap">{turn.question}</p>
        </div>
      )}
    </div>
  );
}

function UserTurn({ turn }: { turn: ReportTurn }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-2xl bg-secondary px-3 py-2 text-sm whitespace-pre-wrap">{turn.text}</p>
    </div>
  );
}

function AnswerBox({ trame, s, turn, onChange }: { trame: Trame; s: ReportSession; turn: ReportTurn; onChange: (s: ReportSession) => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async (value: string) => {
    if (!value.trim()) return;
    setSending(true);
    const res = await trame.answerReport(s.id, value.trim());
    setSending(false);
    if (!res.ok) return toast.error("Réponse non transmise", { description: res.error });
    setText("");
    onChange(res.report);
  };
  return (
    <form
      className="flex flex-col gap-2 border-t px-6 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        void send(text);
      }}
    >
      {!!turn.options.length && (
        <div className="flex flex-wrap gap-2">
          {turn.options.map((o) => (
            <Button key={o} type="button" size="sm" variant="outline" className="rounded-full" disabled={sending} onClick={() => send(o)}>
              {o}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Ta réponse"
          placeholder={turn.options.length ? "Ou écris ta réponse…" : "Ta réponse…"}
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
          className="min-h-0 flex-1 resize-none"
        />
        <Button type="submit" size="sm" className="rounded-full" disabled={sending || !text.trim()}>
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          Répondre
        </Button>
      </div>
    </form>
  );
}

function ReportPane({ trame, s, onChange }: { trame: Trame; s: ReportSession; onChange: (s: ReportSession) => void }) {
  const [saving, setSaving] = useState(false);
  if (!s.report) {
    return (
      <div className="grid flex-1 place-items-center px-8 text-center text-sm text-muted-foreground">
        {s.status === "running" ? (
          <span className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Le compte-rendu s'affichera ici.
          </span>
        ) : (
          "Pas encore de compte-rendu."
        )}
      </div>
    );
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(s.report);
      toast.success("Compte-rendu copié");
    } catch {
      toast.error("Copie impossible");
    }
  };
  const save = async () => {
    setSaving(true);
    const res = await trame.saveReport(s.id);
    setSaving(false);
    if (!res.ok) return toast.error("Non enregistré", { description: res.error });
    onChange(res.report);
    toast.success("Compte-rendu enregistré", { description: res.report.savedPath });
  };
  const open = async () => {
    const res = await trame.openReportFolder(s.id);
    if (!res.ok) toast.error("Dossier non ouvert", { description: res.error });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button size="sm" variant="outline" className="rounded-full" onClick={copy}>
          <Copy className="size-4" /> Copier
        </Button>
        <Button size="sm" variant="outline" className="rounded-full" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Enregistrer (.md)
        </Button>
        <Button size="sm" variant="ghost" className="rounded-full" onClick={open}>
          <FolderOpen className="size-4" /> Ouvrir le dossier
        </Button>
        {s.savedPath && <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-muted-foreground" title={s.savedPath}>{s.savedPath}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 text-sm" data-testid="report-markdown">
        <Markdown text={s.report} />
      </div>
    </div>
  );
}

function PromptPane({ s }: { s: ReportSession }) {
  const sent = s.turns.filter((t) => t.role === "assistant" && t.prompt);
  const options = [...sent.map((t, i) => ({ label: `Tour ${i + 1}`, prompt: t.prompt })), ...(s.pendingPrompt ? [{ label: `Tour ${sent.length + 1} (en cours)`, prompt: s.pendingPrompt }] : [])];
  const [pick, setPick] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const index = pick ?? options.length - 1;
  const current = options[index];
  if (!current) return <div className="grid flex-1 place-items-center text-sm text-muted-foreground">Le prompt s'affichera ici dès son envoi.</div>;

  const [before, rest = ""] = current.prompt.split(VTT_START);
  const [vtt = "", after = ""] = rest.split(VTT_END);
  const vttLines = vtt.replace(/^\n|\n$/g, "").split("\n");
  const hidden = Math.max(0, vttLines.length - VTT_PREVIEW_LINES);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(current.prompt);
      toast.success("Prompt copié", { description: `${current.prompt.length.toLocaleString("fr-FR")} caractères` });
    } catch {
      toast.error("Copie impossible");
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        {options.map((o, i) => (
          <button
            key={o.label}
            type="button"
            onClick={() => setPick(i)}
            className={cn("rounded-full px-2.5 py-1 text-xs", i === index ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-accent")}
          >
            {o.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">{current.prompt.length.toLocaleString("fr-FR")} caractères</span>
        <Button size="sm" variant="outline" className="rounded-full" onClick={copy}>
          <Copy className="size-4" /> Copier le prompt
        </Button>
      </div>
      <pre data-testid="report-prompt" className="min-h-0 flex-1 overflow-auto px-6 py-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
        {before}
        {rest && (
          <>
            {VTT_START}
            {"\n"}
            {full ? vttLines.join("\n") : vttLines.slice(0, VTT_PREVIEW_LINES).join("\n")}
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setFull((f) => !f)}
                className="my-1 block rounded-md bg-muted px-2 py-1 font-sans text-xs text-link"
              >
                {full
                  ? "Replier la transcription"
                  : `… ${hidden.toLocaleString("fr-FR")} ligne${hidden > 1 ? "s" : ""} masquée${hidden > 1 ? "s" : ""} ici : le texte complet est bien envoyé. Tout afficher`}
              </button>
            )}
            {"\n"}
            {VTT_END}
            {after}
          </>
        )}
      </pre>
    </div>
  );
}

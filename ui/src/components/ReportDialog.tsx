import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Ban, Brain, Check, ChevronDown, ChevronRight, Copy, ExternalLink, FileText, FolderOpen, GitPullRequest, Loader2, Lock, Puzzle, Save, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { StepLine } from "@/components/ReflectionPanel";
import { GithubLogo } from "@/brands";
import { openExternal } from "@/desktop";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import type { Trame } from "@/api";
import type { PublishPlan, PublishedRef, ReflectionRun, ReportSession, ReportTurn } from "@/types";

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
  const [publishOpen, setPublishOpen] = useState(false);
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
        {s.published ? (
          <Button
            size="sm"
            variant="outline"
            className="rounded-full border-success/40 text-success hover:text-success"
            onClick={() => void openExternal(s.published!.url)}
            data-testid="report-open-pr"
          >
            <GitPullRequest className="size-4" /> Pull request #{s.published.number} <ExternalLink className="size-3.5" />
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="rounded-full" onClick={() => setPublishOpen(true)} data-testid="report-publish">
            <GithubLogo className="size-4" /> Publier sur GitHub
          </Button>
        )}
        {s.savedPath && <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-muted-foreground" title={s.savedPath}>{s.savedPath}</span>}
      </div>
      {s.published && (
        <div className="flex items-center gap-2 border-b bg-success/5 px-4 py-2 text-xs text-muted-foreground">
          <Check className="size-3.5 shrink-0 text-success" />
          <span className="min-w-0 flex-1 truncate">
            Publié sur <span className="font-medium">{s.published.repo}</span> · <span className="font-mono">{s.published.path}</span>
            {s.published.draft ? " · brouillon" : ""}
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 text-sm" data-testid="report-markdown">
        <Markdown text={s.report} />
      </div>
      {publishOpen && <PublishDialog trame={trame} s={s} onPublished={onChange} onClose={() => setPublishOpen(false)} />}
    </div>
  );
}

/**
 * Publier le compte-rendu sur GitHub : ouvrir une pull request (brouillon par défaut) qui
 * ajoute le fichier Markdown au dépôt lié à la réunion. L'utilisateur voit le dépôt cible,
 * la branche, le chemin et un aperçu, puis confirme. Jamais de publication automatique,
 * jamais de push sur la branche protégée, jamais d'écrasement, jamais de fusion.
 */
function PublishDialog({ trame, s, onPublished, onClose }: { trame: Trame; s: ReportSession; onPublished: (s: ReportSession) => void; onClose: () => void }) {
  const [plan, setPlan] = useState<PublishPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [draft, setDraft] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<PublishedRef | null>(null);

  useEffect(() => {
    let live = true;
    void trame.githubPublishPlan(s.id).then((res) => {
      if (!live) return;
      if (!res.ok) return setLoadError(res.error);
      setPlan(res.plan);
      setRepo(res.plan.repo ?? res.plan.repos[0] ?? "");
      setDraft(res.plan.draft);
    });
    return () => {
      live = false;
    };
  }, [trame, s.id]);

  // L'état « déjà présent » est calculé pour le dépôt déduit : on ne l'affiche que si le dépôt choisi est bien celui-là.
  const state = plan && plan.state && repo === plan.repo ? plan.state : null;
  const alreadyThere = Boolean(state?.exists);
  const canPublish = Boolean(plan && !plan.blocked && repo && !alreadyThere && !publishing);

  const publish = async () => {
    if (!repo) return;
    setPublishing(true);
    const res = await trame.githubPublish(s.id, repo, { path: plan?.path, draft });
    setPublishing(false);
    if (!res.ok) return toast.error("Publication impossible", { description: res.error });
    setResult(res.published);
    onPublished(res.report);
    toast.success("Pull request ouverte", { description: `${res.published.repo} #${res.published.number}` });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg gap-0 p-0" data-testid="publish-dialog">
        <header className="flex items-start gap-3 border-b px-5 py-4 pr-12">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-secondary">
            <GithubLogo className="size-4.5" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-base">Publier sur GitHub</DialogTitle>
            <DialogDescription className="text-xs">Ouvre une pull request brouillon qui ajoute le compte-rendu au dépôt lié. Rien n'est fusionné.</DialogDescription>
          </div>
        </header>

        {result ? (
          <div className="flex flex-col gap-4 px-5 py-6">
            <div className="flex items-center gap-2 text-sm">
              <Check className="size-4 text-success" /> Pull request ouverte{result.draft ? " (brouillon)" : ""}.
            </div>
            <div className="rounded-xl border bg-muted/40 px-3 py-2 text-sm">
              <div className="truncate font-medium">{result.repo} · #{result.number}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">{result.path}</div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => void openExternal(result.url)}>
                <ExternalLink className="size-4" /> Ouvrir la pull request
              </Button>
              <Button size="sm" className="rounded-full" onClick={onClose}>Fermer</Button>
            </div>
          </div>
        ) : loadError ? (
          <div className="flex flex-col gap-4 px-5 py-6">
            <p role="alert" className="text-sm text-destructive">{loadError}</p>
            <div className="flex justify-end">
              <Button size="sm" variant="outline" className="rounded-full" onClick={onClose}>Fermer</Button>
            </div>
          </div>
        ) : !plan ? (
          <div className="grid place-items-center px-5 py-10 text-sm text-muted-foreground">
            <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Préparation…</span>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-4 px-5 py-4">
              {plan.blocked && (
                <div role="alert" className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  <span>{plan.blocked}</span>
                </div>
              )}

              <Field label="Dépôt">
                {plan.repos.length === 0 && !plan.repo ? (
                  <span className="text-sm text-muted-foreground">Aucun dépôt autorisé. Ajoute-en un dans Réglages › GitHub.</span>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="rounded-full font-mono" disabled={publishing}>
                          {repo || "Choisir un dépôt"} <ChevronDown className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="max-h-64 overflow-auto">
                        {Array.from(new Set([...(plan.repo ? [plan.repo] : []), ...plan.repos])).map((r) => (
                          <DropdownMenuItem key={r} onSelect={() => setRepo(r)} className="font-mono text-xs">
                            {r === repo && <Check className="size-3.5" />} {r}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {repo && repo === plan.repo && !plan.repoConfident && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] text-warning-foreground">
                        <AlertTriangle className="size-3 text-warning" /> déduit — à confirmer
                      </span>
                    )}
                  </div>
                )}
                {plan.repoReason && repo === plan.repo && <p className="text-xs text-muted-foreground">{plan.repoReason}.</p>}
              </Field>

              {alreadyThere ? (
                <div role="alert" className="flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0">
                    Un compte-rendu est déjà présent sur ce dépôt — rien n'est écrasé.
                    {state?.url && (
                      <button type="button" className="ml-1 underline" onClick={() => void openExternal(state.url!)}>Le voir</button>
                    )}
                  </span>
                </div>
              ) : state?.prUrl ? (
                <div className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
                  <GitPullRequest className="mt-0.5 size-4 shrink-0 text-warning" />
                  <span className="min-w-0">
                    Une pull request ouvre déjà ce compte-rendu (#{state.prNumber}).
                    <button type="button" className="ml-1 underline" onClick={() => void openExternal(state.prUrl!)}>L'ouvrir</button>
                  </span>
                </div>
              ) : null}

              <Field label="Branche"><span className="font-mono text-sm break-all">{plan.branch}</span></Field>
              <Field label="Fichier"><span className="font-mono text-sm break-all">{plan.path}</span></Field>

              <label className="flex items-center justify-between gap-3">
                <span className="text-sm">Ouvrir en brouillon (draft)</span>
                <Switch checked={draft} onCheckedChange={setDraft} disabled={publishing} />
              </label>

              <details className="rounded-xl border">
                <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground">Aperçu du compte-rendu</summary>
                <div className="max-h-56 overflow-auto border-t px-4 py-3 text-sm">
                  <Markdown text={s.report} />
                </div>
              </details>
            </div>

            <footer className="flex items-center justify-between gap-2 border-t px-5 py-3">
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Lock className="size-3" /> Branche + fichier + PR. Jamais sur {plan.base || "la branche par défaut"}, jamais de fusion.
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" className="rounded-full" onClick={onClose} disabled={publishing}>Annuler</Button>
                <Button size="sm" className="rounded-full" onClick={publish} disabled={!canPublish} data-testid="publish-confirm">
                  {publishing ? <Loader2 className="size-4 animate-spin" /> : <GitPullRequest className="size-4" />}
                  Créer la pull request
                </Button>
              </div>
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
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

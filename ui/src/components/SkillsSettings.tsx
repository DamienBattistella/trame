import { useEffect, useId, useState } from "react";
import { AlertTriangle, FileCode2, FolderOpen, GitBranch, Loader2, Puzzle, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { GroupList, SectionLabel } from "@/components/kit";
import { cn } from "@/lib/utils";
import type { Result, Trame } from "@/api";
import type { SkillInfo, SkillsSummary } from "@/types";

type Call = Promise<Result<{ summary: SkillsSummary }>>;

/** Réglages › Skills : les skills d'agent que Trame propose au cerveau quand il rédige. */
export function SkillsSettings({ trame }: { trame: Trame }) {
  const [summary, setSummary] = useState<SkillsSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (key: string, call: () => Call, done?: string) => {
    setBusy(key);
    const res = await call();
    setBusy(null);
    if (!res.ok) {
      toast.error("Skills", { description: res.error });
      return false;
    }
    setSummary(res.summary);
    setError(null);
    if (done) toast.success(done);
    return true;
  };

  useEffect(() => {
    let live = true;
    trame.getSkills().then((res) => {
      if (!live) return;
      if (res.ok) setSummary(res.summary);
      else setError(res.error);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trame.connected]);

  if (!summary) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        {error ?? (
          <>
            <Loader2 className="size-4 animate-spin" /> Lecture des skills…
          </>
        )}
      </p>
    );
  }
  const active = summary.skills.filter((s) => s.enabled).length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-end justify-between gap-3">
          <SectionLabel>
            {summary.skills.length} skill{summary.skills.length > 1 ? "s" : ""} · {active} actif{active > 1 ? "s" : ""}
          </SectionLabel>
          <Button
            variant="ghost"
            size="sm"
            className="mb-1.5 rounded-full"
            disabled={busy !== null}
            onClick={() => run("reload", trame.reloadSkills, "Skills rechargés")}
          >
            {busy === "reload" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Recharger
          </Button>
        </div>
        {summary.skills.length ? (
          <GroupList data-testid="skills-list">
            {summary.skills.map((s) => (
              <SkillRow
                key={s.name}
                skill={s}
                busy={busy === `skill:${s.name}`}
                onToggle={(enabled) => run(`skill:${s.name}`, () => trame.setSkillEnabled(s.name, enabled))}
              />
            ))}
          </GroupList>
        ) : (
          <GroupList className="px-4 py-3 text-sm text-muted-foreground">
            Aucun skill trouvé. Dépose un dossier contenant un SKILL.md dans {summary.ownDir}, ou ajoute un dossier ci-dessous.
          </GroupList>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Le cerveau voit le nom et la description des skills actifs, et ne lit le texte d'un skill que si la tâche le demande (visible dans le
          panneau Réflexion). Un skill guide la rédaction : il ne lève aucun garde-fou de Trame, et{" "}
          <strong className="font-medium text-foreground">ses scripts ne sont jamais exécutés</strong>. Les skills des dossiers partagés et des
          dépôts sont désactivés tant que tu ne les actives pas.
        </p>
      </div>

      {!!summary.ignored.length && (
        <div>
          <SectionLabel>Ignorés</SectionLabel>
          <GroupList data-testid="skills-ignored">
            {summary.ignored.map((i) => (
              <div key={`${i.source}/${i.folder}`} className="flex items-start gap-2 px-4 py-2.5 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="font-mono">{i.folder}</span> <span className="text-muted-foreground">· {i.source} — {i.reason}</span>
                </span>
              </div>
            ))}
          </GroupList>
        </div>
      )}

      <SourcesEditor summary={summary} busy={busy} run={run} trame={trame} />
    </div>
  );
}

function SkillRow({ skill, busy, onToggle }: { skill: SkillInfo; busy: boolean; onToggle: (v: boolean) => void }) {
  const id = useId();
  return (
    <div data-testid={`skill-${skill.name}`} className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
        <Puzzle className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor={id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-mono text-sm font-medium">{skill.name}</span>
          {skill.version && <span className="text-xs text-muted-foreground">v{skill.version}</span>}
          <span className="max-w-[18rem] truncate text-xs text-muted-foreground" title={skill.source}>
            · {skill.source}
          </span>
        </label>
        <p className="line-clamp-3 text-xs text-muted-foreground" title={skill.description}>
          {skill.description}
        </p>
        {skill.hasScripts && (
          <p
            data-testid="skill-scripts"
            className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400"
            title={skill.scripts.join("\n")}
          >
            <FileCode2 className="size-3.5 shrink-0" />
            Contient {skill.scripts.length} script{skill.scripts.length > 1 ? "s" : ""} : jamais exécuté{skill.scripts.length > 1 ? "s" : ""} par Trame,
            seul le texte compte.
          </p>
        )}
      </div>
      {busy ? (
        <Loader2 className="mt-1 size-4 animate-spin text-muted-foreground" />
      ) : (
        <Switch id={id} aria-label={`Activer ${skill.name}`} checked={skill.enabled} onCheckedChange={onToggle} />
      )}
    </div>
  );
}

function SourcesEditor({
  summary,
  busy,
  run,
  trame,
}: {
  summary: SkillsSummary;
  busy: string | null;
  run: (key: string, call: () => Call, done?: string) => Promise<boolean>;
  trame: Trame;
}) {
  const [dirs, setDirs] = useState(summary.dirs.join("\n"));
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  useEffect(() => setDirs(summary.dirs.join("\n")), [summary.dirs.join("\n")]);
  const dirty = dirs.trim() !== summary.dirs.join("\n").trim();

  return (
    <>
      <div>
        <SectionLabel>Dossiers</SectionLabel>
        <GroupList>
          {summary.sources
            .filter((s) => !s.label.startsWith("git "))
            .map((s) => (
              <div key={s.label + s.path} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={s.path}>
                  {s.path}
                </span>
                <span className={cn("shrink-0 text-xs", s.exists ? "text-muted-foreground" : "text-destructive")}>
                  {s.label === "Trame" ? "dossier de Trame · actifs d'office" : s.exists ? "partagé" : "introuvable"}
                </span>
              </div>
            ))}
          <div className="flex flex-col gap-2 px-4 py-3">
            <span className="text-xs text-muted-foreground">Dossiers partagés, un par ligne (~ et %VARIABLES% acceptés) :</span>
            <Textarea
              aria-label="Dossiers de skills"
              value={dirs}
              rows={2}
              onChange={(e) => setDirs(e.target.value)}
              className="font-mono text-xs"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                className="rounded-full"
                disabled={!dirty || busy !== null}
                onClick={() => run("dirs", () => trame.setSkillDirs(dirs.split("\n").map((d) => d.trim()).filter(Boolean)), "Dossiers enregistrés")}
              >
                {busy === "dirs" && <Loader2 className="size-4 animate-spin" />}
                Enregistrer
              </Button>
            </div>
          </div>
        </GroupList>
      </div>

      <div>
        <SectionLabel>Dépôts git</SectionLabel>
        <GroupList>
          {summary.repos.map((r) => (
            <div key={r.url + r.branch} className="flex items-center gap-2 px-4 py-2.5 text-sm">
              <GitBranch className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={r.url}>
                {r.url} <span className="text-muted-foreground">· {r.branch || "branche par défaut"}</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="rounded-full"
                disabled={busy !== null}
                onClick={() => run(`repo:${r.url}`, () => trame.syncSkillRepo(r.url, r.branch), "Dépôt mis à jour")}
              >
                {busy === `repo:${r.url}` ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Mettre à jour
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-8 rounded-full"
                aria-label="Retirer le dépôt"
                disabled={busy !== null}
                onClick={() => run(`rm:${r.url}`, () => trame.removeSkillRepo(r.url, r.branch), "Dépôt retiré")}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <form
            className="flex flex-wrap items-center gap-2 px-4 py-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run("install", () => trame.syncSkillRepo(url.trim(), branch.trim()), "Dépôt installé")) setUrl("");
            }}
          >
            <Input
              aria-label="URL du dépôt git"
              placeholder="https://github.com/organisation/skills.git"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="h-8 min-w-0 flex-1 font-mono text-xs"
            />
            <Input aria-label="Branche" value={branch} onChange={(e) => setBranch(e.target.value)} className="h-8 w-28 font-mono text-xs" />
            <Button size="sm" className="rounded-full" type="submit" disabled={!url.trim() || busy !== null}>
              {busy === "install" && <Loader2 className="size-4 animate-spin" />}
              Installer
            </Button>
          </form>
          <p className="px-4 pb-3 text-xs text-muted-foreground">
            Clone superficiel en https avec ton accès git habituel, dans le dossier de données de Trame. Rien du dépôt n'est exécuté ; le dossier
            skills/ du dépôt est lu s'il existe.
          </p>
        </GroupList>
      </div>
    </>
  );
}

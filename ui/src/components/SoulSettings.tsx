import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Brain,
  Eraser,
  FileText,
  History,
  Loader2,
  PenLine,
  RotateCcw,
  Sparkle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { GroupList, SectionLabel, Segment } from "@/components/kit";
import { SoulInsight } from "@/components/SoulInsight";
import { analyzeSoul, Quality } from "@/lib/soulInsight";
import {
  diffLines,
  foldDiff,
  SoulDetails,
  SoulSection,
  SoulSignal,
  SoulSource,
  SoulVersion,
} from "@/lib/persona";
import { cn } from "@/lib/utils";
import { Trame } from "@/api";

type View = "read" | "edit" | "history";
const VIEWS = [
  { value: "read", label: "Lecture" },
  { value: "edit", label: "Éditer" },
  { value: "history", label: "Historique" },
] as const;
const EVERY = [
  { value: "5", label: "5" },
  { value: "8", label: "8" },
  { value: "15", label: "15" },
] as const;

const QUALITY: Record<Quality, { label: string; className: string }> = {
  complet: { label: "Complet", className: "bg-success/15 text-success" },
  correct: { label: "Correct", className: "bg-link/10 text-link" },
  "a-completer": {
    label: "À compléter",
    className: "bg-warning/15 text-warning",
  },
};
const SOURCE: Record<SoulSource, { label: string; className: string }> = {
  initial: { label: "Départ", className: "bg-muted text-muted-foreground" },
  manuel: { label: "Édité", className: "bg-link/10 text-link" },
  appris: { label: "Appris", className: "bg-primary/15 text-primary" },
  restauré: { label: "Restauré", className: "bg-warning/15 text-warning" },
  assistant: {
    label: "Assistant",
    className: "bg-muted text-muted-foreground",
  },
};
const KIND: Record<SoulSignal["kind"], string> = {
  corrigé: "Corrigé",
  accepté: "Validé tel quel",
  rejeté: "Écarté",
  écrit: "Écrit par toi",
};

const when = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("fr-FR", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
};

/** Réglages › Persona : le SOUL.md lu par Trame, éditable, versionné, et ce qu'il apprend de tes réponses. */
export function SoulSettings({ trame }: { trame: Trame }) {
  const [details, setDetails] = useState<SoulDetails | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("read");

  const load = async () => {
    const res = await trame.getSoulDetails();
    if (res.ok) {
      setDetails(res.details);
      setError("");
    } else setError(res.error);
  };
  useEffect(() => {
    load();
  }, [trame.connected]);

  if (!details)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {error || (
          <>
            <Loader2 className="size-4 animate-spin" /> Lecture du SOUL.md…
          </>
        )}
      </div>
    );

  return (
    <div className="flex flex-col gap-6">
      <Overview details={details} view={view} onView={setView} />
      {view === "read" && (
        <>
          <Sections sections={details.sections} />
          <LearningCard trame={trame} details={details} onChange={setDetails} />
        </>
      )}
      {view === "edit" && (
        <Editor
          trame={trame}
          initial={details.content}
          onSaved={async () => {
            await load();
            setView("read");
          }}
          onCancel={() => setView("read")}
        />
      )}
      {view === "history" && (
        <VersionHistory trame={trame} details={details} onChange={setDetails} />
      )}
    </div>
  );
}

function Overview({
  details,
  view,
  onView,
}: {
  details: SoulDetails;
  view: View;
  onView: (v: View) => void;
}) {
  const { score, quality, aspects } = useMemo(
    () => analyzeSoul(details.content),
    [details.content],
  );
  const q = QUALITY[quality];
  const rules = details.sections.reduce((n, s) => n + s.rules, 0);
  const examples = details.sections.reduce((n, s) => n + s.examples, 0);
  const learned = details.sections.find((s) => s.learned)?.rules ?? 0;
  return (
    <GroupList>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <FileText className="size-4 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {details.title || "SOUL.md"}
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {details.sections.length} sections · {rules} consignes · {examples}{" "}
            exemples
            {learned > 0 && ` · ${learned} apprises`}
            {!details.custom && " · persona livré par défaut"}
          </div>
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums",
            q.className,
          )}
        >
          {q.label} · {score}/{aspects.length}
        </span>
        <div className="ml-auto">
          <Segment<View>
            label="Affichage du persona"
            value={view}
            onChange={onView}
            options={VIEWS}
          />
        </div>
      </div>
    </GroupList>
  );
}

/** **gras** du Markdown, sans interpréter le reste. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(\*\*[^*]+\*\*)/)
        .map((part, i) =>
          /^\*\*[^*]+\*\*$/.test(part) ? (
            <strong key={i}>{part.slice(2, -2)}</strong>
          ) : (
            part
          ),
        )}
    </>
  );
}

type Block = { kind: "rule" | "quote" | "note" | "text"; text: string };

/** Puces, citations et paragraphes ; une ligne coupée à la main continue le bloc précédent. */
function blocks(body: string): Block[] {
  const out: Block[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) {
      out.push({ kind: "text", text: "" });
      continue;
    }
    const prev = out[out.length - 1];
    if (/^[-*+]\s+/.test(line))
      out.push({ kind: "rule", text: line.replace(/^[-*+]\s+/, "") });
    else if (line.startsWith(">"))
      out.push({ kind: "quote", text: line.replace(/^>\s?/, "") });
    else if (/^_.*_$/.test(line))
      out.push({ kind: "note", text: line.slice(1, -1) });
    else if (prev && prev.text && prev.kind !== "note") prev.text += " " + line;
    else out.push({ kind: "text", text: line });
  }
  return out.filter((b) => b.text);
}

function Body({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      {blocks(text).map((b, i) =>
        b.kind === "rule" ? (
          <div key={i} className="flex gap-2">
            <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60" />
            <span>
              <Inline text={b.text} />
            </span>
          </div>
        ) : b.kind === "quote" ? (
          <div
            key={i}
            className="border-l-2 border-primary/40 pl-3 text-muted-foreground italic"
          >
            {b.text}
          </div>
        ) : b.kind === "note" ? (
          <div key={i} className="text-xs text-muted-foreground">
            {b.text}
          </div>
        ) : (
          <p key={i}>
            <Inline text={b.text} />
          </p>
        ),
      )}
    </div>
  );
}

function Sections({ sections }: { sections: SoulSection[] }) {
  return (
    <div>
      <SectionLabel>Ce que Trame lit</SectionLabel>
      <div className="grid gap-3 lg:grid-cols-2">
        {sections.map((s, i) => (
          <motion.div
            key={`${s.heading}-${i}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.03 * i }}
            className={cn(
              "rounded-2xl border bg-card px-4 py-3",
              s.learned && "border-primary/40 bg-primary/5 lg:col-span-2",
            )}
          >
            <div className="mb-2 flex items-center gap-2">
              {s.learned && <Sparkle className="size-3.5 text-primary" />}
              <span className="text-sm font-medium">
                {s.heading || "Introduction"}
              </span>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {[
                  s.rules && `${s.rules} consigne${s.rules > 1 ? "s" : ""}`,
                  s.examples &&
                    `${s.examples} exemple${s.examples > 1 ? "s" : ""}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {s.body ? (
              <Body text={s.body} />
            ) : (
              <span className="text-sm text-muted-foreground">Vide</span>
            )}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function LearningCard({
  trame,
  details,
  onChange,
}: {
  trame: Trame;
  details: SoulDetails;
  onChange: (d: SoulDetails) => void;
}) {
  const l = details.learning;
  const [busy, setBusy] = useState<"" | "learn" | "forget" | "set">("");
  const act = async (
    kind: "learn" | "forget" | "set",
    run: () => ReturnType<Trame["learnSoul"]>,
    done?: string,
  ) => {
    setBusy(kind);
    const res = await run();
    setBusy("");
    if (!res.ok) return toast.error("Persona", { description: res.error });
    onChange(res.details);
    if (done) toast.success(done);
  };
  const progress = Math.min(1, l.informative / Math.max(1, l.every));
  const every = String(l.every);
  const options = EVERY.some((o) => o.value === every)
    ? EVERY
    : [...EVERY, { value: every, label: every }];

  return (
    <div>
      <SectionLabel>Apprendre de mes conversations</SectionLabel>
      <GroupList>
        <div className="flex items-center gap-3 px-4 py-3">
          <Brain className="size-4 text-muted-foreground" />
          <Label htmlFor="soul-learning" className="flex-1 text-sm font-normal">
            Tenir à jour la section « Appris des conversations » d'après les
            réponses que tu corriges, écartes ou écris
          </Label>
          <Switch
            id="soul-learning"
            checked={l.enabled}
            disabled={busy === "set"}
            onCheckedChange={(enabled) =>
              act("set", () => trame.setSoulLearning({ enabled }))
            }
          />
        </div>
        {l.enabled && (
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="text-sm text-muted-foreground">
              Apprendre tous les
            </span>
            <Segment<string>
              label="Fréquence d'apprentissage"
              value={every}
              options={options}
              onChange={(v) =>
                act("set", () => trame.setSoulLearning({ every: Number(v) }))
              }
            />
            <span className="text-sm text-muted-foreground">
              échanges corrigés, écartés ou écrits
            </span>
          </div>
        )}
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>
              {l.running
                ? "Apprentissage en cours…"
                : `${l.informative} échange${l.informative > 1 ? "s" : ""} à retenir sur ${l.every}`}
            </span>
            <span className="ml-auto text-xs text-muted-foreground">
              {l.lastRunAt
                ? `Dernière leçon : ${when(l.lastRunAt)}`
                : "Aucune leçon encore"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full"
              disabled={!!busy || l.total === 0}
              onClick={() =>
                act(
                  "forget",
                  trame.forgetSoulSignals,
                  "Échanges observés oubliés",
                )
              }
            >
              <Eraser className="size-4" /> Oublier
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              disabled={!!busy || l.running || l.informative === 0}
              onClick={() =>
                act("learn", trame.learnSoul, "Persona mis à jour")
              }
            >
              {busy === "learn" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkle className="size-4" />
              )}
              {busy === "learn" ? "Apprentissage…" : "Apprendre maintenant"}
            </Button>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <motion.div
              className="h-full rounded-full bg-primary"
              initial={false}
              animate={{ width: `${progress * 100}%` }}
            />
          </div>
          {l.lastResult && (
            <div className="text-xs text-muted-foreground">
              {l.lastResult.changed
                ? `Dernière fois : ${l.lastResult.added.length} règle(s) ajoutée(s), ${l.lastResult.removed.length} retirée(s), d'après ${l.lastResult.signals} échange(s).`
                : `Dernière fois : rien de nouveau d'après ${l.lastResult.signals} échange(s).`}
            </div>
          )}
        </div>
        {l.recent.length > 0 && (
          <div className="flex flex-col gap-2 px-4 py-3">
            <span className="text-xs font-medium text-muted-foreground">
              Derniers échanges observés
            </span>
            {l.recent.slice(0, 5).map((s, i) => (
              <div key={i} className="flex flex-col gap-0.5 text-sm">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded-full bg-muted px-2 py-0.5 font-medium">
                    {KIND[s.kind]}
                  </span>
                  <span className="truncate">{s.conversation}</span>
                  <span className="ml-auto shrink-0">{when(s.at)}</span>
                </div>
                {s.kind === "corrigé" ? (
                  <div>
                    <span className="text-muted-foreground line-through">
                      {s.proposal}
                    </span>{" "}
                    <span>{s.final}</span>
                  </div>
                ) : (
                  <div
                    className={cn(
                      s.kind === "rejeté" &&
                        "text-muted-foreground line-through",
                    )}
                  >
                    {s.final || s.proposal}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="px-4 py-2.5 text-xs text-muted-foreground">
          Gardé sur ce poste ({l.total} échange{l.total > 1 ? "s" : ""}). Tes
          autres sections ne sont jamais réécrites.
        </div>
      </GroupList>
    </div>
  );
}

function Editor({
  trame,
  initial,
  onSaved,
  onCancel,
}: {
  trame: Trame;
  initial: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const dirty = text !== initial;
  const save = async () => {
    setBusy(true);
    const res = await trame.uploadSoul("SOUL.md", text);
    setBusy(false);
    if (!res.ok)
      return toast.error("Persona non enregistré", { description: res.error });
    toast.success("Persona enregistré, version précédente conservée");
    onSaved();
  };
  return (
    <div className="flex flex-col gap-4">
      <GroupList>
        <div className="flex items-center gap-2 px-4 py-2.5">
          <PenLine className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">SOUL.md</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {text.split("\n").length} lignes
          </span>
        </div>
        <Textarea
          aria-label="Contenu du SOUL.md"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck
          className="h-[clamp(14rem,calc(100dvh-24rem),40rem)] resize-none rounded-none border-0 bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-center gap-2 px-4 py-2.5">
          <span className="text-xs text-muted-foreground">
            Chaque enregistrement garde la version précédente dans l'historique.
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full"
              onClick={onCancel}
            >
              Annuler
            </Button>
            <Button
              size="sm"
              className="rounded-full"
              disabled={busy || !dirty || !text.trim()}
              onClick={save}
            >
              {busy && <Loader2 className="size-4 animate-spin" />} Enregistrer
            </Button>
          </div>
        </div>
      </GroupList>
      <SoulInsight trame={trame} content={text} />
    </div>
  );
}

function VersionHistory({
  trame,
  details,
  onChange,
}: {
  trame: Trame;
  details: SoulDetails;
  onChange: (d: SoulDetails) => void;
}) {
  const [selected, setSelected] = useState<SoulVersion | null>(
    details.history[1] ?? details.history[0] ?? null,
  );
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!selected) return;
    setContent(null);
    trame
      .getSoulVersion(selected.id)
      .then((res) => setContent(res.ok ? res.content : ""));
  }, [selected?.id]);

  const diff = useMemo(
    () => (content === null ? [] : diffLines(content, details.content)),
    [content, details.content],
  );
  const changes = diff.filter((d) => d.kind !== "same").length;

  const restore = async () => {
    if (!selected) return;
    setBusy(true);
    const res = await trame.restoreSoulVersion(selected.id);
    setBusy(false);
    if (!res.ok)
      return toast.error("Version non restaurée", { description: res.error });
    onChange(res.details);
    setSelected(res.details.history[1] ?? null);
    toast.success("Version restaurée, l'actuelle reste dans l'historique");
  };

  if (!details.history.length)
    return (
      <span className="text-sm text-muted-foreground">
        Aucune version conservée pour l'instant.
      </span>
    );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
      <GroupList className="self-start">
        {details.history.map((v, i) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setSelected(v)}
            className={cn(
              "flex w-full flex-col gap-1 px-4 py-2.5 text-left transition-colors hover:bg-muted/60",
              selected?.id === v.id && "bg-muted",
            )}
          >
            <div className="flex items-center gap-2">
              <History className="size-3.5 text-muted-foreground" />
              <span className="text-sm tabular-nums">{when(v.at)}</span>
              {i === 0 && (
                <span className="text-xs text-muted-foreground">actuelle</span>
              )}
              <span
                className={cn(
                  "ml-auto rounded-full px-2 py-0.5 text-xs font-medium",
                  SOURCE[v.source]?.className,
                )}
              >
                {SOURCE[v.source]?.label ?? v.source}
              </span>
            </div>
            {v.note && (
              <span className="text-xs text-muted-foreground">{v.note}</span>
            )}
          </button>
        ))}
      </GroupList>
      <GroupList className="self-start">
        <div className="flex items-center gap-2 px-4 py-2.5">
          <span className="text-sm font-medium">
            {selected ? `Version du ${when(selected.at)}` : ""}
          </span>
          <span className="text-xs text-muted-foreground">
            {content === null
              ? ""
              : changes
                ? `${changes} ligne(s) diffèrent de l'actuelle · barré : retiré depuis, souligné : ajouté depuis`
                : "Identique à l'actuelle"}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto rounded-full"
            disabled={busy || !changes}
            onClick={restore}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RotateCcw className="size-4" />
            )}{" "}
            Restaurer
          </Button>
        </div>
        <div className="max-h-[calc(100dvh-20rem)] overflow-auto px-4 py-3 font-mono text-[13px] leading-relaxed">
          {content === null ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : (
            foldDiff(diff).map((d, i) =>
              d.kind === "skip" ? (
                <div
                  key={i}
                  className="my-1 font-sans text-xs text-muted-foreground"
                >
                  … {d.count} ligne{d.count > 1 ? "s" : ""} identique
                  {d.count > 1 ? "s" : ""}
                </div>
              ) : (
                <div
                  key={i}
                  className={cn(
                    "whitespace-pre-wrap",
                    d.kind === "del" &&
                      "bg-destructive/10 text-destructive line-through",
                    d.kind === "add" && "bg-success/10 text-success underline",
                  )}
                >
                  {d.text || " "}
                </div>
              ),
            )
          )}
        </div>
      </GroupList>
    </div>
  );
}

import { Fragment, useEffect, useState } from "react";
import { CircleDot, Cloud, FileText, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import { openExternal } from "@/desktop";
import { ConfluenceLogo, FigmaLogo, GithubLogo, GitlabLogo, JiraLogo, TeamsLogo } from "@/brands";
import { APP_NAME, type App } from "@/lib/apps";
import { blocksOf, codeSpans, mentionSpans, type Align } from "@/lib/blocks";
import { linkify, linkLabel, type GithubRef, type Segment, type TextLink } from "@/lib/linkify";
import { cn } from "@/lib/utils";
import type { BriefGithubItem, GithubState } from "@/types";

export type GithubLookup = (ref: GithubRef) => Promise<BriefGithubItem | null>;

const STATE: Record<GithubState, { label: string; className: string }> = {
  open: { label: "ouverte", className: "text-success" },
  merged: { label: "fusionnée", className: "text-link" },
  closed: { label: "fermée", className: "text-muted-foreground" },
};

// Une seule question par PR / issue pour toute la session d'affichage, quel que soit le nombre de bulles.
const lookups = new Map<string, Promise<BriefGithubItem | null>>();
function lookup(ref: GithubRef, fetch: GithubLookup) {
  const key = `${ref.kind}/${ref.owner}/${ref.repo}/${ref.number}`.toLowerCase();
  let p = lookups.get(key);
  if (!p) {
    p = fetch(ref).catch(() => null);
    lookups.set(key, p);
  }
  return p;
}

function useGithubInfo(ref: GithubRef | null, fetch: GithubLookup | undefined) {
  const [info, setInfo] = useState<BriefGithubItem | null>(null);
  useEffect(() => {
    if (!ref || !fetch) return;
    let alive = true;
    lookup(ref, fetch).then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
    // `fetch` change à chaque rendu : hors dépendances, la réponse est de toute façon en cache.
  }, [ref?.kind, ref?.owner, ref?.repo, ref?.number]);
  return info;
}

/** Icône de l'application d'une pastille ; décorative (le nom de l'application est dans l'infobulle). */
const APP_ICON: Record<Exclude<App, "github">, React.ComponentType<{ className?: string }>> = {
  gitlab: GitlabLogo,
  jira: JiraLogo,
  confluence: ConfluenceLogo,
  teams: TeamsLogo,
  sharepoint: FileText,
  onedrive: Cloud,
  figma: FigmaLogo,
};

/** Pastille d'application : icône et libellé court, comme dans un outil de développement.
 *  Discrète (teinte du texte), lisible sur une bulle comme sur le fond. */
const CHIP =
  "inline-flex max-w-full items-center gap-1 rounded-md bg-foreground/[0.06] px-1.5 align-[-0.2em] text-[0.8125rem] leading-5 font-medium text-foreground ring-1 ring-foreground/10 ring-inset";

/** Lien cliquable : ouvert dans le navigateur du système, jamais dans la fenêtre de Trame.
 *  Application reconnue : pastille icône + libellé court ; adresse complète au survol. */
function Link({ seg, github, interactive }: { seg: Extract<Segment, { type: "link" }>; github?: GithubLookup; interactive: boolean }) {
  const info = useGithubInfo(seg.github, interactive ? github : undefined);
  const state = info?.state ? STATE[info.state] : null;
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    void openExternal(seg.url);
  };
  const app = seg.app?.app ?? null;
  const title = info
    ? `${info.kind === "pr" ? "PR" : "Issue"} ${info.repo}#${info.number}${state ? ` · ${state.label}` : ""}\n${info.title}\n${seg.url}`
    : app
      ? `${APP_NAME[app]} · ${seg.title || seg.label}\n${seg.url}`
      : seg.url;
  // Le titre d'une PR / issue (GitHub) ou le résumé d'un ticket nommé (Jira) suit la pastille.
  const after = info && seg.label === linkLabel(seg.url) ? info.title : seg.title;

  let body: React.ReactNode;
  if (app) {
    let icon: React.ReactNode;
    if (app === "github") {
      const kind = seg.app!.kind;
      const Icon =
        kind === "issue" ? CircleDot : kind === "commit" ? GitCommitHorizontal : kind === "repo" ? null
          : info?.state === "merged" ? GitMerge : info?.state === "closed" ? GitPullRequestClosed : GitPullRequest;
      icon = Icon ? <Icon aria-hidden className={cn("size-3.5 shrink-0", state?.className ?? "text-muted-foreground")} /> : <GithubLogo className="size-3.5 shrink-0" />;
    } else {
      const Icon = APP_ICON[app];
      icon = (
        <span aria-hidden className="inline-flex shrink-0 text-muted-foreground">
          <Icon className="size-3.5" />
        </span>
      );
    }
    body = (
      <>
        <span className={cn(CHIP, interactive && "transition-colors group-hover/link:bg-foreground/[0.1] group-hover/link:ring-foreground/20")}>
          {icon}
          <span className="truncate">{seg.label}</span>
        </span>
        {after && <span className="ml-1 text-muted-foreground group-hover/link:text-foreground">{after}</span>}
      </>
    );
  } else {
    body = (
      <span className={cn("text-link", interactive && "underline decoration-link/40 underline-offset-2 group-hover/link:decoration-link")}>{seg.label}</span>
    );
  }
  if (!interactive) return <span className="break-words">{body}</span>;
  return (
    <a href={seg.url} title={title} onClick={open} onAuxClick={open} className="group/link break-words rounded-md focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring">
      {body}
    </a>
  );
}

/** Code en ligne (`main`) : chasse fixe sur un fond léger. */
const CODE = "rounded-[0.3rem] bg-foreground/[0.07] px-1 py-px font-mono text-[0.85em]";

/** Personne mentionnée : en couleur et en gras, comme dans Teams. */
const MENTION = "font-semibold text-link";

/** Texte simple avec ses mentions mises en valeur. */
function withMentions(text: string, names: string[] | undefined): React.ReactNode {
  if (!names?.length) return text;
  return mentionSpans(text, names).map((s, i) => (s.mention ? <span key={i} className={MENTION}>{s.text}</span> : s.text));
}

type InlineProps = {
  text: string;
  /** Position de `text` dans le message (surlignage). */
  offset?: number;
  links?: TextLink[];
  jira?: Record<string, string>;
  range?: [number, number] | null;
  interactive: boolean;
  github?: GithubLookup;
  code: boolean;
  mentions?: string[];
};

/** Texte en ligne : liens et pastilles, mentions, code en ligne (`code`), plage surlignée. */
function Inline({ text, offset = 0, links, jira, range = null, interactive, github, code, mentions }: InlineProps) {
  const r: [number, number] | null = range ? [range[0] - offset, range[1] - offset] : null;
  const mark = (s: number, e: number, node: React.ReactNode, key: string | number) =>
    r && s < r[1] && e > r[0] ? (
      <mark key={key} className="rounded-sm bg-warning/30 px-0.5 text-foreground">
        {node}
      </mark>
    ) : (
      node
    );
  return (
    <>
      {linkify(text, links, jira).map((seg, i) => {
        if (seg.type === "link") return mark(seg.start, seg.end, <Link key={i} seg={seg} github={github} interactive={interactive} />, i);
        if (!r || r[1] <= seg.start || r[0] >= seg.end) {
          if (!code) return <span key={i}>{withMentions(seg.text, mentions)}</span>;
          return (
            <span key={i}>
              {codeSpans(seg.text).map((c, j) =>
                c.code ? <code key={j} className={CODE}>{c.text}</code> : <Fragment key={j}>{withMentions(c.text, mentions)}</Fragment>
              )}
            </span>
          );
        }
        // Surlignage à cheval sur ce morceau de texte : avant, surligné, après.
        const s = Math.max(r[0], seg.start) - seg.start;
        const e = Math.min(r[1], seg.end) - seg.start;
        return (
          <span key={i}>
            {seg.text.slice(0, s)}
            {mark(r[0], r[1], seg.text.slice(s, e), "m")}
            {seg.text.slice(e)}
          </span>
        );
      })}
    </>
  );
}

const ALIGN: Record<Exclude<Align, null>, string> = { left: "text-left", center: "text-center", right: "text-right" };

/** Tableau d'un message (Markdown, ou tableau Teams transcrit) : en-tête discret, lignes fines,
 *  défilement horizontal s'il est large. Chaque cellule garde liens, pastilles et code. */
function Table({ head, rows, align, cell }: { head: string[]; rows: string[][]; align: Align[]; cell: (text: string) => React.ReactNode }) {
  return (
    <div className="my-1 max-w-full overflow-x-auto rounded-xl border border-border/80 whitespace-normal">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="bg-muted/60">
            {head.map((h, i) => (
              <th key={i} scope="col" className={cn("px-3 py-1.5 text-xs font-semibold text-muted-foreground", align[i] && ALIGN[align[i]!])}>
                {cell(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-t border-border/70 align-top">
              {row.map((c, i) => (
                <td key={i} className={cn("px-3 py-1.5 leading-relaxed", align[i] && ALIGN[align[i]!])}>
                  {cell(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Texte d'un message : liens reconnus (pastille par application, cliquables si `interactive`),
 *  plage surlignée en option ; avec `rich`, tableaux Markdown et code en ligne.
 *  Rendu par éléments React uniquement : le texte n'est jamais interprété comme du HTML. */
export function MessageText({
  text,
  range = null,
  interactive = true,
  github,
  links,
  jira,
  rich = false,
  mentions,
}: {
  text: string;
  /** Personnes mentionnées (lues dans Teams) : mises en valeur dans le texte. */
  mentions?: string[];
  /** Liens lus dans Teams dont le texte n'est pas l'adresse : ce texte devient cliquable. */
  links?: TextLink[];
  /** Bases Jira connues par projet : une clé seule (« ALL-94 ») devient une pastille. */
  jira?: Record<string, string>;
  /** Plage [début, fin) à surligner (recherche). */
  range?: [number, number] | null;
  /** false dans un bouton ou un aperçu : liens raccourcis et colorés, mais pas cliquables. */
  interactive?: boolean;
  /** Titre et état des PR / issues GitHub liées (vue conversation). */
  github?: GithubLookup;
  /** Vue conversation : tableaux et code en ligne rendus. */
  rich?: boolean;
}) {
  if (!text) return null;
  const inline = { links, jira, range, interactive, github, code: rich, mentions };
  const blocks = rich ? blocksOf(text) : null;
  // Un seul élément : dans une bulle en colonne flex, chaque morceau deviendrait sinon une ligne.
  if (!blocks || !blocks.some((b) => b.type === "table")) {
    return (
      <span>
        <Inline text={text} {...inline} />
      </span>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {blocks.map((b, i) =>
        b.type === "text" ? (
          <span key={i}>
            <Inline text={b.text} offset={b.start} {...inline} />
          </span>
        ) : (
          <Table key={i} head={b.head} rows={b.rows} align={b.align} cell={(c) => <Inline text={c} {...inline} range={null} />} />
        )
      )}
    </div>
  );
}

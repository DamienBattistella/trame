import { useEffect, useState } from "react";
import { CircleDot, GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import { openExternal } from "@/desktop";
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

/** Lien cliquable : ouvert dans le navigateur du système, jamais dans la fenêtre de Trame. */
function Link({ seg, github }: { seg: Extract<Segment, { type: "link" }>; github?: GithubLookup }) {
  const info = useGithubInfo(seg.github, github);
  const state = info?.state ? STATE[info.state] : null;
  const Icon = seg.github?.kind === "issue" ? CircleDot : info?.state === "merged" ? GitMerge : info?.state === "closed" ? GitPullRequestClosed : GitPullRequest;
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    void openExternal(seg.url);
  };
  const title = info
    ? `${info.kind === "pr" ? "PR" : "Issue"} ${info.repo}#${info.number}${state ? ` · ${state.label}` : ""}\n${info.title}\n${seg.url}`
    : seg.url;
  return (
    <a
      href={seg.url}
      title={title}
      onClick={open}
      onAuxClick={open}
      className="group/link inline-flex max-w-full items-baseline gap-1 align-bottom text-link"
    >
      {seg.github && <Icon aria-hidden className={cn("size-3.5 shrink-0 self-center", state?.className)} />}
      <span className={cn("underline decoration-link/40 underline-offset-2 group-hover/link:decoration-link", !seg.github && "truncate")}>
        {seg.label}
      </span>
      {info && seg.label === linkLabel(seg.url) && (
        <span className="min-w-0 truncate text-muted-foreground group-hover/link:text-foreground">{info.title}</span>
      )}
    </a>
  );
}

/** Texte d'un message : liens reconnus (cliquables si `interactive`), plage surlignée en option.
 *  Rendu par éléments React uniquement : le texte n'est jamais interprété comme du HTML. */
export function MessageText({
  text,
  range = null,
  interactive = true,
  github,
  links,
}: {
  text: string;
  /** Liens lus dans Teams dont le texte n'est pas l'adresse : ce texte devient cliquable. */
  links?: TextLink[];
  /** Plage [début, fin) à surligner (recherche). */
  range?: [number, number] | null;
  /** false dans un bouton ou un aperçu : liens raccourcis et colorés, mais pas cliquables. */
  interactive?: boolean;
  /** Titre et état des PR / issues GitHub liées (vue conversation). */
  github?: GithubLookup;
}) {
  const mark = (s: number, e: number, node: React.ReactNode, key: string | number) =>
    range && s < range[1] && e > range[0] ? (
      <mark key={key} className="rounded-sm bg-warning/30 px-0.5 text-foreground">
        {node}
      </mark>
    ) : (
      node
    );
  // Un seul élément : dans une bulle en colonne flex, chaque morceau deviendrait sinon une ligne.
  if (!text) return null;
  return (
    <span>
      {linkify(text, links).map((seg, i) => {
        if (seg.type === "link") {
          const node = interactive ? (
            <Link key={i} seg={seg} github={github} />
          ) : (
            <span key={i} className="text-link">
              {seg.label}
            </span>
          );
          return mark(seg.start, seg.end, node, i);
        }
        if (!range || range[1] <= seg.start || range[0] >= seg.end) return <span key={i}>{seg.text}</span>;
        // Surlignage à cheval sur ce morceau de texte : avant, surligné, après.
        const s = Math.max(range[0], seg.start) - seg.start;
        const e = Math.min(range[1], seg.end) - seg.start;
        return (
          <span key={i}>
            {seg.text.slice(0, s)}
            {mark(range[0], range[1], seg.text.slice(s, e), "m")}
            {seg.text.slice(e)}
          </span>
        );
      })}
    </span>
  );
}

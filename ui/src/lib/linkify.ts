// Liens dans le texte d'un message : découpe en morceaux de texte et de liens, sans HTML.
// Pur (aucun import) : testé tel quel par `node --test` (ui/tests/linkify.test.ts).

export type GithubRef = { kind: "pr" | "issue"; owner: string; repo: string; number: number };

export type Segment =
  | { type: "text"; text: string; start: number; end: number }
  | { type: "link"; text: string; start: number; end: number; url: string; label: string; github: GithubRef | null };

// Début d'une adresse : http(s):// en début de texte ou après un caractère qui n'est ni lettre ni chiffre
// (« xhttps:// » ou « foo.https:// » ne sont pas des liens). Le corps s'arrête aux espaces et aux
// délimiteurs qui n'ont rien à faire dans une adresse collée (guillemets, chevrons).
const URL_RE = /(?<![\p{L}\p{N}_])https?:\/\/[^\s<>"«»“”‘’`]+/giu;
// Ponctuation de fin de phrase, jamais retenue en fin d'adresse.
const TRAILING = /[.,;:!?'…]+$/u;
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Retire la ponctuation finale et les fermantes sans ouvrante dans l'adresse : « (voir https://a.b/x_(y)). » */
function trimEnd(raw: string): string {
  let url = raw;
  for (;;) {
    const before = url;
    url = url.replace(TRAILING, "");
    const last = url[url.length - 1];
    if (last && PAIRS[last]) {
      const open = PAIRS[last];
      const opens = url.split(open).length - 1;
      const closes = url.split(last).length - 1;
      if (closes > opens) url = url.slice(0, -1);
    }
    if (url === before) return url;
  }
}

/** Adresse http(s) valide, sinon null (rien d'autre n'est jamais ouvert). */
export function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return raw;
  } catch {
    return null;
  }
}

const GITHUB_RE = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?=$|[/?#])/i;

/** PR ou issue GitHub désignée par l'adresse : « github.com/org/alliage/pull/4271 ». */
export function githubRef(url: string): GithubRef | null {
  const m = GITHUB_RE.exec(url);
  if (!m) return null;
  return { kind: m[3].toLowerCase() === "pull" ? "pr" : "issue", owner: m[1], repo: m[2], number: Number(m[4]) };
}

/** Libellé court et lisible : « alliage#4271 » pour une PR ou une issue GitHub, l'adresse sinon. */
export function linkLabel(url: string): string {
  const gh = githubRef(url);
  return gh ? `${gh.repo}#${gh.number}` : url;
}

/** Lien du message dont le texte n'est pas l'adresse (« [ALL-141] Recherche identité - Jira »). */
export type TextLink = { text: string; url: string };

/** Découpe le texte en morceaux ; leur concaténation redonne exactement le texte.
 *  `links` : liens lus dans Teams, retrouvés par leur texte, dans l'ordre, hors des adresses en clair. */
export function linkify(text: string, links: TextLink[] = []): Segment[] {
  const found: { start: number; end: number; url: string; label: string }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const url = safeUrl(trimEnd(m[0]));
    if (url) found.push({ start, end: start + url.length, url, label: linkLabel(url) });
  }
  let from = 0;
  for (const link of links) {
    const url = safeUrl(link.url);
    if (!url || !link.text || link.text === link.url) continue;
    for (let at = text.indexOf(link.text, from); at >= 0; at = text.indexOf(link.text, at + 1)) {
      const end = at + link.text.length;
      if (found.some((f) => f.start < end && at < f.end)) continue;
      found.push({ start: at, end, url, label: link.text });
      from = end;
      break;
    }
  }
  found.sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let cursor = 0;
  for (const f of found) {
    if (f.start > cursor) out.push({ type: "text", text: text.slice(cursor, f.start), start: cursor, end: f.start });
    out.push({ type: "link", text: text.slice(f.start, f.end), start: f.start, end: f.end, url: f.url, label: f.label, github: githubRef(f.url) });
    cursor = f.end;
  }
  if (cursor < text.length) out.push({ type: "text", text: text.slice(cursor), start: cursor, end: text.length });
  return out;
}

/** Le texte contient-il au moins un lien ? (évite de découper pour rien) */
export const hasLink = (text: string) => /https?:\/\//i.test(text);

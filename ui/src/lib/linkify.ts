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
function safeUrl(raw: string): string | null {
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

/** Découpe le texte en morceaux ; leur concaténation redonne exactement le texte. */
export function linkify(text: string): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  const pushText = (end: number) => {
    if (end > cursor) out.push({ type: "text", text: text.slice(cursor, end), start: cursor, end });
    cursor = end;
  };
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const url = safeUrl(trimEnd(m[0]));
    if (!url) continue;
    const end = start + url.length;
    pushText(start);
    out.push({ type: "link", text: url, start, end, url, label: linkLabel(url), github: githubRef(url) });
    cursor = end;
  }
  pushText(text.length);
  return out;
}

/** Le texte contient-il au moins un lien ? (évite de découper pour rien) */
export const hasLink = (text: string) => /https?:\/\//i.test(text);

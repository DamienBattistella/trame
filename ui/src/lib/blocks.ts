// Blocs d'un message : texte et tableaux Markdown (« | a | b | » puis « | --- | --- | »).
// Un tableau reçu dans Teams arrive sous cette forme (teams-bridge.js le transcrit) ; un
// tableau tapé en Markdown aussi. Rien n'est interprété comme du HTML.
// Pur (aucun import) : testé tel quel par `node --test` (ui/tests/blocks.test.ts).

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { type: "text"; text: string; start: number }
  | { type: "table"; head: string[]; rows: string[][]; align: Align[]; start: number; end: number };

/** Cellules d'une ligne « | a | b | » (barres de bord facultatives, « \| » garde une barre). */
export function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      out.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

const SEP_CELL = /^:?-{3,}:?$/;
const isRow = (line: string) => line.includes("|") && cells(line).length >= 2;
const sepOf = (line: string): Align[] | null => {
  if (!line.includes("-") || !line.includes("|")) return null;
  const c = cells(line);
  if (c.length < 2 || !c.every((x) => SEP_CELL.test(x))) return null;
  return c.map((x) => (x.startsWith(":") && x.endsWith(":") ? "center" : x.endsWith(":") ? "right" : x.startsWith(":") ? "left" : null));
};

/** Découpe le texte en blocs ; un bloc texte garde sa position (`start`) pour le surlignage. */
export function blocksOf(text: string): Block[] {
  if (!text.includes("|")) return text ? [{ type: "text", text, start: 0 }] : [];
  const lines = text.split("\n");
  const offs: number[] = [];
  let o = 0;
  for (const l of lines) {
    offs.push(o);
    o += l.length + 1;
  }
  const out: Block[] = [];
  let textFrom = 0;
  let i = 0;
  while (i < lines.length) {
    const align = i + 1 < lines.length && isRow(lines[i]) ? sepOf(lines[i + 1]) : null;
    const head = align ? cells(lines[i]) : null;
    if (!align || !head || head.length !== align.length) {
      i++;
      continue;
    }
    let j = i + 2;
    const rows: string[][] = [];
    while (j < lines.length && isRow(lines[j]) && !sepOf(lines[j])) {
      const r = cells(lines[j]);
      rows.push(Array.from({ length: head.length }, (_, k) => r[k] ?? ""));
      j++;
    }
    const start = offs[i];
    const end = j < lines.length ? offs[j] : text.length;
    if (start > textFrom) out.push({ type: "text", text: text.slice(textFrom, start).replace(/\n$/, ""), start: textFrom });
    out.push({ type: "table", head, rows, align, start, end });
    textFrom = end;
    i = j;
  }
  if (textFrom < text.length) out.push({ type: "text", text: text.slice(textFrom), start: textFrom });
  return out.filter((b) => b.type === "table" || b.text);
}

/** Morceaux de code en ligne (`code`) d'un texte : alternance texte / code, rien d'autre. */
export function codeSpans(text: string): { code: boolean; text: string }[] {
  if (!text.includes("`")) return [{ code: false, text }];
  const out: { code: boolean; text: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ code: false, text: text.slice(last, at) });
    out.push({ code: true, text: m[1] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

/** Morceaux d'un texte où apparaissent les personnes mentionnées (« @Ana Lopez » s'affiche
 *  « Ana Lopez » dans Teams) : alternance texte / mention, la concaténation redonne le texte.
 *  Nom entier seulement (pas « Lou » dans « Louis »), le plus long d'abord. */
export function mentionSpans(text: string, names: string[] = []): { mention: boolean; text: string }[] {
  const list = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 1))].sort((a, b) => b.length - a.length);
  if (!list.length) return [{ mention: false, text }];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])@?(?:${list.map(esc).join("|")})(?![\\p{L}\\p{N}_])`, "gu");
  const out: { mention: boolean; text: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ mention: false, text: text.slice(last, at) });
    out.push({ mention: true, text: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ mention: false, text: text.slice(last) });
  return out.length ? out : [{ mention: false, text }];
}

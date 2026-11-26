import { fold } from "@/lib/textSearch";

/** Mention en cours de frappe juste avant le curseur : « @Ana Lo » donne { at, query: "Ana Lo" }. */
export function mentionQuery(text: string, caret: number): { at: number; query: string } | null {
  const before = text.slice(0, caret);
  // « @ » en début de texte ou après une espace, puis au plus deux mots (prénom nom).
  const m = /(^|\s)@([^\s@]{0,30}(?: [^\s@]{0,30})?)$/.exec(before);
  if (!m) return null;
  return { at: before.length - m[2].length - 1, query: m[2] };
}

/** Personnes qui correspondent à la frappe : un mot du nom commence par ce qui est tapé. */
export function matchPeople(query: string, people: string[], limit = 6): string[] {
  const q = fold(query.trim());
  const hits = people.filter((name) => {
    if (!q) return true;
    const f = fold(name);
    return f.startsWith(q) || f.split(/\s+/).some((w) => w.startsWith(q));
  });
  return hits.slice(0, limit);
}

/** Remplace « @Ana Lo » par « @Ana Lopez » et rend le texte et la nouvelle position du curseur. */
export function applyMention(text: string, caret: number, at: number, name: string): { text: string; caret: number } {
  const head = text.slice(0, at) + "@" + name + " ";
  const tail = text.slice(caret).replace(/^ /, "");
  return { text: head + tail, caret: head.length };
}

/** Mentions choisies encore présentes dans le texte (l'utilisateur a pu en effacer). */
export function mentionsUsed(text: string, chosen: string[]): string[] {
  const t = text.toLowerCase();
  return chosen.filter((name, i) => t.includes("@" + name.toLowerCase()) && chosen.findIndex((n) => n.toLowerCase() === name.toLowerCase()) === i);
}

import { MessageHit, SearchScope, ThreadMessage, WatchEntity } from "@/types";

/** Même pliage que le moteur (backend/search.py) : sans accents ni casse, espaces
 *  consécutifs réduits à un seul, avec pour chaque caractère plié son index d'origine. */
export function foldMap(text: string): [string, number[]] {
  let out = "";
  const origin: number[] = [];
  Array.from(text).reduce((i, c) => {
    if (/\s/.test(c)) {
      if (!out.endsWith(" ")) {
        out += " ";
        origin.push(i);
      }
    } else {
      for (const f of c.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase()) {
        out += f;
        origin.push(i);
      }
    }
    return i + c.length;
  }, 0);
  return [out, origin];
}

export const fold = (text: string) => foldMap(text)[0].trim();

/** Position [début, fin) de la requête dans le texte d'origine, null si absente. */
export function findFolded(text: string, query: string): [number, number] | null {
  const q = fold(query);
  if (q.length < 2) return null;
  const [folded, origin] = foldMap(text);
  const pos = folded.indexOf(q);
  if (pos === -1) return null;
  const last = origin[pos + q.length - 1];
  return [origin[pos], last + (text.codePointAt(last)! > 0xffff ? 2 : 1)];
}

/** Fenêtre du texte (sur une ligne) autour de la correspondance, coupée sur des espaces. */
function excerpt(flat: string, start: number, end: number, width = 140): [string, number, number] {
  if (flat.length <= width) return [flat, start, end];
  let lo = Math.max(0, start - Math.floor(Math.max(0, width - (end - start)) / 3));
  let hi = Math.min(flat.length, lo + width);
  lo = Math.max(0, Math.min(lo, hi - width));
  if (lo > 0) {
    const cut = flat.indexOf(" ", lo);
    if (cut !== -1 && cut < start) lo = cut + 1;
  }
  if (hi < flat.length) {
    const cut = flat.lastIndexOf(" ", hi - 1);
    if (cut >= end) hi = cut;
  }
  const prefix = lo > 0 ? "…" : "";
  const suffix = hi < flat.length ? "…" : "";
  return [prefix + flat.slice(lo, hi) + suffix, start - lo + prefix.length, end - lo + prefix.length];
}

/** Mode démo : ce que le moteur garde en mémoire des messages déjà lus. */
export class DemoArchive {
  private threads = new Map<string, Map<string, ThreadMessage & { seq: number }>>();
  private seq = 0;
  readonly since = new Date().toISOString();

  add(threadId: string, messages: ThreadMessage[]) {
    const bucket = this.threads.get(threadId) ?? new Map();
    this.threads.set(threadId, bucket);
    for (const m of messages) {
      const text = m.text.trim();
      const key = `${m.sender}\u0000${text}`;
      if (!text || bucket.has(key)) continue;
      bucket.set(key, { ...m, text, seq: ++this.seq });
    }
  }

  scope(): SearchScope {
    const buckets = [...this.threads.values()].filter((b) => b.size);
    return { conversations: buckets.length, messages: buckets.reduce((n, b) => n + b.size, 0), since: this.since };
  }

  search(query: string, names: Map<string, string>, limit = 50): MessageHit[] {
    const hits: (MessageHit & { seq: number })[] = [];
    for (const [threadId, bucket] of this.threads) {
      for (const m of bucket.values()) {
        const flat = m.text.split(/\s+/).filter(Boolean).join(" ");
        const at = findFolded(flat, query);
        if (!at) continue;
        const [snippet, s, e] = excerpt(flat, at[0], at[1]);
        hits.push({
          threadId, conversation: names.get(threadId) ?? threadId, sender: m.sender, at: m.at, mine: m.mine,
          text: m.text, excerpt: snippet, match: [s, e], links: m.links ?? [], seq: m.seq,
        });
      }
    }
    return hits.sort((a, b) => b.seq - a.seq).slice(0, limit).map(({ seq: _seq, ...h }) => h);
  }
}

/** Mode démo : messages plus anciens que seule la recherche de Teams retrouve. */
const DEMO_TEAMS: { conversation: string; sender: string; at: string; text: string }[] = [
  { conversation: "Sofia Marino", sender: "Sofia Marino", at: "12/10 09:41", text: "On avait déjà eu ce souci de cache sur le runner Windows en septembre." },
  { conversation: "Lucas Bernard", sender: "Lucas Bernard", at: "03/09 16:20", text: "Pour le premier jet du mapping HL7, je pars sur une table de correspondance UCUM ?" },
  { conversation: "#prod-incidents", sender: "Marc Lefèvre", at: "28/08 11:02", text: "Incident clos : la latence du connecteur HL7 venait du pool MLLP trop petit." },
  { conversation: "Équipe Interop", sender: "Chiara Rossi", at: "14/08 10:15", text: "Le client a validé le flux de résultats de labo, on peut préparer la démo de rentrée." },
];

export function demoTeamsSearch(query: string, watchlist: WatchEntity[]): MessageHit[] {
  return DEMO_TEAMS.flatMap((m) => {
    const at = findFolded(m.text, query);
    if (!at) return [];
    const [snippet, s, e] = excerpt(m.text, at[0], at[1]);
    const threadId = watchlist.find((w) => fold(w.displayName) === fold(m.conversation))?.threadId ?? null;
    return [{ threadId, conversation: m.conversation, sender: m.sender, at: m.at, mine: false, text: m.text, excerpt: snippet, match: [s, e] }];
  });
}

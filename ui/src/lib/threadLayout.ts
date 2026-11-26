// Mise en page d'un fil : séparateurs de jour et séries d'un même auteur, à partir de
// l'heure telle que Teams l'affiche (« 09:12 », « Hier 14:05 », « 24/11 10:03 »).
// Pur (aucun import) : testé tel quel par `node --test` (ui/tests/threadLayout.test.ts).

/** Écart maximal entre deux messages d'une même série, en minutes. */
export const SERIES_MINUTES = 5;

type Stamp = { day: string | null; minutes: number | null; time: string };

const TIME_RE = /(\d{1,2})\s*[:h]\s*(\d{2})(?!.*\d{1,2}\s*[:h]\s*\d{2})/i;

/** Jour (null : aujourd'hui ou inconnu) et heure d'un horodatage Teams. */
export function stampOf(at: string): Stamp {
  const s = (at || "").trim();
  const m = TIME_RE.exec(s);
  if (!m) return { day: null, minutes: null, time: s };
  const h = Number(m[1]);
  const min = Number(m[2]);
  const day = s
    .slice(0, m.index)
    .replace(/[\s,à]+$/u, "")
    .trim();
  return { day: day || null, minutes: h * 60 + min, time: `${String(h).padStart(2, "0")}:${m[2]}` };
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export type Row = {
  /** Séparateur à afficher avant ce message (« Hier », « 24/11 », « Aujourd'hui »), sinon null. */
  day: string | null;
  /** Premier message d'une série : avatar, nom et heure. */
  head: boolean;
  /** Dernier message d'une série. */
  tail: boolean;
  /** Heure courte du message (« 09:12 »), ou l'horodatage tel quel. */
  time: string;
};

type Item = { sender: string; mine: boolean; at: string };

/** Pour chaque message : séparateur de jour, début et fin de série, heure courte.
 *  Une heure seule après un jour nommé est « Aujourd'hui » ; un fil qui ne nomme aucun jour
 *  n'a pas de séparateur. */
export function layoutThread(items: Item[]): Row[] {
  const stamps = items.map((m) => stampOf(m.at));
  const named = stamps.some((s) => s.day);
  const dayKey = (s: Stamp) => s.day ?? "";
  const rows: Row[] = items.map((m, i) => {
    const s = stamps[i];
    const prev = i > 0 ? stamps[i - 1] : null;
    let day: string | null = null;
    if (named && (prev === null ? Boolean(s.day) : dayKey(s) !== dayKey(prev))) day = s.day ? cap(s.day) : "Aujourd'hui";
    const p = items[i - 1];
    const close =
      prev !== null &&
      s.minutes !== null &&
      prev.minutes !== null &&
      s.minutes - prev.minutes >= 0 &&
      s.minutes - prev.minutes <= SERIES_MINUTES;
    const same = Boolean(p) && p.mine === m.mine && p.sender === m.sender && !day && (close || (s.minutes === null && prev?.minutes === null));
    return { day, head: !same, tail: true, time: s.time };
  });
  for (let i = 0; i < rows.length - 1; i++) rows[i].tail = rows[i + 1].head;
  return rows;
}

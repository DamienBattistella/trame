/** Mise en forme de la liste des réunions : ordre, périodes, dates courtes, durées,
 *  réunions récurrentes, recherche et chemin abrégé. Rien ici ne parle au moteur. */

/** Ce que la mise en forme lit d'une réunion (voir Meeting dans types.ts). */
export interface MeetingLike {
  title: string;
  when: string;
  /** Date ISO (AAAA-MM-JJ), si le créneau a pu être lu. */
  date: string | null;
  /** Début et fin « HH:MM », si le moteur les a lus. */
  start?: string | null;
  end?: string | null;
}

/** Sans accents, sans casse, espaces réduits : pour comparer des titres et chercher. */
export const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

const SLOT = /(\d{1,2})[:h.](\d{2})\s*[-–—]\s*(\d{1,2})[:h.](\d{2})/;
const hhmm = (h: string, m: string) => (Number(h) < 24 && Number(m) < 60 ? `${h.padStart(2, "0")}:${m}` : null);

/** Début et fin du créneau : ceux du moteur, sinon relus dans « … 11:00 - 11:45 ». */
export function slotOf(m: MeetingLike): { start: string | null; end: string | null } {
  if (m.start && m.end) return { start: m.start, end: m.end };
  const s = SLOT.exec(m.when || "");
  const start = s ? hhmm(s[1], s[2]) : null;
  const end = s ? hhmm(s[3], s[4]) : null;
  return start && end ? { start, end } : { start: null, end: null };
}

const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Durée en minutes ; une réunion qui passe minuit compte jusqu'au lendemain. */
export function durationMinutes(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const d = toMinutes(end) - toMinutes(start);
  return d > 0 ? d : d < 0 ? d + 24 * 60 : null;
}

/** « 15 min », « 1 h », « 1 h 30 ». */
export function durationLabel(minutes: number | null): string {
  if (!minutes || minutes <= 0) return "";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

/** Date ISO en date locale (minuit), sans passer par l'UTC. */
export function dayOf(iso: string | null): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const DAY = 86_400_000;
const daysBetween = (a: Date, b: Date) => Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / DAY);

/** « mar. 24 nov. », avec l'année si ce n'est pas celle de `now`. */
export function shortDate(iso: string | null, now: Date): string {
  const d = dayOf(iso);
  if (!d) return "";
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return new Intl.DateTimeFormat("fr-FR", opts).format(d);
}

export interface Period {
  key: string;
  label: string;
  /** Aujourd'hui et Hier : la date est dans le titre du groupe, la ligne n'a pas à la répéter. */
  relative: boolean;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Période d'une réunion : Aujourd'hui, Hier, Cette semaine, La semaine dernière,
 *  Plus tôt ce mois-ci, puis le mois (« Octobre », « Septembre 2025 »). */
export function periodOf(iso: string | null, now: Date): Period {
  const d = dayOf(iso);
  if (!d) return { key: "unknown", label: "Date inconnue", relative: false };
  const ago = daysBetween(now, d);
  if (ago <= 0) return { key: "today", label: "Aujourd'hui", relative: true };
  if (ago === 1) return { key: "yesterday", label: "Hier", relative: true };
  const sinceMonday = (now.getDay() + 6) % 7;
  if (ago <= sinceMonday) return { key: "week", label: "Cette semaine", relative: false };
  if (ago <= sinceMonday + 7) return { key: "last-week", label: "La semaine dernière", relative: false };
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth())
    return { key: "month", label: "Plus tôt ce mois-ci", relative: false };
  const month = new Intl.DateTimeFormat("fr-FR", { month: "long" }).format(d);
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return { key: `m-${d.getFullYear()}-${d.getMonth() + 1}`, label: capitalize(month) + year, relative: false };
}

/** La plus récente d'abord (date puis heure de début) ; sans date, en dernier, dans l'ordre reçu. */
export function sortRecentFirst<T extends MeetingLike>(meetings: T[]): T[] {
  const key = (m: T) => `${m.date ?? ""} ${slotOf(m).start ?? ""}`;
  return meetings
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      if (!a.m.date !== !b.m.date) return a.m.date ? -1 : 1;
      const ka = key(a.m);
      const kb = key(b.m);
      return ka === kb ? a.i - b.i : ka < kb ? 1 : -1;
    })
    .map(({ m }) => m);
}

/** Réunions triées puis regroupées par période, groupes dans l'ordre chronologique inverse. */
export function groupByPeriod<T extends MeetingLike>(meetings: T[], now: Date): { period: Period; items: T[] }[] {
  const groups: { period: Period; items: T[] }[] = [];
  for (const m of sortRecentFirst(meetings)) {
    const period = periodOf(m.date, now);
    const last = groups[groups.length - 1];
    if (last && last.period.key === period.key) last.items.push(m);
    else groups.push({ period, items: [m] });
  }
  return groups;
}

/** Nombre d'occurrences de chaque titre (plié) : au-delà d'une, la réunion est récurrente. */
export function occurrences(meetings: MeetingLike[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const m of meetings) n.set(fold(m.title), (n.get(fold(m.title)) ?? 0) + 1);
  return n;
}

/** Tous les mots de la recherche sont dans le titre (sans accents ni casse). */
export function matches(m: MeetingLike, query: string): boolean {
  const words = fold(query).split(" ").filter(Boolean);
  const title = fold(m.title);
  return words.every((w) => title.includes(w));
}

/** « Documents › Trame › Transcriptions » : les trois derniers dossiers d'un chemin. */
export function shortPath(path: string): string {
  const parts = (path || "").split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return "";
  return parts.slice(-3).join(" › ");
}

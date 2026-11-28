/** Calendrier des réunions : semaines, jours, placement des créneaux dans la grille horaire
 *  et libellés relatifs. Rien ici ne parle au moteur ni au DOM. */

import { fold, slotOf, type MeetingLike } from "./meetings.ts";

/** Date locale en ISO (AAAA-MM-JJ), sans passer par l'UTC. */
export const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Jour local à minuit d'une date ISO ; null si elle ne se lit pas. */
export function parseDay(iso: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Lundi de la semaine (convention française). */
export function weekStart(d: Date): Date {
  return addDays(d, -((d.getDay() + 6) % 7));
}

/** Les jours affichés : 7 à partir du lundi, du lundi au vendredi (semaine de travail), ou le seul jour choisi. */
export function visibleDays(anchor: Date, view: "week" | "work_week" | "day"): Date[] {
  if (view === "day") return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
  const start = weekStart(anchor);
  return Array.from({ length: view === "work_week" ? 5 : 7 }, (_, i) => addDays(start, i));
}

/** La semaine entière du lundi au dimanche autour d'un jour : la période lue dans l'agenda. */
export function weekSpan(anchor: Date): { start: string; end: string } {
  const a = weekStart(anchor);
  return { start: isoDay(a), end: isoDay(addDays(a, 6)) };
}

/** Numéro de semaine ISO 8601. */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

const MONTH_SHORT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const MONTH_LONG = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
export const WEEKDAY_SHORT = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
const WEEKDAY_LONG = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

/** Indice du jour de la semaine, lundi = 0. */
export const weekdayIndex = (d: Date) => (d.getDay() + 6) % 7;

/** « 23 au 29 nov. 2026 », « 30 nov. au 6 déc. 2026 », « 28 déc. 2026 au 3 janv. 2027 » ; un jour : « mardi 24 novembre 2026 ». */
export function rangeLabel(days: Date[]): string {
  const a = days[0];
  const b = days[days.length - 1];
  if (days.length === 1) return `${WEEKDAY_LONG[weekdayIndex(a)]} ${a.getDate()} ${MONTH_LONG[a.getMonth()]} ${a.getFullYear()}`;
  if (a.getFullYear() !== b.getFullYear())
    return `${a.getDate()} ${MONTH_SHORT[a.getMonth()]} ${a.getFullYear()} au ${b.getDate()} ${MONTH_SHORT[b.getMonth()]} ${b.getFullYear()}`;
  if (a.getMonth() !== b.getMonth()) return `${a.getDate()} ${MONTH_SHORT[a.getMonth()]} au ${b.getDate()} ${MONTH_SHORT[b.getMonth()]} ${b.getFullYear()}`;
  return `${a.getDate()} au ${b.getDate()} ${MONTH_SHORT[a.getMonth()]} ${a.getFullYear()}`;
}

/** « novembre 2026 ». */
export const monthLabel = (d: Date) => `${MONTH_LONG[d.getMonth()]} ${d.getFullYear()}`;

/** « mar. 24 nov. » */
export const dayLabel = (d: Date) => `${WEEKDAY_SHORT[weekdayIndex(d)]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;

/** Les 6 semaines du mini-mois, du lundi qui précède le 1er. */
export function monthGrid(month: Date): Date[][] {
  const first = weekStart(new Date(month.getFullYear(), month.getMonth(), 1));
  return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(first, w * 7 + i)));
}

export const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Une réunion placée dans la grille : minutes de début et de fin dans son jour, colonne parmi celles qui se chevauchent. */
export interface Placed<T> {
  item: T;
  start: number;
  end: number;
  column: number;
  columns: number;
}

/** Durée minimale affichée : un créneau de 5 minutes reste cliquable. */
const MIN_SPAN = 15;

/**
 * Les réunions d'un jour avec un horaire lisible, réparties en colonnes quand elles se
 * chevauchent (comme Outlook ou Teams) : chaque groupe de réunions qui se touchent partage
 * la largeur en autant de colonnes que nécessaire. Une réunion qui passe minuit s'arrête à 24 h.
 */
export function layoutDay<T extends MeetingLike>(items: T[]): Placed<T>[] {
  const timed = items
    .map((item) => {
      const { start, end } = slotOf(item);
      if (!start || !end) return null;
      const s = toMinutes(start);
      let e = toMinutes(end);
      if (e <= s) e = 24 * 60;
      return { item, start: s, end: Math.max(e, s + MIN_SPAN), column: 0, columns: 1 };
    })
    .filter((x): x is Placed<T> => x !== null)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  let group: Placed<T>[] = [];
  let groupEnd = -1;
  const ends: number[] = [];
  const close = () => {
    for (const p of group) p.columns = ends.length;
    group = [];
    ends.length = 0;
  };
  for (const p of timed) {
    if (p.start >= groupEnd) {
      close();
      groupEnd = -1;
    }
    let col = ends.findIndex((e) => e <= p.start);
    if (col === -1) col = ends.push(p.end) - 1;
    else ends[col] = p.end;
    p.column = col;
    group.push(p);
    groupEnd = Math.max(groupEnd, p.end);
  }
  close();
  return timed;
}

/** Réunions sans horaire lisible : affichées en tête du jour, comme un événement « toute la journée ». */
export function untimed<T extends MeetingLike>(items: T[]): T[] {
  return items.filter((m) => !slotOf(m).start);
}

/** Les réunions rangées par jour ISO. */
export function byDay<T extends MeetingLike>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const m of items) {
    if (!m.date) continue;
    const list = out.get(m.date);
    if (list) list.push(m);
    else out.set(m.date, [m]);
  }
  return out;
}

/** Plage d'heures de la grille : 8 h à 19 h, élargie pour montrer chaque réunion des jours affichés. */
export function hourRange(placed: { start: number; end: number }[]): { from: number; to: number } {
  let from = 8;
  let to = 19;
  for (const p of placed) {
    from = Math.min(from, Math.floor(p.start / 60));
    to = Math.max(to, Math.ceil(p.end / 60));
  }
  return { from, to: Math.min(to, 24) };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

/**
 * Où en est la réunion par rapport à maintenant : « En cours », « Dans 40 min »,
 * « Il y a 2 h », « Hier », « Il y a 3 jours ». Null sans date.
 */
export function relativeLabel(m: MeetingLike, now: Date): string | null {
  const day = parseDay(m.date);
  if (!day) return null;
  const { start, end } = slotOf(m);
  if (start && end) {
    const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, toMinutes(start));
    let e = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, toMinutes(end));
    if (e <= s) e = addDays(e, 1);
    const t = now.getTime();
    if (t >= s.getTime() && t < e.getTime()) return "En cours";
    const sameDay = isoDay(now) === m.date;
    if (sameDay && t < s.getTime()) {
      const min = Math.round((s.getTime() - t) / 60_000);
      return min < 60 ? `Dans ${min} min` : `Dans ${plural(Math.round(min / 60), "h", "h")}`;
    }
    if (sameDay) {
      const min = Math.round((t - e.getTime()) / 60_000);
      return min < 60 ? `Il y a ${Math.max(min, 1)} min` : `Il y a ${plural(Math.round(min / 60), "h", "h")}`;
    }
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return "Aujourd'hui";
  if (days === 1) return "Hier";
  if (days === -1) return "Demain";
  return days > 0 ? `Il y a ${plural(days, "jour")}` : `Dans ${plural(-days, "jour")}`;
}

// --- Agenda et réunions lues : un seul bloc par rendez-vous -------------------------------

/** Ce que le calendrier lit d'une réunion lue (transcription), voir Meeting dans types.ts. */
export interface ReadMeeting extends MeetingLike {
  meetingId: string;
  threadId: string;
  mid: string;
  chat: string;
  transcript: boolean;
  saved: unknown;
}

/** Ce que le calendrier lit d'un événement de l'agenda, voir CalendarEvent dans types.ts. */
export interface AgendaEvent {
  id: string;
  title: string;
  date: string;
  start: string | null;
  end: string | null;
  allDay: boolean;
  showAs: string;
  private: boolean;
  online: boolean;
  threadId: string;
}

/** Un bloc du calendrier : un événement de l'agenda, sa réunion lue s'il en a une, ou une réunion seule. */
export interface CalItem<E extends AgendaEvent, M extends ReadMeeting> extends MeetingLike {
  key: string;
  event: E | null;
  meeting: M | null;
}

/** Absence, événement privé ou sans réunion Teams : masqué sauf si l'utilisateur les affiche. */
export const isPersonal = (e: AgendaEvent) => e.showAs === "oof" || e.private || !e.online;

const rank = (m: ReadMeeting) => (m.saved ? 2 : m.transcript ? 1 : 0);
const midOf = (m: ReadMeeting) => (/^\d+$/.test(m.mid) ? Number(m.mid) : 0);
const better = <M extends ReadMeeting>(a: M, b: M) => (rank(b) > rank(a) || (rank(b) === rank(a) && midOf(b) > midOf(a)) ? b : a);

/**
 * Une seule réunion par rendez-vous : un appel coupé puis relancé laisse deux fins d'appel
 * (même conversation, même créneau). On garde celle qui a la transcription enregistrée, sinon
 * disponible, sinon la dernière.
 */
export function dedupeMeetings<M extends ReadMeeting>(meetings: M[]): M[] {
  const by = new Map<string, M>();
  const order: string[] = [];
  for (const m of meetings) {
    const { start, end } = slotOf(m);
    const k = m.date && start ? `${m.threadId}|${m.date}|${start}|${end}` : `id|${m.meetingId}`;
    const kept = by.get(k);
    if (!kept) order.push(k);
    by.set(k, kept ? better(kept, m) : m);
  }
  return order.map((k) => by.get(k)!);
}

/** Écart entre deux débuts « HH:MM », en minutes ; Infinity si l'un manque. */
const gap = (a: string | null, b: string | null) => (a && b ? Math.abs(toMinutes(a) - toMinutes(b)) : Infinity);

/**
 * L'agenda d'abord, comme le calendrier de Teams : chaque événement est un bloc, et la réunion
 * lue qui lui correspond (même conversation de réunion, sinon même titre, le même jour, à moins
 * de 2 h) lui donne sa transcription. Les réunions lues sans événement (appel dans un groupe,
 * agenda pas lu) restent en blocs à part. Les événements personnels ne sont montrés que sur
 * demande, sauf s'ils portent une réunion lue.
 */
export function joinCalendar<E extends AgendaEvent, M extends ReadMeeting>(
  events: E[],
  meetings: M[],
  showPersonal: boolean
): CalItem<E, M>[] {
  const byEvent = new Map<string, M>();
  const alone: M[] = [];
  const perDay = new Map<string, E[]>();
  for (const e of events) {
    const list = perDay.get(e.date);
    if (list) list.push(e);
    else perDay.set(e.date, [e]);
  }
  for (const m of dedupeMeetings(meetings)) {
    const sameDay = m.date ? perDay.get(m.date) ?? [] : [];
    const start = slotOf(m).start;
    const near = (e: E) => e.allDay || gap(e.start, start) <= 120;
    const byThread = sameDay.filter((e) => e.threadId && e.threadId === m.threadId && near(e));
    const byTitle = sameDay.filter((e) => !e.threadId && [fold(m.title), fold(m.chat)].includes(fold(e.title)) && near(e));
    const pool = byThread.length ? byThread : byTitle;
    if (!pool.length) {
      alone.push(m);
      continue;
    }
    const e = pool.reduce((a, b) => (gap(b.start, start) < gap(a.start, start) ? b : a));
    const kept = byEvent.get(e.id);
    byEvent.set(e.id, kept ? better(kept, m) : m);
  }
  const out: CalItem<E, M>[] = [];
  for (const e of events) {
    const meeting = byEvent.get(e.id) ?? null;
    if (!meeting && !showPersonal && isPersonal(e)) continue;
    out.push({ key: `ev:${e.id}`, title: e.title, when: "", date: e.date, start: e.allDay ? null : e.start, end: e.allDay ? null : e.end, event: e, meeting });
  }
  for (const m of alone) {
    const { start, end } = slotOf(m);
    out.push({ key: `m:${m.meetingId}`, title: m.title, when: m.when, date: m.date, start, end, event: null, meeting: m });
  }
  return out;
}

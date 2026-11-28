import { test } from "node:test";
import assert from "node:assert/strict";
import {
  byDay,
  hourRange,
  isoDay,
  isoWeek,
  layoutDay,
  monthGrid,
  rangeLabel,
  relativeLabel,
  untimed,
  visibleDays,
  weekSpan,
  weekStart,
  dedupeMeetings,
  joinCalendar,
  isPersonal,
} from "../src/lib/calendar.ts";

const m = (title: string, date: string | null, start: string | null = null, end: string | null = null, when = "") =>
  ({ title, date, when, start, end });

test("la semaine commence le lundi, même un dimanche", () => {
  assert.equal(isoDay(weekStart(new Date(2026, 10, 26))), "2026-11-23");
  assert.equal(isoDay(weekStart(new Date(2026, 10, 29))), "2026-11-23");
  assert.equal(isoDay(weekStart(new Date(2026, 10, 23))), "2026-11-23");
});

test("jours affichés : sept en semaine, un seul en vue jour", () => {
  const week = visibleDays(new Date(2026, 10, 26, 15), "week").map(isoDay);
  assert.deepEqual(week, ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"]);
  assert.deepEqual(visibleDays(new Date(2026, 10, 26, 15), "day").map(isoDay), ["2026-11-26"]);
});

test("numéro de semaine ISO, y compris à cheval sur deux années", () => {
  assert.equal(isoWeek(new Date(2026, 10, 24)), 48);
  assert.equal(isoWeek(new Date(2027, 0, 1)), 53);
  assert.equal(isoWeek(new Date(2026, 0, 1)), 1);
});

test("libellé de la période", () => {
  assert.equal(rangeLabel(visibleDays(new Date(2026, 10, 24), "week")), "23 au 29 nov. 2026");
  assert.equal(rangeLabel(visibleDays(new Date(2026, 11, 1), "week")), "30 nov. au 6 déc. 2026");
  assert.equal(rangeLabel(visibleDays(new Date(2026, 11, 30), "week")), "28 déc. 2026 au 3 janv. 2027");
  assert.equal(rangeLabel(visibleDays(new Date(2026, 10, 24), "day")), "mardi 24 novembre 2026");
});

test("mini-mois : six semaines à partir du lundi qui précède le 1er", () => {
  const grid = monthGrid(new Date(2026, 10, 15));
  assert.equal(grid.length, 6);
  assert.equal(isoDay(grid[0][0]), "2026-10-26");
  assert.equal(isoDay(grid[5][6]), "2026-12-06");
});

test("les réunions qui se chevauchent se partagent la largeur", () => {
  const placed = layoutDay([
    m("A", "2026-11-24", "10:00", "11:00"),
    m("B", "2026-11-24", "10:30", "11:30"),
    m("C", "2026-11-24", "11:00", "12:00"),
    m("D", "2026-11-24", "14:00", "15:00"),
  ]);
  const of = (t: string) => placed.find((p) => p.item.title === t)!;
  assert.deepEqual([of("A").column, of("A").columns], [0, 2]);
  assert.deepEqual([of("B").column, of("B").columns], [1, 2]);
  assert.deepEqual([of("C").column, of("C").columns], [0, 2]);
  assert.deepEqual([of("D").column, of("D").columns], [0, 1]);
});

test("horaire relu dans le texte de Teams, minuit et créneau très court", () => {
  const placed = layoutDay([
    m("Texte", "2026-11-24", null, null, "mardi 24 novembre 2026 09:00 - 09:30"),
    m("Nuit", "2026-11-24", "23:30", "00:15"),
    m("Éclair", "2026-11-24", "12:00", "12:05"),
  ]);
  const of = (t: string) => placed.find((p) => p.item.title === t)!;
  assert.deepEqual([of("Texte").start, of("Texte").end], [540, 570]);
  assert.equal(of("Nuit").end, 1440);
  assert.equal(of("Éclair").end - of("Éclair").start, 15);
});

test("réunions sans horaire et rangement par jour", () => {
  const items = [m("A", "2026-11-24", "10:00", "11:00"), m("B", "2026-11-24"), m("C", null, "10:00", "11:00")];
  assert.deepEqual(untimed(items).map((x) => x.title), ["B"]);
  const days = byDay(items);
  assert.deepEqual([...days.keys()], ["2026-11-24"]);
  assert.equal(days.get("2026-11-24")!.length, 2);
});

test("la grille s'élargit pour montrer une réunion tôt ou tard", () => {
  assert.deepEqual(hourRange([]), { from: 8, to: 19 });
  assert.deepEqual(hourRange([{ start: 7 * 60 + 30, end: 8 * 60 }, { start: 20 * 60, end: 21 * 60 + 15 }]), { from: 7, to: 22 });
});

test("libellé relatif à maintenant", () => {
  const now = new Date(2026, 10, 24, 13, 20);
  assert.equal(relativeLabel(m("x", "2026-11-24", "14:00", "15:30"), now), "Dans 40 min");
  assert.equal(relativeLabel(m("x", "2026-11-24", "13:00", "14:00"), now), "En cours");
  assert.equal(relativeLabel(m("x", "2026-11-24", "09:00", "10:00"), now), "Il y a 3 h");
  assert.equal(relativeLabel(m("x", "2026-11-24", "13:00", "13:15"), now), "Il y a 5 min");
  assert.equal(relativeLabel(m("x", "2026-11-23", "09:00", "10:00"), now), "Hier");
  assert.equal(relativeLabel(m("x", "2026-11-20"), now), "Il y a 4 jours");
  assert.equal(relativeLabel(m("x", null), now), null);
});

test("semaine de travail : du lundi au vendredi ; l'agenda est lu sur la semaine entière", () => {
  assert.deepEqual(visibleDays(new Date(2026, 10, 28), "work_week").map(isoDay), ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]);
  assert.deepEqual(weekSpan(new Date(2026, 10, 28)), { start: "2026-11-23", end: "2026-11-29" });
});

const MEET = "title-19:meeting_strat@thread.v2";
const meeting = (o: Record<string, unknown> = {}) => ({
  meetingId: "m1", threadId: MEET, mid: "1000", chat: "Stratégie GAP", title: "Stratégie GAP", when: "",
  date: "2026-11-25", start: "15:00", end: "15:30", transcript: false, saved: null as unknown, ...o,
});
const event = (o: Record<string, unknown> = {}) => ({
  id: "e1|2026-11-25", title: "Stratégie Gestion rendez-vous GAP/WebAgenda/Bornes", date: "2026-11-25", start: "15:00", end: "15:30",
  allDay: false, showAs: "busy", private: false, online: true, threadId: MEET, ...o,
});

test("un appel coupé puis relancé : une seule réunion, celle qui a la transcription", () => {
  const twice = [meeting({ meetingId: "a", mid: "1000" }), meeting({ meetingId: "b", mid: "2000", transcript: true }), meeting({ meetingId: "c", mid: "3000" })];
  assert.deepEqual(dedupeMeetings(twice).map((x) => x.meetingId), ["b"]);
  // Deux créneaux différents dans la même conversation (réunion récurrente) : deux réunions.
  assert.equal(dedupeMeetings([meeting(), meeting({ meetingId: "z", date: "2026-11-26" })]).length, 2);
});

test("agenda d'abord : la réunion lue rejoint son événement (même conversation), titre de l'agenda, un seul bloc", () => {
  const items = joinCalendar([event()], [meeting({ meetingId: "a" }), meeting({ meetingId: "b", mid: "2000", transcript: true })], false);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Stratégie Gestion rendez-vous GAP/WebAgenda/Bornes");
  assert.equal(items[0].meeting?.meetingId, "b");
  assert.equal(items[0].event?.id, "e1|2026-11-25");
});

test("agenda d'abord : réunions jamais lancées et à venir affichées ; réunion lue sans événement gardée à part", () => {
  const items = joinCalendar(
    [event({ id: "never", threadId: "title-19:meeting_other@thread.v2", title: "CIR 2026", start: "11:00", end: "12:00" })],
    [meeting({ meetingId: "group-call", threadId: "title-19:grp@thread.v2", title: "Projet X", chat: "Projet X" })],
    false
  );
  assert.deepEqual(items.map((i) => [i.key, Boolean(i.event), Boolean(i.meeting)]), [["ev:never", true, false], ["m:group-call", false, true]]);
});

test("sans conversation dans l'agenda, la réunion lue est reconnue par son titre, le même jour, à moins de 2 h", () => {
  const ev = event({ threadId: "", title: "Stratégie GAP", start: "15:15", end: "15:45" });
  assert.equal(joinCalendar([ev], [meeting()], false).length, 1);
  assert.equal(joinCalendar([{ ...ev, start: "18:00", end: "18:30" }], [meeting()], false).length, 2);
});

test("absences, événements privés et sans réunion Teams : masqués sauf demande", () => {
  const away = event({ id: "oof", title: "Out of the office", showAs: "oof", online: false, threadId: "" });
  const room = event({ id: "room", title: "Meeting Room réservation", online: false, threadId: "" });
  const secret = event({ id: "p", title: "Orthophoniste", private: true, online: false, threadId: "" });
  assert.ok([away, room, secret].every(isPersonal));
  assert.equal(isPersonal(event()), false);
  assert.equal(joinCalendar([away, room, secret, event()], [], false).length, 1);
  assert.equal(joinCalendar([away, room, secret, event()], [], true).length, 4);
});

test("un événement sur la journée reste sans horaire (bandeau en tête du jour)", () => {
  const items = joinCalendar([event({ id: "ad", allDay: true, start: null, end: null, private: true, online: false, threadId: "" })], [], true);
  assert.equal(untimed(items).length, 1);
});

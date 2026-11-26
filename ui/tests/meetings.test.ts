import { test } from "node:test";
import assert from "node:assert/strict";
import {
  durationLabel,
  durationMinutes,
  fold,
  groupByPeriod,
  matches,
  occurrences,
  periodOf,
  shortDate,
  shortPath,
  slotOf,
  sortRecentFirst,
} from "../src/lib/meetings.ts";

// Jeudi 26 novembre 2026, 18 h.
const NOW = new Date(2026, 10, 26, 18, 0);
const m = (title: string, date: string | null, when = "", start: string | null = null, end: string | null = null) =>
  ({ title, date, when, start, end });

test("créneau : celui du moteur, sinon relu dans le texte de Teams", () => {
  assert.deepEqual(slotOf(m("a", null, "x", "09:05", "10:30")), { start: "09:05", end: "10:30" });
  assert.deepEqual(slotOf(m("a", null, "mardi 24 novembre 2026 11:00 - 11:45")), { start: "11:00", end: "11:45" });
  assert.deepEqual(slotOf(m("a", null, "jeudi 3 septembre 2026 9:30 – 10:00")), { start: "09:30", end: "10:00" });
  assert.deepEqual(slotOf(m("a", null, "mardi 24 novembre 2026")), { start: null, end: null });
});

test("durées lisibles", () => {
  assert.equal(durationMinutes("11:00", "11:45"), 45);
  assert.equal(durationMinutes("23:30", "00:15"), 45);
  assert.equal(durationMinutes("11:00", "11:00"), null);
  assert.equal(durationMinutes(null, "11:00"), null);
  assert.equal(durationLabel(15), "15 min");
  assert.equal(durationLabel(60), "1 h");
  assert.equal(durationLabel(90), "1 h 30");
  assert.equal(durationLabel(65), "1 h 05");
  assert.equal(durationLabel(null), "");
});

test("dates courtes, année seulement si elle change", () => {
  assert.equal(shortDate("2026-11-24", NOW), "mar. 24 nov.");
  assert.equal(shortDate("2025-12-01", NOW), "lun. 1 déc. 2025");
  assert.equal(shortDate(null, NOW), "");
  assert.equal(shortDate("pas une date", NOW), "");
});

test("périodes relatives au jour courant (semaine commençant le lundi)", () => {
  const label = (iso: string | null) => periodOf(iso, NOW).label;
  assert.equal(label("2026-11-26"), "Aujourd'hui");
  assert.equal(label("2026-11-25"), "Hier");
  assert.equal(label("2026-11-23"), "Cette semaine");
  assert.equal(label("2026-11-22"), "La semaine dernière");
  assert.equal(label("2026-11-16"), "La semaine dernière");
  assert.equal(label("2026-11-13"), "Plus tôt ce mois-ci");
  assert.equal(label("2026-10-29"), "Octobre");
  assert.equal(label("2025-12-03"), "Décembre 2025");
  assert.equal(label(null), "Date inconnue");
  assert.equal(periodOf("2026-11-26", NOW).relative, true);
  assert.equal(periodOf("2026-11-23", NOW).relative, false);
});

test("lundi : hier est dimanche, et la semaine dernière commence le lundi d'avant", () => {
  const monday = new Date(2026, 10, 23, 9);
  assert.equal(periodOf("2026-11-22", monday).label, "Hier");
  assert.equal(periodOf("2026-11-16", monday).label, "La semaine dernière");
  assert.equal(periodOf("2026-11-15", monday).label, "Plus tôt ce mois-ci");
});

test("la plus récente d'abord, les réunions sans date en dernier", () => {
  const list = [
    m("b", "2026-11-24", "", "11:00", "11:45"),
    m("sans date", null),
    m("a", "2026-11-13"),
    m("c", "2026-11-26", "", "09:00", "10:00"),
    m("d", "2026-11-26", "", "11:30", "12:00"),
    m("e", "2026-09-03"),
  ];
  assert.deepEqual(sortRecentFirst(list).map((x) => x.title), ["d", "c", "b", "a", "e", "sans date"]);
});

test("regroupement par période, dans l'ordre", () => {
  const groups = groupByPeriod(
    [m("x", "2026-10-01"), m("y", "2026-11-26"), m("z", "2026-11-25"), m("w", "2026-10-29"), m("v", "2026-11-26")],
    NOW,
  );
  assert.deepEqual(groups.map((g) => [g.period.label, g.items.map((i) => i.title)]), [
    ["Aujourd'hui", ["y", "v"]],
    ["Hier", ["z"]],
    ["Octobre", ["w", "x"]],
  ]);
});

test("réunions récurrentes : même titre, sans tenir compte des accents ni de la casse", () => {
  const n = occurrences([m("Synchro inter-équipes", null), m("synchro inter-equipes", null), m("Autre", null)]);
  assert.equal(n.get(fold("Synchro inter-équipes")), 2);
  assert.equal(n.get(fold("Autre")), 1);
});

test("recherche par mots du titre", () => {
  const r = m("Point projet Atlas", null);
  assert.equal(matches(r, "atlas"), true);
  assert.equal(matches(r, "  PROJET   atlas "), true);
  assert.equal(matches(m("Revue d'architecture", null), "revue archi"), true);
  assert.equal(matches(r, "atlas recette"), false);
  assert.equal(matches(r, ""), true);
  assert.equal(matches(m("Démo de fin", null), "demo"), true);
});

test("chemin abrégé aux trois derniers dossiers", () => {
  assert.equal(shortPath(String.raw`C:\Users\vous\OneDrive\Documents\Trame\Transcriptions`), "Documents › Trame › Transcriptions");
  assert.equal(shortPath(String.raw`D:\CR`), "D: › CR");
  assert.equal(shortPath("/home/vous/cr/"), "home › vous › cr");
  assert.equal(shortPath(""), "");
});

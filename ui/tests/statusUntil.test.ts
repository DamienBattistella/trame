// node --test tests/ : Node 24 lit le TypeScript tel quel, sans dépendance de test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayBounds, defaultUntil, halfHours, untilLabel, untilValue } from "../src/lib/statusUntil.ts";

const NOW = new Date(2026, 10, 26, 16, 50); // jeudi 26 novembre 2026, 16 h 50

test("aujourd'hui : seulement les demi-heures à venir", () => {
  const times = halfHours("2026-11-26", NOW);
  assert.equal(times[0], "17:00");
  assert.equal(times.at(-1), "23:30");
  assert.equal(halfHours("2026-11-27", NOW).length, 48);
});

test("choix proposé : la prochaine demi-heure, au moins 30 minutes plus tard", () => {
  assert.deepEqual(defaultUntil(NOW), { day: "2026-11-26", time: "17:30" });
  assert.deepEqual(defaultUntil(new Date(2026, 10, 26, 16, 0)), { day: "2026-11-26", time: "16:30" });
  assert.deepEqual(defaultUntil(new Date(2026, 10, 26, 23, 40)), { day: "2026-11-27", time: "00:30" });
});

test("valeur envoyée au moteur, ou rien si impossible", () => {
  assert.equal(untilValue("2026-11-26", "18:30", NOW), "2026-11-26T18:30");
  assert.equal(untilValue("2026-11-26", "16:30", NOW), null); // passé
  assert.equal(untilValue("2026-11-26", "18:15", NOW), null); // pas une demi-heure
  assert.equal(untilValue("2026-11-31", "10:00", NOW), null); // jour inexistant
  assert.equal(untilValue(dayBounds(NOW).max, "09:00", NOW), "2026-12-26T09:00");
  assert.equal(untilValue("2026-12-27", "09:00", NOW), null); // au-delà de 30 jours
});

test("libellé lisible", () => {
  assert.equal(untilLabel("2026-11-26", "14:30", NOW), "14 h 30");
  assert.equal(untilLabel("2026-11-27", "09:00", NOW), "demain 9 h");
  assert.equal(untilLabel("2026-12-03", "14:30", NOW), "jeudi 3 décembre 14 h 30");
});

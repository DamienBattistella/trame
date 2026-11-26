// node --test tests/ : séparateurs de jour et séries d'un même auteur.
import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutThread, stampOf } from "../src/lib/threadLayout.ts";

test("horodatages Teams", () => {
  assert.deepEqual(stampOf("09:12"), { day: null, minutes: 552, time: "09:12" });
  assert.deepEqual(stampOf("Hier 14:05"), { day: "Hier", minutes: 845, time: "14:05" });
  assert.deepEqual(stampOf("24/11 9:03"), { day: "24/11", minutes: 543, time: "09:03" });
  assert.deepEqual(stampOf("lundi à 10h30"), { day: "lundi", minutes: 630, time: "10:30" });
  assert.deepEqual(stampOf("à l'instant"), { day: null, minutes: null, time: "à l'instant" });
});

const m = (sender: string, at: string, mine = false) => ({ sender, at, mine });

test("séries : même auteur, moins de cinq minutes, même jour", () => {
  const rows = layoutThread([m("Ana", "09:00"), m("Ana", "09:04"), m("Ana", "09:20"), m("Toi", "09:21", true), m("Ana", "09:22")]);
  assert.deepEqual(rows.map((r) => r.head), [true, false, true, true, true]);
  assert.deepEqual(rows.map((r) => r.tail), [false, true, true, true, true]);
  assert.ok(rows.every((r) => r.day === null));
});

test("jours : séparateur à chaque changement, Aujourd'hui après un jour nommé", () => {
  const rows = layoutThread([m("Ana", "24/11 17:00"), m("Ana", "24/11 17:01"), m("Ana", "hier 09:00"), m("Ana", "09:01")]);
  assert.deepEqual(rows.map((r) => r.day), ["24/11", null, "Hier", "Aujourd'hui"]);
  assert.deepEqual(rows.map((r) => r.head), [true, false, true, true]);
});

// node --test tests/ : Node 24 lit le TypeScript tel quel, sans dépendance de test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFS, inQuietHours, toasts, type NoticeLike, type NotifyPrefs } from "../src/lib/notifyPrefs.ts";

const at = (h: number, m = 0) => new Date(2026, 10, 26, h, m);
const n = (over: Partial<NoticeLike>): NoticeLike => ({
  threadId: "t1", conversation: "Lucas Bernard", from: "Lucas Bernard", text: "Salut", surface: "dm", ...over,
});
const prefs = (over: Partial<NotifyPrefs>): NotifyPrefs => ({ ...DEFAULT_PREFS, ...over });

test("par défaut, tout est notifié, un message = une notification", () => {
  assert.deepEqual(toasts([n({})], DEFAULT_PREFS, at(10)), [{ title: "Lucas Bernard", body: "Salut" }]);
});

test("« privé, mentions et suivies » laisse passer ces trois-là seulement", () => {
  const p = prefs({ scope: "direct" });
  const group = { surface: "group" as const, threadId: "g", conversation: "Équipe", from: "Ana" };
  assert.equal(toasts([n(group)], p, at(10)).length, 0);
  assert.equal(toasts([n({ ...group, mentioned: true })], p, at(10)).length, 1);
  assert.equal(toasts([n({ ...group, followed: true })], p, at(10)).length, 1);
  assert.equal(toasts([n({})], p, at(10)).length, 1);
});

test("« mentions seulement » ignore même les messages privés", () => {
  const p = prefs({ scope: "mentions" });
  assert.equal(toasts([n({})], p, at(10)).length, 0);
  assert.equal(toasts([n({ mentioned: true })], p, at(10)).length, 1);
});

test("heures calmes, y compris à cheval sur minuit", () => {
  const p = prefs({ quiet: { on: true, from: "19:00", to: "08:00" } });
  assert.ok(inQuietHours(p, at(22)) && inQuietHours(p, at(7, 59)));
  assert.ok(!inQuietHours(p, at(8)) && !inQuietHours(p, at(18, 59)));
  assert.equal(toasts([n({})], p, at(23)).length, 0);
  const day = prefs({ quiet: { on: true, from: "12:00", to: "14:00" } });
  assert.ok(inQuietHours(day, at(13)) && !inQuietHours(day, at(14)));
});

test("plusieurs messages d'une conversation : une seule notification avec le dernier", () => {
  const out = toasts([n({ text: "un" }), n({ text: "deux" }), n({ text: "trois" })], DEFAULT_PREFS, at(10));
  assert.deepEqual(out, [{ title: "Lucas Bernard", body: "3 nouveaux messages · trois" }]);
});

test("plus de trois conversations : un résumé", () => {
  const many = ["a", "b", "c", "d"].map((id) => n({ threadId: id, conversation: id.toUpperCase(), from: id }));
  const [only, ...rest] = toasts(many, DEFAULT_PREFS, at(10));
  assert.equal(rest.length, 0);
  assert.equal(only.title, "4 nouveaux messages");
});

test("présentation en cours : le texte est masqué", () => {
  assert.deepEqual(toasts([n({})], DEFAULT_PREFS, at(10), true), [{ title: "Lucas Bernard", body: "Nouveau message" }]);
  assert.deepEqual(toasts([n({}), n({})], DEFAULT_PREFS, at(10), true), [{ title: "Lucas Bernard", body: "2 nouveaux messages" }]);
});

// node --test tests/ : le catalogue d'emoji (src/data/emoji.json) et ses outils.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeCatalog, drawable, reactionKey, searchEmoji, withTone, type EmojiCatalogData } from "../src/lib/emoji.ts";

const raw = JSON.parse(readFileSync(new URL("../src/data/emoji.json", import.meta.url), "utf8")) as EmojiCatalogData;
const { groups, emoji } = decodeCatalog(raw);
const find = (e: string) => emoji.find((x) => x.emoji === e)!;

test("le catalogue couvre toute la bibliothèque Unicode, par groupe", () => {
  assert.equal(groups.length, 9);
  assert.equal(groups[0], "Smileys et émotions");
  assert.ok(emoji.length > 1800, `${emoji.length} emoji`);
  assert.equal(new Set(emoji.map((e) => e.emoji)).size, emoji.length);
  for (const e of ["😀", "🇫🇷", "👨‍💻", "🏳️‍🌈", "1️⃣", "🫡"]) assert.ok(find(e), e);
});

test("chaque emoji que Teams connaît porte sa clé de réaction Teams", () => {
  assert.equal(find("👍").teamsKey, "like");
  assert.equal(find("❤️").teamsKey, "heart");
  assert.equal(find("🚀").teamsKey, "launch");
  assert.equal(find("😶‍🌫️").teamsKey, "faceinclouds");
  assert.equal(find("🫰").teamsKey, "fingerheart");
  assert.equal(find("💯").teamsKey, "1f4af_hundredpointssymbol");
  // Teams n'a pas de drapeaux : insérable dans un message, pas en réaction.
  assert.equal(find("🇫🇷").teamsKey, "");
  for (const e of emoji) if (e.teamsKey) assert.match(e.teamsKey, /^[a-z0-9][a-z0-9_-]{0,63}$/);
});

test("la teinte de peau s'applique au caractère et à la clé Teams quand ils la prennent", () => {
  const wave = find("👋");
  assert.equal(withTone(wave, 0), "👋");
  assert.equal(withTone(wave, 3), "👋🏽");
  assert.equal(reactionKey(wave, 0), "hi");
  assert.equal(reactionKey(wave, 2), "1f44b_wavinghand-tone2");
  assert.equal(reactionKey(find("👍"), 1), "yes-tone1");
  const rocket = find("🚀");
  assert.equal(withTone(rocket, 4), "🚀");
  assert.equal(reactionKey(rocket, 4), "launch");
  assert.equal(reactionKey(find("🇫🇷"), 0), null);
});

test("la recherche se fait en français, sans accents ni casse, par début de mot", () => {
  const names = (q: string) => searchEmoji(emoji, q).map((e) => e.emoji);
  assert.equal(names("fusee")[0], "🚀");
  assert.equal(names("pouce vers le haut")[0], "👍");
  assert.ok(names("Cœur").includes("❤️"));
  assert.ok(names("pouce haut").includes("👍"));
  assert.ok(names("france").includes("🇫🇷"));
  assert.deepEqual(names("zzzz"), []);
  assert.equal(searchEmoji(emoji, "  ").length, emoji.length);
});

test("les emoji que la police ne sait pas dessiner sont écartés, sauf les drapeaux", () => {
  const flags = groups.length - 1;
  const kept = drawable(emoji, flags, () => false);
  assert.ok(kept.some((e) => e.emoji === "🇫🇷"));
  assert.ok(kept.some((e) => e.emoji === "😀"));
  assert.ok(!kept.some((e) => e.emoji === "🫡"));
  assert.equal(drawable(emoji, flags, () => true).length, emoji.length);
});

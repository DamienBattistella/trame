// node --test tests/ : l'extraction texte / liens / cartes du pont Teams (teams-bridge.js),
// exécutée telle quelle sur des fragments relevés dans Teams web (anonymisés).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, type MiniElement } from "./miniDom.ts";

const bridge = readFileSync(new URL("../src-tauri/teams-bridge.js", import.meta.url), "utf8");
const block = bridge.slice(bridge.indexOf("// >>> message-parts"), bridge.indexOf("// <<< message-parts"));
type Parts = {
  text: string;
  links: { text: string; url: string }[];
  cards: { source: string; title: string; url: string; fields: string[] }[];
};
const messageParts = new Function(`${block}\nreturn messageParts;`)() as (root: unknown) => Parts;

const page = parse(readFileSync(new URL("./fixtures/teams-message-cards.html", import.meta.url), "utf8"));
const fixture = (name: string): MiniElement => {
  const find = (el: MiniElement): MiniElement | null => {
    if (el.getAttribute("data-fixture") === name) return el;
    for (const c of el.childNodes) if (c.nodeType === 1) {
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  };
  const box = find(page);
  assert.ok(box, `fixture ${name}`);
  return box.childNodes.find((c): c is MiniElement => c.nodeType === 1)!;
};

test("carte Jira : le texte garde les liens, jamais la carte ni ses boutons", () => {
  const p = messageParts(fixture("jira"));
  assert.equal(p.text, "Deux fiches pour le module :\n[ABC-12] Recherche patient - Jira\n[ABC-13] Création patient - Jira");
  for (const noise of ["Comment", "Edit", "Notify", "Assigned", "OPEN", "|"]) assert.ok(!p.text.includes(noise), noise);
});

test("carte Jira : liens du texte avec leur adresse", () => {
  assert.deepEqual(messageParts(fixture("jira")).links, [
    { text: "[ABC-12] Recherche patient - Jira", url: "https://example.atlassian.net/browse/ABC-12" },
    { text: "[ABC-13] Création patient - Jira", url: "https://example.atlassian.net/browse/ABC-13" },
  ]);
});

test("carte Jira résumée : source, titre, adresse sans suivi, champs sans boutons", () => {
  assert.deepEqual(messageParts(fixture("jira")).cards, [
    {
      source: "Jira",
      title: "ABC-12: Recherche patient",
      url: "https://example.atlassian.net/browse/ABC-12",
      fields: ["Assigned to Alex Martin", "Medium", "OPEN"],
    },
  ]);
});

test("aperçu GitHub : hors du texte, titre générique remplacé par l'adresse courte", () => {
  const p = messageParts(fixture("github"));
  assert.equal(p.text, "Hello,\nConformité — Projet 10\nDans cette page, j'aimerais une case à cocher par exigence. Est-ce envisageable ?");
  assert.ok(!p.text.includes("GitHub is where"));
  assert.deepEqual(p.links, [{ text: "Conformité — Projet 10", url: "https://octo-example-abc123.pages.github.io/conformite/" }]);
  assert.deepEqual(p.cards, [
    { source: "GitHub", title: "octo-example-abc123.pages.github.io/conformite", url: "https://octo-example-abc123.pages.github.io/conformite/", fields: [] },
  ]);
});

test("message simple : mention gardée, adresse en clair, javascript: refusé, Safe Links déballé, <pre> intact", () => {
  const p = messageParts(fixture("plain"));
  assert.equal(
    p.text,
    "Alex Martin tu peux relire https://github.com/example/app/pull/42 ?\nLien piégé : clique, protégé : la doc.\n  ligne 1\n  ligne 2"
  );
  assert.deepEqual(p.links, [{ text: "la doc", url: "https://example.com/doc" }]);
  assert.deepEqual(p.cards, []);
});

test("sans racine : rien", () => {
  assert.deepEqual(messageParts(null), { text: "", links: [], cards: [] });
});

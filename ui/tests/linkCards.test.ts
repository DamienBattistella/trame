// node --test tests/ : liens dont le texte n'est pas l'adresse, et vue des cartes d'aperçu.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkify } from "../src/lib/linkify.ts";
import { cardView } from "../src/lib/linkCards.ts";

const JIRA = "https://example.atlassian.net/browse/ABC-12";
const TEXT = "Deux fiches :\n[ABC-12] Recherche patient - Jira\n[ABC-13] Création patient - Jira";
const LINKS = [
  { text: "[ABC-12] Recherche patient - Jira", url: JIRA },
  { text: "[ABC-13] Création patient - Jira", url: "https://example.atlassian.net/browse/ABC-13" },
];
const links = (text: string, l = LINKS) =>
  linkify(text, l).flatMap((s) => (s.type === "link" ? [[s.text, s.url, s.label]] : []));

test("le texte d'un lien Teams devient cliquable vers sa vraie adresse", () => {
  assert.deepEqual(links(TEXT), [
    ["[ABC-12] Recherche patient - Jira", JIRA, "ABC-12"],
    ["[ABC-13] Création patient - Jira", "https://example.atlassian.net/browse/ABC-13", "ABC-13"],
  ]);
  // Le découpage redonne toujours exactement le texte.
  assert.equal(linkify(TEXT, LINKS).map((s) => s.text).join(""), TEXT);
});

test("adresses en clair et liens nommés ensemble, dans l'ordre, sans chevauchement", () => {
  const text = "Vois https://github.com/org/alliage/pull/4271 et la doc, puis la doc.";
  const segs = links(text, [
    { text: "la doc", url: "https://example.com/doc" },
    { text: "pull/4271", url: "https://example.com/autre" },
  ]);
  assert.deepEqual(segs, [
    ["https://github.com/org/alliage/pull/4271", "https://github.com/org/alliage/pull/4271", "alliage#4271"],
    ["la doc", "https://example.com/doc", "la doc"],
  ]);
});

test("un lien nommé qui pointe vers une PR GitHub garde sa référence (titre et état)", () => {
  const seg = linkify("Relis ma PR stp", [{ text: "ma PR", url: "https://github.com/org/alliage/pull/42" }]).find((s) => s.type === "link");
  assert.ok(seg && seg.type === "link");
  assert.deepEqual(seg.github, { kind: "pr", owner: "org", repo: "alliage", number: 42 });
  assert.equal(seg.label, "ma PR");
});

test("adresse non web ou texte absent : rien de cliquable", () => {
  assert.deepEqual(links("clique ici", [{ text: "clique", url: "javascript:alert(1)" }]), []);
  assert.deepEqual(links("autre texte", LINKS), []);
});

test("carte Jira : titre cliquable, source, assignée et état", () => {
  assert.deepEqual(cardView({ source: "Jira", title: "ABC-12: Recherche patient", url: JIRA, fields: ["Assigned to Alex Martin", "Medium", "OPEN"] }), {
    kind: "jira",
    source: "Jira",
    title: "ABC-12: Recherche patient",
    url: JIRA,
    detail: "Assigned to Alex Martin · OPEN",
  });
});

test("aperçu sans titre : l'adresse courte ; adresse non web : pas de lien", () => {
  const v = cardView({ source: "", title: "", url: "https://www.example.com/page/?utm=1", fields: [] });
  assert.equal(v.kind, "web");
  assert.equal(v.title, "example.com/page");
  assert.equal(v.source, "example.com");
  assert.equal(cardView({ source: "GitHub", title: "PR", url: "javascript:x", fields: [] }).url, null);
  assert.equal(cardView({ source: "GitHub", title: "PR", url: "https://x.github.io/a", fields: [] }).kind, "github");
});

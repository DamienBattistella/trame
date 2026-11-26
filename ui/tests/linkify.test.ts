// node --test tests/ : Node 24 lit le TypeScript tel quel, sans dépendance de test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { githubRef, linkify, linkLabel } from "../src/lib/linkify.ts";

const links = (text: string) => linkify(text).flatMap((s) => (s.type === "link" ? [s.url] : []));

test("plusieurs liens, un par ligne", () => {
  const text = [4271, 4404, 4415, 4640].map((n) => `https://github.com/Dedalus-ERP-PAS/alliage/pull/${n}`).join("\n");
  assert.deepEqual(links(text), text.split("\n"));
  assert.deepEqual(
    linkify(text).map((s) => (s.type === "link" ? s.label : s.text)),
    ["alliage#4271", "\n", "alliage#4404", "\n", "alliage#4415", "\n", "alliage#4640"]
  );
});

test("le découpage redonne exactement le texte", () => {
  const text = "Vois https://a.example/x, puis (https://b.example/y).\nFin « https://c.example/z ».";
  assert.equal(linkify(text).map((s) => s.text).join(""), text);
  for (const s of linkify(text)) assert.equal(text.slice(s.start, s.end), s.text);
});

test("lien au milieu d'une phrase", () => {
  assert.deepEqual(links("Regarde https://example.com/page et dis-moi"), ["https://example.com/page"]);
});

test("ponctuation finale exclue", () => {
  assert.deepEqual(links("Voir https://example.com/a."), ["https://example.com/a"]);
  assert.deepEqual(links("https://example.com/a, https://example.com/b;"), ["https://example.com/a", "https://example.com/b"]);
  assert.deepEqual(links("C'est là : https://example.com/a?!"), ["https://example.com/a"]);
  assert.deepEqual(links("« https://example.com/a »"), ["https://example.com/a"]);
  assert.deepEqual(links("«https://example.com/a»"), ["https://example.com/a"]);
  assert.deepEqual(links("(voir https://example.com/a)."), ["https://example.com/a"]);
});

test("parenthèses équilibrées conservées", () => {
  assert.deepEqual(links("https://fr.wikipedia.org/wiki/Mercure_(planète)"), ["https://fr.wikipedia.org/wiki/Mercure_(planète)"]);
  assert.deepEqual(links("(cf. https://fr.wikipedia.org/wiki/Mercure_(planète))."), ["https://fr.wikipedia.org/wiki/Mercure_(planète)"]);
});

test("accents et encodage conservés", () => {
  const url = "https://exemple.fr/réunion?q=caf%C3%A9&ç=1#ancre";
  assert.deepEqual(links(`Lien : ${url}`), [url]);
});

test("http et majuscules", () => {
  assert.deepEqual(links("HTTP://Example.com/A"), ["HTTP://Example.com/A"]);
  assert.deepEqual(links("http://intranet.local:8080/x"), ["http://intranet.local:8080/x"]);
});

test("seulement http et https", () => {
  assert.deepEqual(links("javascript:alert(1) file:///C:/x ftp://a.b mailto:a@b.c"), []);
  assert.deepEqual(links("xhttps://example.com"), []);
  assert.deepEqual(links("https:// et https://."), []);
});

test("rien à découper sans lien", () => {
  assert.deepEqual(linkify("Bonjour, rien ici."), [{ type: "text", text: "Bonjour, rien ici.", start: 0, end: 18 }]);
  assert.deepEqual(linkify(""), []);
});

test("libellé court GitHub", () => {
  assert.deepEqual(githubRef("https://github.com/Dedalus-ERP-PAS/alliage/pull/4271"), {
    kind: "pr",
    owner: "Dedalus-ERP-PAS",
    repo: "alliage",
    number: 4271,
  });
  assert.equal(linkLabel("https://github.com/acme/portail/issues/12"), "portail#12");
  assert.equal(linkLabel("https://github.com/acme/portail/pull/12/files#diff-1"), "portail#12");
  assert.equal(githubRef("https://github.com/acme/portail/issues/12")?.kind, "issue");
  // Pas une PR : adresse affichée telle quelle.
  assert.equal(linkLabel("https://github.com/acme/portail/pull/12abc"), "https://github.com/acme/portail/pull/12abc");
  assert.equal(linkLabel("https://github.com/acme/portail"), "https://github.com/acme/portail");
  assert.equal(linkLabel("https://evil.com/github.com/a/b/pull/1"), "https://evil.com/github.com/a/b/pull/1");
});

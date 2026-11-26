// node --test tests/ : tableaux Markdown et code en ligne dans un message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksOf, cells, codeSpans } from "../src/lib/blocks.ts";

test("un tableau entre deux paragraphes", () => {
  const text = "Point du jour :\n| Sujet | GitHub | État |\n| --- | :---: | ---: |\n| Préadmission | #4849 | en cours |\n| Date \\| heure | #4645 |\nFin.";
  const b = blocksOf(text);
  assert.equal(b.length, 3);
  assert.deepEqual(b[0], { type: "text", text: "Point du jour :", start: 0 });
  assert.equal(b[1].type, "table");
  if (b[1].type !== "table") return;
  assert.deepEqual(b[1].head, ["Sujet", "GitHub", "État"]);
  assert.deepEqual(b[1].align, [null, "center", "right"]);
  assert.deepEqual(b[1].rows, [
    ["Préadmission", "#4849", "en cours"],
    ["Date | heure", "#4645", ""],
  ]);
  assert.deepEqual(b[2], { type: "text", text: "Fin.", start: text.indexOf("Fin.") });
});

test("pas de tableau sans ligne de séparation, ni avec une seule colonne", () => {
  assert.deepEqual(blocksOf("a | b\nc | d"), [{ type: "text", text: "a | b\nc | d", start: 0 }]);
  assert.equal(blocksOf("| a |\n| --- |\n| b |")[0].type, "text");
  assert.deepEqual(blocksOf(""), []);
});

test("tableau seul, sans barres de bord", () => {
  const b = blocksOf("A | B\n--- | ---\n1 | 2");
  assert.equal(b.length, 1);
  assert.equal(b[0].type, "table");
});

test("cellules", () => {
  assert.deepEqual(cells("| a | `b` |"), ["a", "`b`"]);
  assert.deepEqual(cells("a|b|c"), ["a", "b", "c"]);
});

test("code en ligne", () => {
  assert.deepEqual(codeSpans("conflit avec `main` ici"), [
    { code: false, text: "conflit avec " },
    { code: true, text: "main" },
    { code: false, text: " ici" },
  ]);
  assert.deepEqual(codeSpans("pas de `code"), [{ code: false, text: "pas de `code" }]);
});

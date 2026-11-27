// node --test tests/ : différences entre deux versions du SOUL.md, resserrées autour des changements.
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, foldDiff } from "../src/lib/persona.ts";

test("lignes ajoutées et retirées", () => {
  const d = diffLines("a\nb\nc", "a\nB\nc\nd");
  assert.deepEqual(
    d.map((x) => `${x.kind}:${x.text}`),
    ["same:a", "del:b", "add:B", "same:c", "add:d"],
  );
});

test("les lignes identiques loin des changements sont repliées", () => {
  const before = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
  const after = before.replace("l8", "L8");
  const rows = foldDiff(diffLines(before, after), 1);
  assert.deepEqual(rows[0], { kind: "skip", count: 7 });
  assert.deepEqual(
    rows.slice(1).map((r) => ("text" in r ? `${r.kind}:${r.text}` : r.kind)),
    ["same:l7", "del:l8", "add:L8", "same:l9"],
  );
});

test("aucune différence : tout est replié", () => {
  assert.deepEqual(foldDiff(diffLines("a\nb", "a\nb")), [{ kind: "skip", count: 2 }]);
});

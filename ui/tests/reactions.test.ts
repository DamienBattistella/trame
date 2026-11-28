// node --test tests/ : l'image d'une émoticône Teams sans équivalent Unicode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reactionGlyph, teamsEmoticonUrl } from "../src/types.ts";

test("une émoticône Teams sans emoji pointe vers l'image servie par Teams", () => {
  assert.equal(reactionGlyph("faceinclouds", ""), ":faceinclouds:");
  assert.equal(
    teamsEmoticonUrl("faceinclouds"),
    "https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/v2/assets/emoticons/faceinclouds/default/30_f.png",
  );
});

test("une clé de réaction ne sort pas du chemin de l'émoticône", () => {
  assert.ok(teamsEmoticonUrl("a/../b").includes("/emoticons/a%2F..%2Fb/default/"));
});

#!/usr/bin/env node
// Nouveautés de Trame, tirées des commits Conventional Commits entre tags vX.Y.Z.
// Usage : node .github/scripts/changelog.mjs [--next 1.2.3] [--out ui/src/changelog.json]
// --next : version en cours de publication (commits depuis le dernier tag).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const next = arg("--next");
const out = arg("--out") ?? "ui/src/changelog.json";
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

const TYPES = { feat: "feat", fix: "fix", perf: "perf" };
const SEP = "\u001e";
const FIELD = "\u001f";

function entries(range) {
  const raw = git("log", "--no-merges", `--format=%s${FIELD}%b${SEP}`, ...(range ? [range] : []));
  const items = { feat: [], fix: [], perf: [] };
  for (const chunk of raw.split(SEP)) {
    const [subject = "", body = ""] = chunk.trim().split(FIELD);
    const m = subject.match(/^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/);
    if (!m || !TYPES[m[1]]) continue;
    const title = m[4].charAt(0).toUpperCase() + m[4].slice(1);
    const details = [];
    for (const line of body.split("\n")) {
      if (/^co-authored-by:/i.test(line.trim())) continue;
      if (/^\s*[-*]\s+/.test(line)) details.push(line.replace(/^\s*[-*]\s+/, "").trim());
      else if (/^\s{2,}\S/.test(line) && details.length) details[details.length - 1] += " " + line.trim();
    }
    items[TYPES[m[1]]].push({ title, details });
  }
  return items;
}

const tags = git("tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=v:refname").split("\n").filter(Boolean);
const releases = [];
let prev;
for (const tag of tags) {
  releases.push({ version: tag.slice(1), date: git("log", "-1", "--format=%cs", tag), ...entries(prev ? `${prev}..${tag}` : tag) });
  prev = tag;
}
if (next && !tags.includes(`v${next}`)) {
  releases.push({ version: next, date: new Date().toISOString().slice(0, 10), ...entries(prev ? `${prev}..HEAD` : "HEAD") });
}
const kept = releases.reverse().filter((r) => r.feat.length + r.fix.length + r.perf.length > 0);
writeFileSync(out, JSON.stringify(kept, null, 2) + "\n");
console.log(`${out} : ${kept.length} versions`);

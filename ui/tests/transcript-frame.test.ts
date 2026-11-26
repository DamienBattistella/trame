// L'agent de teams-bridge.js dans l'iframe SharePoint de la transcription, joué sur une
// page anonymisée (tests/fixtures/stream-transcript.html) dans un mini-DOM : liste
// virtualisée, défilement, protocole postMessage avec la page Teams. Sans dépendance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const BRIDGE = readFileSync(new URL("../src-tauri/teams-bridge.js", import.meta.url), "utf8");
const FIXTURE = readFileSync(new URL("./fixtures/stream-transcript.html", import.meta.url), "utf8");
const TEAMS = "https://teams.microsoft.com";
const ROW = 60; // hauteur d'une cellule
const VIEW = 300; // hauteur visible de la liste

// --- mini-DOM : juste ce que l'agent utilise ---------------------------------------
class El {
  tag: string;
  attrs: Record<string, string>;
  children: any[] = [];
  parentElement: El | null = null;
  scrollTop = 0;
  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tag = tag;
    this.attrs = attrs;
  }
  get tagName() {
    return this.tag.toUpperCase();
  }
  get id() {
    return this.attrs.id || "";
  }
  get className() {
    return this.attrs.class || "";
  }
  getAttribute(n: string) {
    return n in this.attrs ? this.attrs[n] : null;
  }
  append(c: any) {
    if (c instanceof El) c.parentElement = this;
    this.children.push(c);
  }
  clone(): El {
    const e = new El(this.tag, { ...this.attrs });
    for (const c of this.children) e.append(c instanceof El ? c.clone() : c);
    return e;
  }
  // Liste virtualisée : seules les cellules proches de la zone visible sont « dessinées ».
  rendered(): boolean {
    const idx = this.attrs["data-list-index"];
    if (idx === undefined) return true;
    const box = scrollBox(this);
    const first = Math.floor(box.scrollTop / ROW) - 1;
    const last = Math.ceil((box.scrollTop + VIEW) / ROW) + 1;
    return Number(idx) >= first && Number(idx) <= last;
  }
  *walk(): Generator<El> {
    for (const c of this.children) {
      if (!(c instanceof El) || !c.rendered()) continue;
      yield c;
      yield* c.walk();
    }
  }
  querySelectorAll(sel: string) {
    const parts = sel.split(",").map((s) => s.trim());
    return Array.from(this.walk()).filter((e) => parts.some((p) => matches(e, p)));
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] || null;
  }
  get innerText(): string {
    const block = /^(div|p|li|section|body)$/.test(this.tag);
    const inner = this.children
      .map((c) => (c instanceof El ? (c.rendered() ? c.innerText : "") : c))
      .join("");
    return block ? `${inner}\n` : inner;
  }
  get scrollHeight() {
    return this.attrs.style?.includes("overflow-y:auto") ? cellCount(this) * ROW : 0;
  }
  get clientHeight() {
    return this.attrs.style?.includes("overflow-y:auto") ? VIEW : 0;
  }
}
const scrollBox = (e: El): El => {
  for (let p: El | null = e; p; p = p.parentElement) if (p.attrs.style?.includes("overflow-y:auto")) return p;
  throw new Error("pas de boîte de défilement");
};
const cellCount = (box: El) => {
  let n = 0;
  const count = (e: El) => e.children.forEach((c) => c instanceof El && (c.attrs["data-list-index"] !== undefined ? n++ : count(c)));
  count(box);
  return n;
};
// Sélecteurs simples, sans combinateur : tag, #id, .classe, [a], [a="v"], [a^="v"], [a*="v" i].
const matches = (e: El, sel: string): boolean => {
  const re = /^([a-z]+)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\])*)$/i;
  if (sel === "*") return true;
  const m = sel.match(re);
  if (!m) throw new Error(`sélecteur non géré : ${sel}`);
  if (m[1] && m[1].toLowerCase() !== e.tag) return false;
  for (const part of m[2].match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) || []) {
    if (part[0] === "#" && e.id !== part.slice(1)) return false;
    if (part[0] === "." && !e.className.split(/\s+/).includes(part.slice(1))) return false;
    if (part[0] === "[") {
      const a = part.slice(1, -1).match(/^([\w-]+)(?:([\^*]?)="([^"]*)"(\s+i)?)?$/);
      if (!a) throw new Error(`attribut non géré : ${part}`);
      const v = e.getAttribute(a[1]);
      if (v === null) return false;
      if (a[2] === undefined) continue;
      const [have, want] = a[4] ? [v.toLowerCase(), a[3].toLowerCase()] : [v, a[3]];
      if (a[2] === "" && have !== want) return false;
      if (a[2] === "^" && !have.startsWith(want)) return false;
      if (a[2] === "*" && !have.includes(want)) return false;
    }
  }
  return true;
};
const parse = (html: string): El => {
  const body = new El("body");
  const stack = [body];
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/>\s+</g, "><").trim();
  for (const tok of clean.match(/<\/?[a-z][^>]*>|[^<]+/gi) || []) {
    if (tok.startsWith("</")) stack.pop();
    else if (tok.startsWith("<")) {
      const [, tag, rest] = tok.match(/^<([a-z]+)(.*?)\/?>$/i)!;
      const attrs: Record<string, string> = {};
      for (const [, k, v] of rest.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[k] = v;
      const el = new El(tag.toLowerCase(), attrs);
      stack[stack.length - 1].append(el);
      stack.push(el);
    } else stack[stack.length - 1].append(tok);
  }
  return body;
};

// Ajoute des prises de parole fictives (cellules clonées) pour une liste longue.
const grow = (body: El, extra: number) => {
  const page = body.querySelector(".ms-List-page")!;
  const model = page.children[page.children.length - 1] as El;
  for (let i = 0; i < extra; i++) {
    const idx = 4 + i;
    const cell = model.clone();
    cell.attrs["data-list-index"] = String(idx);
    const set = (e: El) => {
      if (e.attrs.id) e.attrs.id = e.attrs.id.replace(/-\d+$/, `-${idx}`);
      if (e.attrs.id === `Header-timestamp-${idx}`) e.children = [`${Math.floor((70 + idx * 7) / 60)}:${String((70 + idx * 7) % 60).padStart(2, "0")}`];
      if (e.attrs.id === `sub-entry-${idx}`) e.children = [`Phrase numéro ${idx}.`];
      e.children.forEach((c) => c instanceof El && set(c));
    };
    set(cell);
    page.append(cell);
  }
};

// --- une iframe SharePoint où l'on injecte teams-bridge.js ---------------------------
const frame = (opts: { host?: string; ancestors?: string[]; html?: string; extra?: number } = {}) => {
  const body = parse(opts.html ?? FIXTURE);
  if (opts.extra) grow(body, opts.extra);
  const listeners: Function[] = [];
  const posted: any[] = [];
  const parent = { postMessage: (data: any, origin: string) => posted.push({ data, origin }) };
  const ctx: any = {
    location: {
      hostname: opts.host ?? "exemple-my.sharepoint.com",
      pathname: "/personal/sofia_marino_exemple_fr/_layouts/15/xplatplugins.aspx",
      ancestorOrigins: opts.ancestors ?? [TEAMS],
    },
    document: { body, querySelectorAll: (s: string) => body.querySelectorAll(s), querySelector: (s: string) => body.querySelector(s) },
    getComputedStyle: (e: El) => ({ overflowY: e.attrs.style?.includes("overflow-y:auto") ? "auto" : "visible" }),
    setTimeout: (fn: Function) => setImmediate(fn as any),
    addEventListener: (type: string, fn: Function) => type === "message" && listeners.push(fn),
    parent,
    top: {},
  };
  ctx.window = ctx;
  vm.runInNewContext(BRIDGE, ctx);
  const ask = async (data: any, from: { source?: any; origin?: string } = {}) => {
    const before = posted.length;
    await Promise.all(listeners.map((fn) => fn({ data, source: from.source ?? parent, origin: from.origin ?? TEAMS })));
    return posted.slice(before).map((p) => JSON.parse(JSON.stringify(p.data)));
  };
  return { ask, posted, listeners, body };
};

test("relit toute la transcription : orateurs, horodatages, suites, événement écarté", async () => {
  const f = frame();
  const out = await f.ask({ trame: "trame-transcript", nonce: "n1", mode: "collect", budget_ms: 20000 });
  assert.deepEqual(out[0], { trame: "trame-transcript-ack", nonce: "n1" });
  const res = out[1];
  assert.equal(res.trame, "trame-transcript-result");
  assert.equal(res.nonce, "n1");
  assert.equal(res.ok, true);
  assert.equal(res.complete, true);
  assert.equal(res.gaps, 0);
  assert.equal(res.owner, "sofia_marino_exemple_fr");
  assert.deepEqual(res.entries, [
    { speaker: "Sofia Marino", time: "0:16", text: "Bonjour à tous, on fait le point sur la reprise des données." },
    { speaker: "", time: "", text: "Les tests de non-régression passent depuis ce matin." },
    { speaker: "Chloé Évrard", time: "1:02", text: "D'accord, et côté sécurité : rien à signaler ?" },
  ]);
});

test("liste virtualisée longue : chaque entrée une seule fois, dans l'ordre, défilement remis", async () => {
  const f = frame({ extra: 120 });
  const box = f.body.querySelector("#scrollToTargetTargetedFocusZone")!;
  box.scrollTop = 600;
  const [, res] = await f.ask({ trame: "trame-transcript", nonce: "n2", mode: "collect", budget_ms: 20000 });
  assert.equal(res.complete, true);
  assert.equal(res.entries.length, 3 + 120);
  assert.equal(res.entries[res.entries.length - 1].text, "Phrase numéro 123.");
  assert.deepEqual(
    res.entries.slice(3).map((e: any) => e.text),
    Array.from({ length: 120 }, (_, i) => `Phrase numéro ${i + 4}.`),
  );
  assert.equal(box.scrollTop, 600);
});

test("n'écoute que la page Teams qui contient directement l'iframe", async () => {
  const req = { trame: "trame-transcript", nonce: "n3", mode: "collect" };
  assert.deepEqual(await frame().ask(req, { origin: "https://evil.example" }), []);
  assert.deepEqual(await frame().ask(req, { source: {} }), []);
  assert.deepEqual(await frame({ ancestors: ["https://exemple.sharepoint.com", TEAMS] }).ask(req), []);
  assert.deepEqual(await frame().ask({ trame: "autre", nonce: "n3" }), []);
  // Hors SharePoint, le script ne fait rien du tout.
  assert.equal(frame({ host: "exemple.com" }).listeners.length, 0);
});

test("accès refusé et transcription absente sont dits clairement", async () => {
  const denied = frame({ html: "<div><p>Vous n'avez pas accès à ce fichier.</p></div>" });
  const [, d] = await denied.ask({ trame: "trame-transcript", nonce: "d", mode: "collect", budget_ms: 3000 });
  assert.deepEqual({ ok: d.ok, reason: d.reason }, { ok: false, reason: "denied" });
  const none = frame({ html: "<div><p>Aucune transcription pour cette réunion.</p></div>" });
  const [, n] = await none.ask({ trame: "trame-transcript", nonce: "e", mode: "collect", budget_ms: 3000 });
  assert.equal(n.reason, "none");
});

test("le diagnostic décrit la page sans jamais en rendre le texte", async () => {
  const f = frame();
  const [, res] = await f.ask({ trame: "trame-transcript", nonce: "p", mode: "probe" });
  const dump = JSON.stringify(res.probe);
  assert.equal(res.probe.cells, 4);
  assert.match(res.probe.cell_path[0], /^div\.ms-List-cell/);
  assert.ok(!/Bonjour|régression|sécurité|Sofia|Chloé/.test(dump.replace(/Télécharger/g, "")), dump);
  assert.ok(!dump.includes("sofia_marino"));
});

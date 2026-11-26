// « Nouvelle conversation » de teams-bridge.js, jouée dans une fausse page Teams : le
// bouton « Nouveau message », le champ « À », la zone de saisie, et la frappe réelle de
// l'application (teams_type_trusted), qui va là où est le focus. Teams web, à l'ouverture
// de « Nouveau message », place lui-même le focus un instant après le clic. Sans dépendance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const BRIDGE = readFileSync(new URL("../src-tauri/teams-bridge.js", import.meta.url), "utf8");

class FakeEl {
  attrs: Record<string, string>;
  value = "";
  text = "";
  shown = true;
  doc: any;
  constructor(doc: any, attrs: Record<string, string>) {
    this.doc = doc;
    this.attrs = attrs;
  }
  get tagName() {
    return (this.attrs.tag || "div").toUpperCase();
  }
  get innerText() {
    return this.text;
  }
  getAttribute(n: string) {
    return n in this.attrs ? this.attrs[n] : null;
  }
  getClientRects() {
    return this.shown ? [{}] : [];
  }
  matches() {
    return false; // jamais le champ de recherche
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  focus() {
    if (this.attrs.focusable !== "no") this.doc.activeElement = this;
  }
  click() {
    this.attrs.onclick && this.doc.handlers[this.attrs.onclick]?.();
  }
  dispatchEvent(e: any) {
    if (e.type === "keydown" && e.key === "Escape") this.doc.escapes++;
    return true;
  }
  scrollIntoView() {}
}

type Options = { stealFocus?: "once" | "always"; replaceField?: boolean; person?: string; opens?: string };

function page(opts: Options = {}) {
  const doc: any = { title: "Conversation | Marc Durand | Microsoft Teams", escapes: 0, handlers: {}, body: null };
  const button = new FakeEl(doc, { tag: "button", "data-testid": "simple-collab-left-rail-header-new-message-button", onclick: "new" });
  const editor = new FakeEl(doc, { "data-tid": "ckeditor", role: "textbox", contenteditable: "true" });
  let field: FakeEl | null = null;
  const makeField = () => {
    const f = new FakeEl(doc, { tag: "input", id: "people-picker-input", role: "combobox", "aria-controls": "picker" });
    if (opts.stealFocus === "always") f.attrs.focusable = "no";
    return f;
  };
  // Une seule personne proposée ; la choisir ouvre sa conversation.
  const person = new FakeEl(doc, { role: "option", "aria-label": opts.person || "Hug de la Rauze, Ingénierie", onclick: "pick" });
  doc.handlers.pick = () => (doc.title = `Conversation | ${opts.opens || "Hug de la Rauze"} | Microsoft Teams`);
  doc.handlers.new = () => {
    doc.title = "Conversation | Nouveau message | Microsoft Teams";
    field = makeField();
    // Teams donne le focus à la zone de saisie un instant après.
    if (opts.stealFocus) setTimeout(() => (doc.activeElement = editor), 50);
  };
  doc.activeElement = null;
  doc.hasFocus = () => true;
  doc.getElementById = (id: string) =>
    id === "picker" && field ? { querySelectorAll: () => (field && field.value ? [person] : []) } : null;
  doc.querySelector = (sel: string) => doc.querySelectorAll(sel)[0] || null;
  doc.querySelectorAll = (sel: string) => {
    if (sel.includes("new-message-button")) return [button];
    if (sel.includes("people-picker") || sel.includes("chat-with")) return field ? [field] : [];
    if (sel.includes("ckeditor")) return [editor];
    return [];
  };
  const typed: string[] = [];
  const invoke = async (cmd: string, args: any) => {
    if (cmd !== "teams_type_trusted") return;
    typed.push(args.text);
    // La frappe réelle, une touche après l'autre, va dans l'élément qui a le focus.
    for (const ch of args.text as string) {
      const el = doc.activeElement;
      if (!el) continue;
      if (el === field) el.value += ch;
      else el.text += ch;
      // Teams remplace le champ « À » à la première touche (nouvel élément, même valeur).
      if (opts.replaceField && el === field && field.value.length === 1) {
        const next = makeField();
        next.value = field.value;
        field.shown = false;
        field = next;
        doc.activeElement = next;
      }
    }
  };
  class Ev {
    type: string;
    key?: string;
    constructor(type: string, init: any = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  }
  const window: any = {
    document: doc,
    location: { hostname: "teams.cloud.microsoft" },
    __TAURI_INTERNALS__: { invoke },
    setTimeout,
    clearTimeout,
    KeyboardEvent: Ev,
    Event: Ev,
    MouseEvent: Ev,
    PointerEvent: Ev,
    HTMLInputElement: { prototype: Object.defineProperty({}, "value", { set(this: any, v: string) { this.value = v; } }) },
    getComputedStyle: () => ({ overflowY: "visible" }),
    NodeFilter: { SHOW_TEXT: 4 },
  };
  window.window = window;
  window.top = window;
  vm.createContext(window);
  vm.runInContext(BRIDGE, window);
  const replies: any[] = [];
  invokeHook(window, replies);
  return { window, doc, editor, typed, replies, field: () => field };
}

function invokeHook(window: any, replies: any[]) {
  const base = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
    if (cmd === "teams_bridge_reply") replies.push(args.payload);
    return base(cmd, args);
  };
}

async function newchat(p: ReturnType<typeof page>, name: string) {
  await p.window.__trame.run({ id: "1", op: "newchat", args: { name } });
  const r = p.replies.find((x) => x.id === "1");
  assert.ok(r?.ok, `opération en erreur : ${r?.error}`);
  return r.result;
}

test("le nom va dans le champ « À » même quand Teams met le focus sur la zone de saisie", async () => {
  const p = page({ stealFocus: "once" });
  const res = await newchat(p, "Hug de la Rauze");
  assert.equal(p.field()?.value, "Hug de la Rauze");
  assert.equal(p.editor.text, "", "rien ne doit être tapé dans la zone de saisie");
  assert.equal(res.ok, true);
  assert.match(res.title, /Hug de la Rauze/);
});

test("le champ « À » relu après la frappe, même si Teams l'a remplacé", async () => {
  const p = page({ replaceField: true });
  const res = await newchat(p, "Hug de la Rauze");
  assert.equal(p.field()?.value, "Hug de la Rauze");
  assert.equal(res.ok, true, res.error);
});

test("sans focus possible dans le champ « À », rien n’est tapé", async () => {
  const p = page({ stealFocus: "always" });
  const res = await newchat(p, "Hug de la Rauze");
  assert.equal(res.ok, false);
  assert.match(res.error, /ne prend pas le focus \(focus sur div role=textbox data-tid=ckeditor\)/);
  assert.deepEqual(p.typed, [], "aucune frappe");
  assert.equal(p.editor.text, "");
  assert.ok(p.doc.escapes >= 1, "« Nouveau message » refermé");
});

test("sa propre conversation : la suggestion « Nom (Vous), Service » de Teams", async () => {
  // Libellé relevé sur la vraie page (fixtures/teams/newchat.html), nom fictif.
  const p = page({ person: "Ana Lopez (Vous), Ingénierie", opens: "Ana Lopez (Vous)" });
  const res = await newchat(p, "Ana Lopez");
  assert.equal(res.ok, true, res.error);
});

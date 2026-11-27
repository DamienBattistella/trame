// node --test tests/ : conversion d'un message du service de chat de Teams (teams-bridge.js,
// bloc chat-message) vers la forme de la lecture de la page, avec le même extracteur de texte
// (bloc message-parts). Messages construits sur le format réel de chatsvc (anonymisés).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bridge = readFileSync(new URL("../src-tauri/teams-bridge.js", import.meta.url), "utf8");
const between = (a: string, b: string) => bridge.slice(bridge.indexOf(a), bridge.indexOf(b));
const parts = between("// >>> message-parts", "// <<< message-parts");
const chat = between("// >>> chat-message", "// <<< chat-message");
const { messageParts, chatMessage } = new Function(`${parts}\n${chat}\nreturn { messageParts, chatMessage };`)();

const ME = "8:orgid:11111111-2222-3333-4444-555555555555";
const NOW = new Date(2026, 10, 27, 15, 0);
// L'analyseur HTML du pont lui-même (la page Teams refuse DOMParser : Trusted Types).
const convert = (raw: any) => chatMessage.convert(raw, ME, chatMessage.parseHtml, messageParts, NOW);
const at = (d: Date) => d.toISOString();

const base = {
  id: "1795777000001",
  messagetype: "RichText/Html",
  imdisplayname: "Ana Martin",
  originalarrivaltime: at(new Date(2026, 10, 27, 10, 54)),
  properties: {},
};

test("texte, lien et mention : même extraction que la lecture de la page", () => {
  const m = convert({
    ...base,
    content:
      '<p>Bonjour <span itemscope="" itemtype="http://schema.skype.com/Mention" itemid="0">Damien</span>, voir ' +
      '<a href="https://jira.example.com/browse/H-1" title="https://jira.example.com/browse/H-1">H-1</a></p><p>Merci&nbsp;!</p>',
  });
  assert.equal(m.sender, "Ana Martin");
  assert.equal(m.id, "1795777000001");
  assert.match(m.text, /^Bonjour Damien, voir H-1\nMerci !$/);
  assert.deepEqual(m.links, [{ text: "H-1", url: "https://jira.example.com/browse/H-1" }]);
  assert.equal(m.at, "10:54");
});

test("heure affichée comme dans Teams : aujourd'hui, hier, date", () => {
  assert.equal(convert({ ...base, content: "x", originalarrivaltime: at(new Date(2026, 10, 26, 9, 5)) }).at, "Hier 09:05");
  // Cette semaine : le jour, comme Teams (« mardi 10:36 »).
  assert.equal(convert({ ...base, content: "x", originalarrivaltime: at(new Date(2026, 10, 24, 10, 36)) }).at, "mardi 10:36");
  assert.equal(convert({ ...base, content: "x", originalarrivaltime: at(new Date(2026, 10, 18, 16, 0)) }).at, "18/11 16:00");
  assert.equal(convert({ ...base, content: "x", originalarrivaltime: at(new Date(2025, 0, 3, 8, 0)) }).at, "03/01/2025 08:00");
});

test("images AMS repérées sans polluer le texte ; fichiers joints lus dans les propriétés", () => {
  const m = convert({
    ...base,
    content:
      '<p>Regarde</p><p><img src="https://eu-api.asm.skype.com/v1/objects/0-weu-d1-abc/views/imgo" ' +
      'itemtype="http://schema.skype.com/AMSImage" width="250" height="140" alt="image"></p>',
    properties: {
      files: JSON.stringify([{ fileName: "plan.pdf", objectUrl: "https://dedalus.sharepoint.com/sites/x/plan.pdf" }]),
    },
  });
  assert.equal(m.text, "Regarde");
  assert.deepEqual(m.images, ["https://eu-api.asm.skype.com/v1/objects/0-weu-d1-abc/views/imgo"]);
  assert.deepEqual(m.files, [{ name: "plan.pdf", url: "https://dedalus.sharepoint.com/sites/x/plan.pdf" }]);
});

test("réactions : seules les MIENNES, et seulement les quatre de Trame", () => {
  const m = convert({
    ...base,
    content: "ok",
    properties: {
      emotions: JSON.stringify([
        { key: "like", users: [{ mri: ME, time: 1 }] },
        { key: "heart", users: [{ mri: "8:orgid:autre", time: 2 }] },
        { key: "angry", users: [{ mri: ME, time: 3 }] },
      ]),
    },
  });
  assert.deepEqual(m.reactions, ["like"]);
});

test("message supprimé : le texte que Teams affiche, rien d'autre", () => {
  const m = convert({ ...base, content: "", properties: { deletetime: "1795777009999", files: '[{"fileName":"x.pdf"}]' } });
  assert.equal(m.text, "Ce message a été supprimé.");
  assert.deepEqual([m.files, m.images, m.links, m.reactions], [[], [], [], []]);
});

test("aperçu de lien du service de chat → carte (titre + adresse)", () => {
  const m = convert({
    ...base,
    content: '<p><a href="https://github.com/o/r/pull/1">https://github.com/o/r/pull/1</a></p>',
    properties: { links: JSON.stringify([{ url: "https://github.com/o/r/pull/1", preview: { title: "Fix parser" } }]) },
  });
  assert.deepEqual(m.cards, [{ source: "github.com", title: "Fix parser", url: "https://github.com/o/r/pull/1", fields: [] }]);
});

test("événements du fil ignorés, messages écrits gardés", () => {
  assert.equal(chatMessage.isUser({ messagetype: "RichText/Html" }), true);
  assert.equal(chatMessage.isUser({ messagetype: "Text" }), true);
  assert.equal(chatMessage.isUser({ messagetype: "ThreadActivity/AddMember" }), false);
  assert.equal(chatMessage.isUser({ messagetype: "Event/Call" }), false);
  assert.equal(chatMessage.isUser({}), false);
});

test("analyseur HTML inerte : entités, balises mal fermées, commentaires, « < » isolé", () => {
  const root = chatMessage.parseHtml('<p>a &lt;b&gt; &#233;t&eacute; <b>gras<i>x</p><!-- c --><p>1 < 2</p>');
  const m = messageParts(root);
  // &eacute; n'est pas dans la petite table : laissé tel quel, jamais interprété.
  assert.equal(m.text, "a <b> ét&eacute; grasx\n1 < 2");
  // Aucun nœud réel : un simple arbre d'objets (rien n'est chargé ni exécuté).
  assert.equal(typeof root.getAttribute, "function");
  assert.equal(root.childNodes[0].tagName, "P");
});

test("citation (Répondre) : auteur, heure du message cité, extrait — comme la page", () => {
  const quoted = new Date(2026, 10, 5, 14, 2).getTime();
  const m = convert({
    ...base,
    content:
      `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="${quoted}">` +
      `<strong itemprop="mri" itemid="8:orgid:abc">Paul Durand</strong><span itemprop="time" itemid="${quoted}"></span>` +
      `<p itemprop="preview">Le point de jeudi</p></blockquote><p>D'accord pour moi</p>`,
  });
  // La citation sort du texte : rendue à part, comme dans Teams.
  assert.equal(m.text, "D'accord pour moi");
  assert.deepEqual(m.quote, { sender: "Paul Durand", at: "05/11/2026 14:02", text: "Le point de jeudi" });
  assert.equal(m.edited, false);
});

test("mentions : nom complet recollé quand Teams le découpe par mot", () => {
  const m = convert({
    ...base,
    content:
      '<p><span itemscope="" itemtype="http://schema.skype.com/Mention" itemid="0">Alex</span>&nbsp;' +
      '<span itemscope="" itemtype="http://schema.skype.com/Mention" itemid="1">Martin</span> et ' +
      '<span itemscope="" itemtype="http://schema.skype.com/Mention" itemid="2">Lou</span>, vous validez ?</p>',
  });
  assert.equal(m.text, "Alex Martin et Lou, vous validez ?");
  assert.deepEqual(m.mentions, ["Alex Martin", "Lou"]);
  assert.equal(m.quote, null);
});

test("message modifié : repéré par edittime, jamais sur un message supprimé", () => {
  assert.equal(convert({ ...base, content: "v2", properties: { edittime: "1795777009999" } }).edited, true);
  assert.equal(convert({ ...base, content: "v1" }).edited, false);
  assert.equal(convert({ ...base, content: "", properties: { edittime: "1", deletetime: "2" } }).edited, false);
});

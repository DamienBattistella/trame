// node --test tests/ : les pièces jointes d'un message du fil, lues par le pont Teams
// (teams-bridge.js) pour la lecture et pour la preuve d'envoi, exécutées telles quelles sur
// des messages relevés dans Teams web (anonymisés). Une image jointe s'affiche en vignette :
// son nom n'est jamais dans le texte visible, d'où l'ancien faux « Envoi non confirmé ».
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, type MiniElement, type MiniNode } from "./miniDom.ts";

const bridge = readFileSync(new URL("../src-tauri/teams-bridge.js", import.meta.url), "utf8");
const block = bridge.slice(bridge.indexOf("// >>> message-files"), bridge.indexOf("// <<< message-files"));
type MessageFiles = {
  filesOf: (root: unknown) => { name: string; url: string }[];
  imagesOf: (root: unknown) => unknown[];
  missing: (wanted: string[], roots: unknown[]) => string[];
  sameFile: (wanted: string, label: string) => boolean;
};
const files = new Function(`${block}\nreturn messageFiles;`)() as MessageFiles;

const page = parse(readFileSync(new URL("./fixtures/teams-message-files.html", import.meta.url), "utf8"));
const message = (name: string): MiniElement => {
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
// Ce que donnait innerText, sur quoi reposait l'ancienne preuve.
const visibleText = (n: MiniNode): string => (n.nodeType === 3 ? n.data : n.childNodes.map(visibleText).join(" "));

test("image seule : son nom n'est pas dans le texte visible, mais la carte le porte", () => {
  const el = message("image-alone");
  assert.ok(!visibleText(el).includes("capture-20261126-182223.png"));
  assert.deepEqual(files.filesOf(el), [{ name: "capture-20261126-182223.png", url: "" }]);
  assert.deepEqual(files.missing(["capture-20261126-182223.png"], [el]), []);
});

test("image renvoyée et renommée « nom 1.png » par OneDrive : reconnue", () => {
  const el = message("image-renamed");
  assert.deepEqual(files.missing(["capture-20261126-182223.png"], [el]), []);
  assert.ok(files.sameFile("rapport.pdf", "rapport (1).pdf"));
  assert.ok(files.sameFile("Écran.PNG", "ecran 2.png"));
  assert.ok(files.sameFile("capture.png", "Image capture.png, 102 Ko"));
});

test("un autre fichier n'est pas pris pour celui envoyé", () => {
  const el = message("image-alone");
  assert.deepEqual(files.missing(["capture.png"], [el]), ["capture.png"]);
  assert.deepEqual(files.missing(["capture-20261126-18222.png"], [el]), ["capture-20261126-18222.png"]);
  assert.ok(!files.sameFile("capture.png", "capture.png.exe"));
  assert.ok(!files.sameFile("capture.png", "autre-capture.png"));
  assert.ok(!files.sameFile("capture.png", "capture 12345.png"));
});

test("texte et image : l'image est reconnue à côté du texte", () => {
  const el = message("text-and-image");
  assert.ok(visibleText(el).includes("Voici la capture de l'écran d'admission"));
  assert.deepEqual(files.missing(["ecran-admission.jpg"], [el]), []);
});

test("plusieurs fichiers : chacun doit être là, une carte ne compte qu'une fois", () => {
  const el = message("two-files");
  assert.deepEqual(files.filesOf(el).map((f) => f.name), ["compte-rendu.pdf", "schema.png"]);
  assert.match(files.filesOf(el)[0].url, /^https:\/\/example-my\.sharepoint\.com\//);
  assert.deepEqual(files.missing(["compte-rendu.pdf", "schema.png"], [el]), []);
  assert.deepEqual(files.missing(["compte-rendu.pdf", "schema.png", "annexe.pdf"], [el]), ["annexe.pdf"]);
  assert.deepEqual(files.missing(["schema.png", "schema.png"], [el]), ["schema.png"]);
});

test("fichiers répartis sur deux messages apparus ensemble : tous reconnus", () => {
  assert.deepEqual(files.missing(["capture-20261126-182223.png", "compte-rendu.pdf"], [message("image-alone"), message("two-files")]), []);
});

test("image collée dans le corps, sans son nom : vaut pour une image voulue, pas pour un document", () => {
  const el = message("inline-image");
  assert.equal(files.imagesOf(el).length, 1);
  assert.deepEqual(files.filesOf(el), []);
  assert.deepEqual(files.missing(["capture.png"], [el]), []);
  assert.deepEqual(files.missing(["capture.png", "photo.jpg"], [el]), ["photo.jpg"]);
  assert.deepEqual(files.missing(["notes.pdf"], [el]), ["notes.pdf"]);
});

test("aucun message apparu : rien n'est prouvé", () => {
  assert.deepEqual(files.missing(["capture.png"], []), ["capture.png"]);
});

// L'op `webfetch` et la capture réseau de teams-bridge.js, jouées dans un mini-contexte
// « page Teams » (vm). On vérifie la règle de sécurité : l'appel se fait avec les credentials
// de la page, aucun en-tête d'auth ne part vers le moteur, et la capture ne retient que la
// structure (chemins masqués, NOMS d'en-têtes d'auth, jamais leur valeur, jamais de contenu).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const BRIDGE = readFileSync(new URL("../src-tauri/teams-bridge.js", import.meta.url), "utf8");

// Réponse façon fetch(), pilotable.
const fakeResponse = (body: string, { status = 200, contentType = "application/json" } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
  text: async () => body,
});

// Un contexte « page Teams » minimal : DOM vide, fetch pilotable, invoke() qui capte les
// réponses que la page renvoie au moteur.
const teamsPage = () => {
  const replies: any[] = [];
  const fetchCalls: Array<{ url: string; init: any }> = [];
  let nextResponse = fakeResponse('{"ok":true}');
  const doc: any = {
    title: "Chat | Microsoft Teams",
    hasFocus: () => false,
    visibilityState: "visible",
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    dispatchEvent: () => true,
  };
  const ctx: any = {
    location: { hostname: "teams.microsoft.com", origin: "https://teams.microsoft.com", href: "https://teams.microsoft.com/" },
    document: doc,
    URL,
    setTimeout: (fn: Function, ms?: number) => setTimeout(fn as any, ms),
    clearTimeout: (id: any) => clearTimeout(id),
    addEventListener: () => {},
    fetch: async (url: any, init: any) => {
      fetchCalls.push({ url: String(url), init });
      return nextResponse;
    },
    __TAURI_INTERNALS__: { invoke: (_name: string, { payload }: any) => replies.push(payload) },
  };
  ctx.window = ctx;
  ctx.top = ctx; // frame principale (pas l'iframe de transcription)
  vm.runInNewContext(BRIDGE, ctx);
  const run = async (op: string, args: any = {}, id = replies.length + 1) => {
    await ctx.window.__trame.run({ id, op, args });
    return replies[replies.length - 1];
  };
  return {
    ctx,
    run,
    fetchCalls,
    setResponse: (r: any) => (nextResponse = r),
  };
};

test("webfetch refuse les hôtes hors Teams et exige https — sans jamais appeler fetch", async () => {
  const p = teamsPage();
  for (const url of ["https://evil.example.com/steal", "http://teams.microsoft.com/api/x", "https://teams.microsoft.com.evil.com/x"]) {
    const r = await p.run("webfetch", { url });
    assert.equal(r.ok, true); // l'op s'exécute…
    assert.equal(r.result.ok, false); // …mais le résultat dit « refusé »
  }
  assert.equal(p.fetchCalls.length, 0); // aucun appel réseau pour un hôte/scheme refusé
});

test("webfetch appelle avec les credentials de la page et ne pose aucun en-tête d'auth", async () => {
  const p = teamsPage();
  p.setResponse(fakeResponse('{"conversations":[]}'));
  const r = await p.run("webfetch", {
    url: "https://teams.microsoft.com/api/csa/v1/conversations",
    headers: { Authorization: "Bearer SECRET", "x-skypetoken": "SECRET2", "X-Trame": "ok" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(r.result.json)), { conversations: [] });
  assert.equal(p.fetchCalls.length, 1);
  const { init } = p.fetchCalls[0];
  assert.equal(init.credentials, "include"); // la session de la page
  // Aucun en-tête d'auth transmis ; seul l'en-tête métier survit.
  const keys = Object.keys(init.headers).map((k) => k.toLowerCase());
  assert.ok(!keys.includes("authorization") && !keys.includes("x-skypetoken"));
  assert.equal(init.headers["X-Trame"], "ok");
});

test("webfetch ne renvoie que le corps (statut + type), jamais d'en-tête de réponse", async () => {
  const p = teamsPage();
  p.setResponse(fakeResponse("non-json ici", { status: 403, contentType: "text/plain" }));
  const r = await p.run("webfetch", { url: "https://presence.teams.microsoft.com/v1/x" });
  assert.deepEqual(Object.keys(r.result).sort(), ["contentType", "ok", "status", "text"]);
  assert.equal(r.result.status, 403);
  assert.equal(r.result.contentType, "text/plain");
  assert.equal(r.result.text, "non-json ici");
});

test("la capture ne retient que la structure : chemin masqué, NOMS d'auth, aucune valeur", async () => {
  const p = teamsPage();
  // Teams émet une requête authentifiée (jeton en en-tête) vers une conversation précise.
  await p.ctx.window.fetch("https://teams.microsoft.com/api/csa/v1/teams/19:abcdef0123456789@thread.v2/messages?token=zzz", {
    method: "GET",
    headers: { authorization: "Bearer TRES-SECRET", "x-skypetoken": "AUSSI-SECRET" },
  });
  await new Promise((r) => setImmediate(r)); // laisse le then() de capture s'exécuter
  const diag = await p.run("diagnose");
  const cap = diag.result.api_capture;
  assert.ok(cap && cap.count >= 1, JSON.stringify(cap));
  const ep = cap.endpoints.find((e: any) => e.service === "chatsvc" || /messages/.test(e.path));
  assert.ok(ep, JSON.stringify(cap.endpoints));
  // L'id de conversation et le jeton de l'URL sont masqués.
  assert.ok(ep.path.includes("{thread}") && ep.path.endsWith("/messages"), ep.path);
  assert.equal(ep.hasQuery, true);
  // Les en-têtes d'auth sont listés par leur NOM seulement.
  assert.deepEqual([...ep.auth].sort(), ["authorization", "x-skypetoken"]);
  // Aucune valeur de jeton nulle part dans la capture.
  const dump = JSON.stringify(cap);
  assert.ok(!/TRES-SECRET|AUSSI-SECRET|token=zzz|zzz/.test(dump), dump);
});

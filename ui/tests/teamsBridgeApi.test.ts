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
  const wsCreated: string[] = [];
  let nextResponse = fakeResponse('{"ok":true}');
  class FakeWS {
    url: string;
    sent: any[] = [];
    listeners: Record<string, Function[]> = {};
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url: string) {
      this.url = url;
      wsCreated.push(url);
    }
    send(data: any) {
      this.sent.push(data);
    }
    addEventListener(type: string, fn: Function) {
      (this.listeners[type] ||= []).push(fn);
    }
    emit(type: string, ev: any) {
      (this.listeners[type] || []).forEach((fn) => fn(ev));
    }
  }
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
    URLSearchParams,
    atob,
    // Comme la vraie page Teams (Trusted Types) : DOMParser refuse une chaîne HTML brute.
    DOMParser: class {
      parseFromString() {
        throw new TypeError("This document requires 'TrustedHTML' assignment.");
      }
    },
    setTimeout: (fn: Function, ms?: number) => setTimeout(fn as any, ms),
    clearTimeout: (id: any) => clearTimeout(id),
    addEventListener: () => {},
    fetch: async (url: any, init: any) => {
      fetchCalls.push({ url: String(url), init });
      // Une fonction route la réponse selon l'URL (session chatsvc : authz puis service de chat).
      return typeof nextResponse === "function" ? nextResponse(String(url), init) : nextResponse;
    },
    WebSocket: FakeWS,
    // Stub XHR : présent sur la vraie page, il doit l'être ici pour que le bloc d'install
    // n'échoue pas avant la pose du hook WebSocket.
    XMLHttpRequest: class {
      open() {}
      send() {}
      setRequestHeader() {}
      addEventListener() {}
      getResponseHeader() {
        return "";
      }
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
    wsCreated,
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

test("diagnose rapporte l'empreinte du pont injecté par l'hôte (sinon null)", async () => {
  const absent = teamsPage();
  assert.equal((await absent.run("diagnose")).result.bridge, null);
  const p = teamsPage();
  p.ctx.__trameBridge = "deadbeefcafe0001"; // posée par l'hôte à l'injection
  assert.equal((await p.run("diagnose")).result.bridge, "deadbeefcafe0001");
});

test("webfetch resigne avec l'auth que Teams a posée — mais ne la renvoie jamais au moteur", async () => {
  const p = teamsPage();
  // Teams fait lui-même un appel authentifié vers un hôte d'API (bearer + skypetoken).
  await p.ctx.window.fetch("https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/abc/views/imgo", {
    headers: { authorization: "Bearer SECRET-TOK-123", "x-skypetoken": "SKYPE-SECRET-456" },
  });
  await new Promise((r) => setImmediate(r));
  p.setResponse(fakeResponse('{"ok":true}'));
  const before = p.fetchCalls.length;
  const r = await p.run("webfetch", { url: "https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/abc/views/imgo" });
  // L'appel sortant de la page porte l'auth rejouée.
  const out = p.fetchCalls[before];
  assert.equal(out.init.headers["Authorization"], "Bearer SECRET-TOK-123");
  assert.equal(out.init.headers["X-Skypetoken"], "SKYPE-SECRET-456");
  // Mais la réponse renvoyée au moteur ne contient aucun credential.
  assert.ok(!/SECRET-TOK-123|SKYPE-SECRET-456/.test(JSON.stringify(r)), JSON.stringify(r));
  // Et le diagnostic (capture structure) ne contient jamais la valeur du jeton.
  const diag = await p.run("diagnose");
  assert.ok(!/SECRET-TOK-123|SKYPE-SECRET-456/.test(JSON.stringify(diag)), "token dans diagnose");
});

test("webfetch rejoue le jeton de l'ENDPOINT exact, pas le dernier jeton de l'hôte", async () => {
  // Deux endpoints du même hôte ont des jetons d'audience différents (cas réel : tenantsv2
  // vs me/settings sur teams.cloud.microsoft). Le dernier vu par hôte ne doit pas écraser.
  const p = teamsPage();
  await p.ctx.window.fetch("https://teams.cloud.microsoft/api/mt/part/emea-03/beta/users/tenantsv2", {
    headers: { authorization: "Bearer TOK-TENANTS" },
  });
  await p.ctx.window.fetch("https://teams.cloud.microsoft/api/mt/part/emea-03/beta/me/settings/42", {
    headers: { authorization: "Bearer TOK-SETTINGS" },
  });
  await new Promise((r) => setImmediate(r));
  const before = p.fetchCalls.length;
  await p.run("webfetch", { url: "https://teams.cloud.microsoft/api/mt/part/emea-03/beta/users/tenantsv2" });
  // On resigne avec le jeton de tenantsv2, pas celui de me/settings (dernier vu pour l'hôte).
  assert.equal(p.fetchCalls[before].init.headers["Authorization"], "Bearer TOK-TENANTS");
});

test("webfetch avec sign:false n'attache aucune auth, même si un credential est connu", async () => {
  const p = teamsPage();
  await p.ctx.window.fetch("https://eu-prod.asyncgw.teams.microsoft.com/v1/x", {
    headers: { authorization: "Bearer SECRET-TOK-789" },
  });
  await new Promise((r) => setImmediate(r));
  const before = p.fetchCalls.length;
  await p.run("webfetch", { url: "https://eu-prod.asyncgw.teams.microsoft.com/v1/x", sign: false });
  const out = p.fetchCalls[before];
  assert.ok(!("Authorization" in out.init.headers), "auth posée malgré sign:false");
});

test("diagnose rejoue une sonde signée et rapporte le statut (jamais le corps)", async () => {
  const p = teamsPage();
  p.setResponse(fakeResponse('{"tenants":[{"secret":"TENANT-DATA"}]}', { status: 200 }));
  // Teams appelle lui-même un GET authentifié, sûr et idempotent (sonde de signature).
  await p.ctx.window.fetch("https://teams.cloud.microsoft/api/mt/part/emea-03/beta/users/tenantsv2", {
    headers: { authorization: "Bearer TOK" },
  });
  await new Promise((r) => setImmediate(r));
  const before = p.fetchCalls.length;
  const diag = (await p.run("diagnose")).result;
  // L'auto-test a rejoué la sonde, signée, et ne rapporte que le statut.
  assert.equal(diag.sign_selftest.status, 200);
  assert.equal(diag.sign_selftest.ok, true);
  assert.equal(p.fetchCalls[before].init.headers["Authorization"], "Bearer TOK");
  // Jamais le corps de la sonde dans le diagnostic.
  assert.ok(!/TENANT-DATA/.test(JSON.stringify(diag)), "corps de la sonde exposé");
});

test("l'auto-test de signature révèle un 401 (signature KO) sans exposer de corps", async () => {
  const p = teamsPage();
  p.setResponse(fakeResponse("{}", { status: 200 }));
  await p.ctx.window.fetch("https://teams.cloud.microsoft/api/mt/part/emea-03/beta/users/tenantsv2", {
    headers: { authorization: "Bearer TOK" },
  });
  await new Promise((r) => setImmediate(r));
  p.setResponse(fakeResponse("Unauthorized", { status: 401, contentType: "text/plain" }));
  const diag = (await p.run("diagnose")).result;
  assert.equal(diag.sign_selftest.status, 401);
  assert.equal(diag.sign_selftest.ok, false);
});

test("la capture WebSocket ne retient que l'URL de connexion (hôte + chemin masqué)", async () => {
  const p = teamsPage();
  // La page ouvre un canal trouter (où passent les messages en v2).
  const ws = new p.ctx.window.WebSocket(
    "wss://go-eu.trouter.teams.microsoft.com/socket.io/1/websocket/F9c2aLongSessionToken1234567890?v=v4&tc=1",
  );
  // La vraie WebSocket est bien renvoyée, inchangée.
  assert.equal(ws.url.startsWith("wss://go-eu.trouter"), true);
  assert.equal(p.wsCreated.length, 1);
  const cap = (await p.run("diagnose")).result.api_capture;
  assert.equal(cap.sockets.length, 1);
  const s = cap.sockets[0];
  assert.equal(s.scheme, "wss");
  assert.equal(s.host, "go-eu.trouter.teams.microsoft.com");
  // Le jeton de session dans le chemin est masqué, la requête n'est pas conservée.
  assert.ok(s.path.includes("{id}") && !/F9c2aLong/.test(s.path), s.path);
  assert.equal(s.hasQuery, true);
  // Aucune valeur sensible nulle part dans la capture.
  assert.ok(!/F9c2aLongSessionToken/.test(JSON.stringify(cap)));
});

test("les frames WebSocket sont capturées en STRUCTURE seule (noms de clés, jamais le contenu)", async () => {
  const p = teamsPage();
  const ws: any = new p.ctx.window.WebSocket("wss://go-eu.trouter.teams.microsoft.com/v4/c?sr=abc");
  // Frame entrante avec du contenu de message réel (ne doit jamais être retenu).
  ws.emit("message", {
    data: JSON.stringify({
      type: "message",
      from: "19:abc0123@thread.v2",
      id: "1795600000001",
      body: "TEXTE SECRET DU MESSAGE",
      props: { importance: "high" },
    }),
  });
  // Frame sortante.
  ws.send(JSON.stringify({ sub: "presence", id: "222222222" }));
  const cap = (await p.run("diagnose")).result.api_capture;
  assert.ok(Array.isArray(cap.frames) && cap.frames.length >= 2, JSON.stringify(cap.frames));
  const dirs = cap.frames.map((f: any) => f.dir).sort();
  assert.deepEqual([...new Set(dirs)].sort(), ["in", "out"]);
  const inFrame = cap.frames.find((f: any) => f.dir === "in");
  // La forme garde les NOMS de clés (type, from, body, props.importance)…
  assert.ok(/type/.test(inFrame.shape) && /body/.test(inFrame.shape) && /props\.importance/.test(inFrame.shape), inFrame.shape);
  // …mais AUCUNE valeur : ni le texte du message, ni l'id, ni l'expéditeur.
  const dump = JSON.stringify(cap);
  assert.ok(!/TEXTE SECRET DU MESSAGE/.test(dump), "contenu de message capturé");
  assert.ok(!/19:abc0123@thread\.v2/.test(dump) && !/1795600000001|222222222/.test(dump), "valeur/id capturé");
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


// --- Session du service de chat (chatsvc) ---------------------------------------------
const AUTHZ_BODY = JSON.stringify({
  tokens: { skypeToken: "SKYPE-CHAT-SECRET", expiresIn: 86400 },
  region: "emea",
  regionGtms: { chatService: "https://emea.ng.msg.teams.microsoft.com", chatServiceAfd: "https://teams.microsoft.com/api/chatsvc/emea" },
});
// Teams pose lui-même son bearer middletier (audience api.spaces.skype.com).
const withTeamsBearer = async (p: any, token = "Bearer MT-SECRET") => {
  await p.ctx.window.fetch("https://teams.cloud.microsoft/api/mt/part/emea-03/beta/me/settings/42", {
    headers: { authorization: token },
  });
  await new Promise((r) => setImmediate(r));
};

test("chatsvc ouvre la session dans la page et ne renvoie que le corps métier", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  p.setResponse((url: string) =>
    url.includes("/authsvc/") ? fakeResponse(AUTHZ_BODY) : fakeResponse('{"conversations":[{"id":"19:a@thread.v2"}]}'),
  );
  const before = p.fetchCalls.length;
  const r = await p.run("chatsvc", { path: "/v1/users/ME/conversations", query: { view: "msnp24Equivalent", pageSize: 1, evil: "x" } });
  assert.equal(r.result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.result.json)), { conversations: [{ id: "19:a@thread.v2" }] });
  // 1) authz avec le bearer de Teams, sans cookies ; 2) service de chat avec le jeton du chat.
  const [authz, call] = p.fetchCalls.slice(before);
  assert.equal(authz.url, "https://teams.microsoft.com/api/authsvc/v1.0/authz");
  assert.equal(authz.init.method, "POST");
  assert.equal(authz.init.headers.Authorization, "Bearer MT-SECRET");
  assert.equal(authz.init.credentials, "omit");
  assert.equal(call.url, "https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations?view=msnp24Equivalent&pageSize=1");
  assert.equal(call.init.headers.Authentication, "skypetoken=SKYPE-CHAT-SECRET");
  // Aucun jeton dans ce qui revient au moteur, ni dans le diagnostic.
  assert.ok(!/SKYPE-CHAT-SECRET|MT-SECRET/.test(JSON.stringify(r)), JSON.stringify(r));
  const diag = (await p.run("diagnose")).result;
  assert.ok(!/SKYPE-CHAT-SECRET|MT-SECRET/.test(JSON.stringify(diag)), "jeton dans diagnose");
  assert.equal(diag.chatsvc_selftest.ok, true);
  assert.equal(diag.chatsvc_selftest.region, "emea");
});

test("chatsvc réutilise la session : un seul authz pour plusieurs lectures", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  p.setResponse((url: string) => (url.includes("/authsvc/") ? fakeResponse(AUTHZ_BODY) : fakeResponse('{"messages":[]}')));
  const before = p.fetchCalls.length;
  await p.run("chatsvc", { path: "/v1/users/ME/conversations/19%3Aa%40thread.v2/messages", query: { pageSize: 20 } });
  await p.run("chatsvc", { path: "/v1/users/ME/conversations/19%3Aa%40thread.v2" });
  const urls = p.fetchCalls.slice(before).map((c) => c.url);
  assert.equal(urls.filter((u) => u.includes("/authsvc/")).length, 1);
  assert.equal(urls.length, 3);
});

test("chatsvc refuse un chemin hors liste blanche sans aucun appel réseau", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const before = p.fetchCalls.length;
  for (const path of ["/v1/users/ME/endpoints", "/v1/users/ME/conversations/x/properties", "/v1/users/ME/conversations/../../x", "/v1/users/ME/conversations/..", "/v1/users/ME/conversations/a%2f..%2fb", "https://evil.example.com/x"]) {
    const r = await p.run("chatsvc", { path });
    assert.equal(r.result.ok, false, path);
  }
  assert.equal(p.fetchCalls.length, before);
});

test("chatsvc rouvre la session une fois sur un 401 puis rend la main", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  let chatCalls = 0;
  p.setResponse((url: string) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_BODY);
    chatCalls++;
    return chatCalls === 1 ? fakeResponse("{}", { status: 401 }) : fakeResponse('{"conversations":[]}');
  });
  const before = p.fetchCalls.length;
  const r = await p.run("chatsvc", { path: "/v1/users/ME/conversations" });
  assert.equal(r.result.ok, true);
  const urls = p.fetchCalls.slice(before).map((c) => c.url);
  assert.equal(urls.filter((u) => u.includes("/authsvc/")).length, 2); // session rouverte une fois
  assert.equal(chatCalls, 2);
});

test("chatsvc sans jeton Teams observé : étape « bearer », aucun appel réseau", async () => {
  const p = teamsPage();
  const before = p.fetchCalls.length;
  const r = await p.run("chatsvc", { path: "/v1/users/ME/conversations" });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.stage, "bearer");
  assert.equal(p.fetchCalls.length, before);
});

test("chatsvc : authz refusé remonte l'étape et le statut, sans corps", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  p.setResponse(fakeResponse('{"error":"SECRET-DETAIL"}', { status: 403 }));
  const r = await p.run("chatsvc", { path: "/v1/users/ME/conversations" });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.stage, "authz");
  assert.equal(r.result.status, 403);
  assert.ok(!/SECRET-DETAIL/.test(JSON.stringify(r)));
});


// --- Lecture d'un fil par le service de chat (op chatread) -----------------------------
const msg = (id: number, text: string, extra: any = {}) => ({
  id: String(id),
  messagetype: "RichText/Html",
  imdisplayname: "Ana Martin",
  originalarrivaltime: new Date(id).toISOString(),
  content: `<p>${text}</p>`,
  properties: {},
  ...extra,
});

test("chatread lit le fil page par page, du plus ancien au plus récent, sans jeton dans la réponse", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const T = Date.UTC(2026, 10, 27, 9, 0);
  const pages = [
    { messages: [msg(T + 5000, "cinq"), msg(T + 4000, "quatre"), msg(T + 3500, "", { messagetype: "ThreadActivity/AddMember" })],
      _metadata: { backwardLink: "https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/19%3Aa%40thread.v2/messages?startTime=1&syncState=abc&pageSize=50&view=msnp24Equivalent&evil=1" } },
    { messages: [msg(T + 3000, "trois"), msg(T + 2000, "deux")], _metadata: {} },
  ];
  let n = 0;
  p.setResponse((url: string) => (url.includes("/authsvc/") ? fakeResponse(AUTHZ_BODY) : fakeResponse(JSON.stringify(pages[n++]))));
  const before = p.fetchCalls.length;
  const r = await p.run("chatread", { thread: "19:a@thread.v2", last: 3 });
  assert.equal(r.result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.result.messages.map((m: any) => m.text))), ["trois", "quatre", "cinq"]);
  assert.equal(r.result.top, false); // « deux » existe encore plus haut
  const urls = p.fetchCalls.slice(before).map((c) => c.url).filter((u) => !u.includes("/authsvc/"));
  assert.equal(urls.length, 2);
  // Page précédente : seuls les paramètres permis du lien de Teams sont repris.
  assert.ok(urls[1].includes("syncState=abc") && !urls[1].includes("evil"), urls[1]);
  assert.ok(!/SKYPE-CHAT-SECRET|MT-SECRET/.test(JSON.stringify(r)));
});

test("chatread avec since : s'arrête au premier message plus ancien et ne garde que les plus récents", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const T = Date.UTC(2026, 10, 27, 9, 0);
  const page = { messages: [msg(T + 3000, "après"), msg(T + 1000, "avant")],
    _metadata: { backwardLink: "https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/x/messages?syncState=z" } };
  let chatCalls = 0;
  p.setResponse((url: string) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_BODY);
    chatCalls++;
    return fakeResponse(JSON.stringify(page));
  });
  const r = await p.run("chatread", { thread: "19:a@thread.v2", last: 30, since: T + 2000 });
  assert.deepEqual(JSON.parse(JSON.stringify(r.result.messages.map((m: any) => m.text))), ["après"]);
  assert.equal(chatCalls, 1); // pas besoin de remonter plus loin
});

test("chatread remonte l'échec du service pour que le moteur lise la page", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  p.setResponse((url: string) => (url.includes("/authsvc/") ? fakeResponse(AUTHZ_BODY) : fakeResponse("{}", { status: 403 })));
  const r = await p.run("chatread", { thread: "19:a@thread.v2", last: 10 });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.status, 403);
});


// --- Liste des conversations par le service de chat (op chatlist) ------------------------
const ME_GUID = "11111111-2222-3333-4444-555555555555";
const OTHER_GUID = "99999999-8888-7777-6666-555555555555";
// Jeton du chat au format JWT : la page y lit seulement l'identifiant (skypeid).
const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
const AUTHZ_ME = JSON.stringify({
  tokens: { skypeToken: jwt({ skypeid: `orgid:${ME_GUID}` }), expiresIn: 86400 },
  region: "emea",
  regionGtms: { chatService: "https://emea.ng.msg.teams.microsoft.com" },
});
const conv = (id: string, extra: any = {}) => ({ id, properties: {}, threadProperties: {}, ...extra });

test("chatlist : une ligne par conversation, nom du tête-à-tête demandé au middletier, sans jeton", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const dm = `19:${ME_GUID}_${OTHER_GUID}@unq.gbl.spaces`;
  const list = {
    conversations: [
      conv("19:grp@thread.v2", {
        threadProperties: { topic: "Projet X" },
        properties: { consumptionhorizon: "1795777000000;1795777000001;abc" },
        lastMessage: { id: "1795777000500", messagetype: "RichText/Html", imdisplayname: "Paul Durand",
          from: "https://emea.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:paul",
          originalarrivaltime: new Date(1795777000500).toISOString(), content: "<p>On décale à <b>15 h</b></p>" },
      }),
      conv(dm, { lastMessage: { id: "1795777000600", messagetype: "Text", imdisplayname: "Ana", content: "salut",
        from: `8:orgid:${OTHER_GUID}`, originalarrivaltime: new Date(1795777000600).toISOString() } }),
      conv("48:notes"),
      conv("19:meeting_abc@thread.v2", { threadProperties: { topic: "Point hebdo", productThreadType: "Meeting" } }),
    ],
    _metadata: { syncState: "https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations?syncState=NEXT123&view=msnp24Equivalent" },
  };
  const profileCalls: any[] = [];
  p.setResponse((url: string, init: any) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_ME);
    if (url.includes("fetchShortProfile")) {
      profileCalls.push({ url, init });
      return fakeResponse(JSON.stringify({ value: [{ mri: `8:orgid:${OTHER_GUID}`, displayName: "Ana Martin" }] }));
    }
    return fakeResponse(JSON.stringify(list));
  });
  const r = (await p.run("chatlist", {})).result;
  assert.equal(r.ok, true);
  assert.equal(r.sync, "NEXT123");
  assert.equal(r.me, `8:orgid:${ME_GUID}`);
  const by = Object.fromEntries(r.rows.map((x: any) => [x.id, x]));
  assert.equal(by["19:grp@thread.v2"].kind, "group");
  assert.equal(by["19:grp@thread.v2"].name, "Projet X");
  assert.equal(by["19:grp@thread.v2"].horizon, 1795777000000);
  assert.equal(by["19:grp@thread.v2"].last.text, "On décale à 15 h");
  assert.equal(by["19:grp@thread.v2"].last.from, "8:orgid:paul");
  assert.equal(by[dm].kind, "dm");
  assert.equal(by[dm].other, `8:orgid:${OTHER_GUID}`);
  assert.equal(by[dm].name, "Ana Martin");
  assert.equal(by["48:notes"].kind, "self");
  assert.equal(by["19:meeting_abc@thread.v2"].kind, "meeting");
  // Profils : middletier du locataire, bearer de Teams, seulement l'autre personne.
  assert.equal(profileCalls.length, 1);
  assert.ok(profileCalls[0].url.startsWith("https://teams.cloud.microsoft/api/mt/part/emea-03/beta/users/fetchShortProfile?"));
  assert.equal(profileCalls[0].init.headers.Authorization, "Bearer MT-SECRET");
  assert.deepEqual(JSON.parse(profileCalls[0].init.body), [`8:orgid:${OTHER_GUID}`]);
  assert.ok(!/MT-SECRET|skypeid|x\.ey/.test(JSON.stringify(r)), "jeton renvoyé au moteur");
});

test("chatlist incrémental : seulement le syncState, une seule page, noms déjà connus non redemandés", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const calls: string[] = [];
  p.setResponse((url: string) => {
    calls.push(url);
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_ME);
    return fakeResponse(JSON.stringify({ conversations: [conv("19:grp@thread.v2")], _metadata: { syncState: "https://x.teams.microsoft.com/v1?syncState=N2" } }));
  });
  const r = (await p.run("chatlist", { sync: "NEXT123" })).result;
  assert.equal(r.full, false);
  assert.equal(r.sync, "N2");
  const chat = calls.filter((u) => u.includes("/conversations"));
  assert.equal(chat.length, 1);
  assert.ok(chat[0].includes("syncState=NEXT123") && !chat[0].includes("pageSize"), chat[0]);
  assert.equal(calls.filter((u) => u.includes("fetchShortProfile")).length, 0);
});

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
  const ticks: Function[] = [];
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
    btoa, // API du navigateur (filelink encode le lien de partage pour Graph)
    atob,
    // Comme la vraie page Teams (Trusted Types) : DOMParser refuse une chaîne HTML brute.
    DOMParser: class {
      parseFromString() {
        throw new TypeError("This document requires 'TrustedHTML' assignment.");
      }
    },
    // Les minuteries de 20 s (relance du jeton) sont aussi notées, pour être jouées à la main.
    setTimeout: (fn: Function, ms?: number) => {
      if (ms === 20000) ticks.push(fn);
      return setTimeout(fn as any, ms);
    },
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
    ticks,
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


// --- Jeton middletier : échéance, et frein des réessais authz --------------------------
// Un bearer JWT factice : seule la charge (exp, aud) compte, la signature est fausse.
const mtJwt = (expSeconds: number, aud = "https://api.spaces.skype.com", tag = "X") => {
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `Bearer ${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + expSeconds, aud, tag })}.SIG-${tag}`;
};
const teamsCall = async (p: any, path: string, token: string) => {
  await p.ctx.window.fetch(`https://teams.cloud.microsoft${path}`, { headers: { authorization: token } });
  await new Promise((r) => setImmediate(r));
};

test("jeton middletier : un jeton expiré n'est jamais rejoué, même capturé en dernier", async () => {
  const p = teamsPage();
  const fresh = mtJwt(3600, undefined, "FRESH");
  await teamsCall(p, "/api/mt/part/emea-03/beta/users/tenantsv2", fresh);
  // Nos propres appels (ou un vieux) repassent par le hook avec un jeton expiré, PLUS récemment.
  await teamsCall(p, "/api/mt/part/emea-03/beta/users/fetchShortProfile", mtJwt(-600, undefined, "STALE"));
  p.setResponse((url: string) => (url.includes("/authsvc/") ? fakeResponse(AUTHZ_BODY) : fakeResponse('{"conversations":[]}')));
  const before = p.fetchCalls.length;
  const r = await p.run("chatsvc", { path: "/v1/users/ME/conversations" });
  assert.equal(r.result.ok, true);
  assert.equal(p.fetchCalls[before].init.headers.Authorization, fresh);
  const diag = (await p.run("diagnose")).result;
  assert.equal(diag.mt_token.state, "valid");
  assert.ok(diag.mt_token.expires_in_s > 3000 && diag.mt_token.expires_in_s <= 3600, String(diag.mt_token.expires_in_s));
  assert.ok(!/FRESH|STALE|SIG-/.test(JSON.stringify(diag)), "jeton dans diagnose");
});

test("jeton middletier : l'audience du service de chat passe avant une autre, plus tardive", async () => {
  const p = teamsPage();
  const chat = mtJwt(1800, "https://api.spaces.skype.com", "CHAT");
  await teamsCall(p, "/api/mt/part/emea-03/beta/sharepoint/sites/validSites", mtJwt(7200, "https://other.example", "OTHER"));
  await teamsCall(p, "/api/mt/part/emea-03/beta/users/tenantsv2", chat);
  p.setResponse((url: string) => (url.includes("/authsvc/") ? fakeResponse(AUTHZ_BODY) : fakeResponse('{"conversations":[]}')));
  const before = p.fetchCalls.length;
  await p.run("chatsvc", { path: "/v1/users/ME/conversations" });
  assert.equal(p.fetchCalls[before].init.headers.Authorization, chat);
});

test("jeton middletier tous expirés : aucun appel authz, réponse immédiate, état « expired »", async () => {
  const p = teamsPage();
  await teamsCall(p, "/api/mt/part/emea-03/beta/users/tenantsv2", mtJwt(-60, undefined, "OLD"));
  const before = p.fetchCalls.length;
  const t0 = Date.now();
  const r = await p.run("chatsvc", { path: "/v1/users/ME/conversations" });
  assert.ok(Date.now() - t0 < 1000, "attente inutile d'un jeton");
  assert.equal(r.result.ok, false);
  assert.equal(r.result.stage, "bearer");
  assert.match(r.result.error, /expiré/);
  assert.equal(p.fetchCalls.length, before);
  assert.equal((await p.run("diagnose")).result.mt_token.state, "expired");
});

test("authz refusé : pas de nouvel échange tant que le jeton est le même, un nouveau jeton lève le frein", async () => {
  const p = teamsPage();
  await teamsCall(p, "/api/mt/part/emea-03/beta/users/tenantsv2", mtJwt(3600, undefined, "A"));
  let authz = 0;
  let accept = false;
  p.setResponse((url: string) => {
    if (url.includes("/authsvc/")) {
      authz++;
      return accept ? fakeResponse(AUTHZ_BODY) : fakeResponse("{}", { status: 401 });
    }
    return fakeResponse('{"conversations":[]}');
  });
  for (let i = 0; i < 5; i++) {
    const r = await p.run("chatsvc", { path: "/v1/users/ME/conversations" });
    assert.equal(r.result.ok, false);
    assert.equal(r.result.stage, "authz");
  }
  assert.equal(authz, 1); // un seul échange refusé, pas cinq
  // Teams pose un nouveau jeton : on réessaie aussitôt.
  accept = true;
  await teamsCall(p, "/api/mt/part/emea-03/beta/users/tenantsv2", mtJwt(3700, undefined, "B"));
  const ok = await p.run("chatsvc", { path: "/v1/users/ME/conversations" });
  assert.equal(ok.result.ok, true);
  assert.equal(authz, 2);
});

// La page au repos, jeton expiré : horloge avancée, liste visible, sessionStorage et reload simulés.
const idlePage = async () => {
  const p = teamsPage();
  let offset = 0;
  const RealDate = Date;
  p.ctx.Date = class extends RealDate {
    static now() {
      return RealDate.now() + offset;
    }
  };
  const store = new Map<string, string>();
  p.ctx.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, String(v)) };
  let reloads = 0;
  p.ctx.location.reload = () => reloads++;
  p.ctx.document.querySelector = (sel: string) => (sel === '[role="tree"]' ? {} : null);
  await teamsCall(p, "/api/mt/part/emea-03/beta/users/tenantsv2", mtJwt(-60, undefined, "OLD"));
  return {
    p,
    store,
    reloads: () => reloads,
    advance: (ms: number) => (offset += ms),
    tick: () => p.ticks.splice(0).forEach((fn) => fn()),
  };
};

test("jeton expiré et voulu : la page se recharge au repos, une fois par 30 min au plus", async () => {
  const page = await idlePage();
  await page.p.run("chatsvc", { path: "/v1/users/ME/conversations" }); // un appel en a voulu un
  page.tick(); // fin d'opération à l'instant : pas encore
  assert.equal(page.reloads(), 0);
  page.advance(16000);
  page.tick();
  assert.equal(page.reloads(), 1);
  assert.ok(page.store.get("trame.tokenReload"));
  // Après le rechargement (même sessionStorage), pas de nouveau rechargement avant 30 min.
  const again = await idlePage();
  again.store.set("trame.tokenReload", String(Date.now()));
  await again.p.run("chatsvc", { path: "/v1/users/ME/conversations" });
  again.advance(16000);
  again.tick();
  assert.equal(again.reloads(), 0);
});

test("jeton expiré mais personne ne l'a voulu, ou liste absente : aucun rechargement", async () => {
  const idle = await idlePage();
  idle.advance(16000);
  idle.tick();
  assert.equal(idle.reloads(), 0); // aucun appel n'a demandé le jeton
  const login = await idlePage();
  await login.p.run("chatsvc", { path: "/v1/users/ME/conversations" });
  login.p.ctx.document.querySelector = () => null; // écran de connexion : pas de liste
  login.advance(16000);
  login.tick();
  assert.equal(login.reloads(), 0);
});

test("webfetch signé : un jeton expiré de l'endpoint cède la place au jeton valide de l'hôte", async () => {
  const p = teamsPage();
  const fresh = mtJwt(3600, undefined, "HOSTFRESH");
  await teamsCall(p, "/api/mt/part/emea-03/beta/me/settings/42", mtJwt(-600, undefined, "PATHOLD"));
  await teamsCall(p, "/api/mt/part/emea-03/beta/users/tenantsv2", fresh);
  const before = p.fetchCalls.length;
  await p.run("webfetch", { url: "https://teams.cloud.microsoft/api/mt/part/emea-03/beta/me/settings/42", method: "GET", sign: true });
  assert.equal(p.fetchCalls[before].init.headers.Authorization, fresh);
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

test("chatread : une vidéo jointe porte kind « video », un document non", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const T = Date.UTC(2026, 10, 27, 9, 0);
  const files = JSON.stringify([
    { fileName: "demo.mp4", fileType: "mp4", objectUrl: "https://example-my.sharepoint.com/personal/a/Documents/demo.mp4" },
    { fileName: "notes.pdf", fileType: "pdf", objectUrl: "https://example-my.sharepoint.com/personal/a/Documents/notes.pdf" },
  ]);
  const page = { messages: [msg(T, "", { properties: { files } })], _metadata: {} };
  p.setResponse((url: string) => (url.includes("/authsvc/") ? fakeResponse(AUTHZ_BODY) : fakeResponse(JSON.stringify(page))));
  const r = await p.run("chatread", { thread: "19:a@thread.v2", last: 5 });
  assert.deepEqual(JSON.parse(JSON.stringify(r.result.messages[0].files)), [
    { name: "demo.mp4", url: "https://example-my.sharepoint.com/personal/a/Documents/demo.mp4", kind: "video" },
    { name: "notes.pdf", url: "https://example-my.sharepoint.com/personal/a/Documents/notes.pdf" },
  ]);
});

// --- Lien de téléchargement d'un fichier joint (op filelink) ---------------------------
const SHARE = "https://example-my.sharepoint.com/:v:/g/personal/a/IQAxDemo";
// Teams appelle lui-même Graph pour l'aperçu d'un fichier : c'est là que la page apprend l'auth.
const withGraphBearer = async (p: any) => {
  await p.ctx.window.fetch("https://graph.microsoft.com/v1.0/shares/u!x/driveItem/preview", {
    method: "POST",
    headers: { authorization: "Bearer GRAPH-SECRET" },
  });
  await new Promise((r) => setImmediate(r));
};

test("filelink sans auth Graph : no_auth, sans appeler Graph", async () => {
  const p = teamsPage();
  const before = p.fetchCalls.length;
  const r = await p.run("filelink", { url: SHARE });
  assert.equal(r.result.ok, false);
  assert.equal(r.result.reason, "no_auth");
  assert.equal(p.fetchCalls.length, before);
});

test("filelink refuse un lien hors SharePoint / OneDrive sans appel réseau", async () => {
  const p = teamsPage();
  await withGraphBearer(p);
  const before = p.fetchCalls.length;
  for (const url of ["https://evil.example.com/x.mp4", "http://example-my.sharepoint.com/x", "https://sharepoint.com.evil.com/x"]) {
    const r = await p.run("filelink", { url });
    assert.equal(r.result.ok, false, url);
  }
  assert.equal(p.fetchCalls.length, before);
});

test("filelink : Graph signé sans cookies, seule l'adresse pré-signée sort de la page", async () => {
  const p = teamsPage();
  await withGraphBearer(p);
  const download = "https://example-my.sharepoint.com/personal/a/_layouts/15/download.aspx?UniqueId=1&tempauth=T";
  p.setResponse(fakeResponse(JSON.stringify({ name: "demo.mp4", size: 2048, file: { mimeType: "video/mp4" }, "@microsoft.graph.downloadUrl": download })));
  const before = p.fetchCalls.length;
  const r = await p.run("filelink", { url: SHARE });
  assert.deepEqual(JSON.parse(JSON.stringify(r.result)), { ok: true, name: "demo.mp4", size: 2048, mime: "video/mp4", url: download });
  const call = p.fetchCalls.slice(before)[0];
  const share = "u!" + Buffer.from(SHARE).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  assert.equal(call.url, `https://graph.microsoft.com/v1.0/shares/${share}/driveItem`);
  assert.equal(call.init.credentials, "omit"); // Graph refuse un appel avec cookies (CORS)
  assert.equal(call.init.headers.Authorization, "Bearer GRAPH-SECRET");
  assert.ok(!JSON.stringify(r).includes("GRAPH-SECRET"));
});

test("filelink refuse une adresse de téléchargement hors SharePoint", async () => {
  const p = teamsPage();
  await withGraphBearer(p);
  p.setResponse(fakeResponse(JSON.stringify({ name: "x.mp4", "@microsoft.graph.downloadUrl": "https://evil.example.com/x.mp4" })));
  const r = await p.run("filelink", { url: SHARE });
  assert.equal(r.result.ok, false);
  assert.ok(!JSON.stringify(r).includes("evil.example.com"));
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


// --- Gestes sur le service de chat (op chatgesture) ----------------------------------------
const GROUP_ID = "19:grp@thread.v2";
const MY_MRI = `8:orgid:${ME_GUID}`;
const AUTHZ_TWO = JSON.stringify({
  tokens: { skypeToken: jwt({ skypeid: `orgid:${ME_GUID}` }), expiresIn: 86400 },
  region: "emea",
  regionGtms: { chatService: "https://emea.ng.msg.teams.microsoft.com", chatServiceAfd: "https://teams.microsoft.com/api/chatsvc/emea" },
});
const msgRaw = (id: string, extra: any = {}) => ({
  id,
  messagetype: "RichText/Html",
  imdisplayname: "Ana Martin",
  from: "https://emea.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:ana",
  originalarrivaltime: new Date(Number(id)).toISOString(),
  content: "<p>Bonjour à tous</p>",
  properties: {},
  ...extra,
});
// Un faux service de chat : messages en mémoire, écritures appliquées, appels notés.
const chatServer = (p: any, messages: Record<string, any>, conv: any = {}) => {
  const writes: Array<{ url: string; method: string; body: any }> = [];
  p.setResponse((url: string, init: any) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    if (url.includes("fetchShortProfile")) return fakeResponse(JSON.stringify({ value: [{ mri: MY_MRI, displayName: "Damien B" }] }));
    const method = (init && init.method) || "GET";
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (method !== "GET") writes.push({ url, method, body });
    const m = /\/messages\/(\d+)/.exec(url);
    if (method === "PUT" && url.includes("name=emotions") && m) {
      const raw = messages[m[1]];
      raw.properties.emotions = [{ key: body.emotions.key, users: [{ mri: MY_MRI, time: body.emotions.value }] }];
      return fakeResponse("", { status: 200 });
    }
    if (method === "DELETE" && url.includes("name=emotions") && m) {
      const raw = messages[m[1]];
      raw.properties.emotions = (raw.properties.emotions || []).filter((e: any) => e.key !== body.emotions.key);
      return fakeResponse("", { status: 200 });
    }
    if (method === "PUT" && m && !url.includes("?")) {
      if (!conv.ignoreEdits) {
        messages[m[1]].content = body.content;
        messages[m[1]].properties.edittime = String(Date.now());
      }
      return fakeResponse("", { status: 200 });
    }
    if (method === "DELETE" && m) {
      messages[m[1]].properties.deletetime = String(Date.now());
      return fakeResponse("", { status: 200 });
    }
    if (method === "PUT" && url.includes("name=consumptionhorizon")) {
      conv.properties = { consumptionhorizon: body.consumptionhorizon };
      return fakeResponse("", { status: 200 });
    }
    if (method === "POST" && url.endsWith("/messages")) {
      const id = String(1795777999000 + Object.keys(messages).length);
      messages[id] = msgRaw(id, { clientmessageid: body.clientmessageid, from: MY_MRI, content: body.content, properties: { ...(body.properties || {}) } });
      return fakeResponse(JSON.stringify({ OriginalArrivalTime: Number(id) }), { status: 201 });
    }
    if (m) return messages[m[1]] ? fakeResponse(JSON.stringify(messages[m[1]])) : fakeResponse("{}", { status: 404 });
    if (url.includes("/messages")) return fakeResponse(JSON.stringify({ messages: Object.values(messages).reverse() }));
    return fakeResponse(JSON.stringify({ id: GROUP_ID, ...conv }));
  });
  return writes;
};

test("chatgesture react : vérifie le message vu, pose la réaction, la prouve en relisant", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const messages: any = { "1795777000001": msgRaw("1795777000001") };
  const writes = chatServer(p, messages);
  const ref = { id: "1795777000001", sender: "Ana Martin", text: "Bonjour à tous" };
  const r = (await p.run("chatgesture", { kind: "react", thread: GROUP_ID, message: ref, reaction: "like" })).result;
  assert.equal(r.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PUT");
  assert.ok(writes[0].url.endsWith(`/v1/users/ME/conversations/${encodeURIComponent(GROUP_ID)}/messages/1795777000001/properties?name=emotions`));
  assert.equal(writes[0].body.emotions.key, "like");
  // Déjà posée : rien n'est réécrit.
  const again = (await p.run("chatgesture", { kind: "react", thread: GROUP_ID, message: ref, reaction: "like" })).result;
  assert.equal(again.already, true);
  assert.equal(writes.length, 1);
});

test("chatgesture react remove : retire MA réaction, prouvé à la relecture, jamais une bascule", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const messages: any = { "1795777000001": msgRaw("1795777000001") };
  const writes = chatServer(p, messages);
  const ref = { id: "1795777000001", sender: "Ana Martin", text: "Bonjour à tous" };
  // Pas encore posée : rien à retirer, aucun appel.
  const none = (await p.run("chatgesture", { kind: "react", thread: GROUP_ID, message: ref, reaction: "like", remove: true })).result;
  assert.equal(none.already, true);
  assert.equal(writes.length, 0);
  await p.run("chatgesture", { kind: "react", thread: GROUP_ID, message: ref, reaction: "like" });
  const r = (await p.run("chatgesture", { kind: "react", thread: GROUP_ID, message: ref, reaction: "like", remove: true })).result;
  assert.equal(r.ok, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].method, "DELETE");
  assert.ok(writes[1].url.endsWith(`/v1/users/ME/conversations/${encodeURIComponent(GROUP_ID)}/messages/1795777000001/properties?name=emotions`));
  assert.deepEqual(writes[1].body, { emotions: { key: "like" } });
  assert.equal(messages["1795777000001"].properties.deletetime, undefined); // le message, lui, reste
  // Retirer à nouveau : déjà fait, rien n'est réécrit (et surtout pas reposé).
  const again = (await p.run("chatgesture", { kind: "react", thread: GROUP_ID, message: ref, reaction: "like", remove: true })).result;
  assert.equal(again.already, true);
  assert.equal(writes.length, 2);
});

test("chatgesture : un message différent de celui affiché n'est jamais touché", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const writes = chatServer(p, { "1795777000001": msgRaw("1795777000001") });
  for (const ref of [
    { id: "1795777000001", sender: "Paul Durand", text: "Bonjour à tous" },
    { id: "1795777000001", sender: "Ana Martin", text: "Autre chose" },
    { id: "", sender: "Ana Martin", text: "Bonjour à tous" },
  ]) {
    const r = (await p.run("chatgesture", { kind: "react", thread: GROUP_ID, message: ref, reaction: "heart" })).result;
    assert.equal(r.ok, false);
    assert.equal(r.attempted, false); // la page peut refaire le geste en vérifiant à son tour
  }
  assert.equal(writes.length, 0);
});

test("chatgesture delete : seulement un de MES messages, prouvé supprimé", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const messages: any = {
    "1795777000001": msgRaw("1795777000001"),
    "1795777000002": msgRaw("1795777000002", { from: MY_MRI, imdisplayname: "Damien B", content: "<p>Je regarde</p>" }),
  };
  const writes = chatServer(p, messages);
  const notMine = (await p.run("chatgesture", { kind: "delete", thread: GROUP_ID, message: { id: "1795777000001", sender: "Ana Martin", text: "Bonjour" } })).result;
  assert.equal(notMine.ok, false);
  assert.equal(notMine.attempted, false);
  assert.equal(writes.length, 0);
  const mine = (await p.run("chatgesture", { kind: "delete", thread: GROUP_ID, message: { id: "1795777000002", sender: "Damien B", text: "Je regarde" } })).result;
  assert.equal(mine.ok, true);
  assert.equal(writes[0].method, "DELETE");
  assert.ok(writes[0].url.endsWith("/messages/1795777000002?behavior=softDelete"));
});

test("chatgesture edit : seulement un de MES messages, nouveau texte prouvé et marqué modifié", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const messages: any = {
    "1795777000001": msgRaw("1795777000001"),
    "1795777000002": msgRaw("1795777000002", { from: MY_MRI, imdisplayname: "Alex Moreau", content: "<p>Je regarde</p>" }),
  };
  const writes = chatServer(p, messages);
  const theirs = { id: "1795777000001", sender: "Ana Martin", text: "Bonjour" };
  const notMine = (await p.run("chatgesture", { kind: "edit", thread: GROUP_ID, message: theirs, text: "Salut" })).result;
  assert.equal(notMine.ok, false);
  assert.equal(writes.length, 0);
  const ref = { id: "1795777000002", sender: "Alex Moreau", text: "Je regarde" };
  const mine = (await p.run("chatgesture", { kind: "edit", thread: GROUP_ID, message: ref, text: "Je regarde <ça>\nhttps://ex.test/a" })).result;
  assert.equal(mine.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PUT");
  assert.ok(writes[0].url.endsWith(`/conversations/${encodeURIComponent(GROUP_ID)}/messages/1795777000002`));
  // HTML du composeur : échappé, une ligne par paragraphe, lien cliquable.
  assert.match(writes[0].body.content, /^<p>Je regarde &lt;ça&gt;<\/p><p><a href="https:\/\/ex.test\/a"/);
  assert.equal(writes[0].body.messagetype, "RichText/Html");
  // Même texte qu'affiché : rien n'est réécrit.
  const same = (await p.run("chatgesture", { kind: "edit", thread: GROUP_ID, message: { ...ref, text: "Je regarde" }, text: "Je regarde <ça> https://ex.test/a" })).result;
  assert.equal(same.already, true);
  assert.equal(writes.length, 1);
});

test("chatgesture edit : message riche ou texte vide refusés pour de bon, sans repli sur la page", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const files = JSON.stringify([{ fileName: "plan.pdf", objectUrl: "https://ex.sharepoint.com/plan.pdf" }]);
  const messages: any = {
    "1795777000002": msgRaw("1795777000002", { from: MY_MRI, imdisplayname: "Alex Moreau", content: "<p>Le plan</p>", properties: { files } }),
  };
  const writes = chatServer(p, messages);
  const ref = { id: "1795777000002", sender: "Alex Moreau", text: "Le plan" };
  const rich = (await p.run("chatgesture", { kind: "edit", thread: GROUP_ID, message: ref, text: "Le nouveau plan" })).result;
  assert.equal(rich.ok, false);
  assert.equal(rich.attempted, true);
  assert.equal(rich.refused, true);
  const empty = (await p.run("chatgesture", { kind: "edit", thread: GROUP_ID, message: ref, text: "   " })).result;
  assert.equal(empty.ok, false);
  assert.equal(empty.refused, true);
  assert.equal(writes.length, 0);
});

test("chatgesture edit : accepté mais pas relu modifié → incertain, jamais refait", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const messages: any = {
    "1795777000002": msgRaw("1795777000002", { from: MY_MRI, imdisplayname: "Alex Moreau", content: "<p>Je regarde</p>" }),
  };
  const writes = chatServer(p, messages, { ignoreEdits: true });
  const r = (await p.run("chatgesture", { kind: "edit", thread: GROUP_ID, message: { id: "1795777000002", sender: "Alex Moreau", text: "Je regarde" }, text: "Vu" })).result;
  assert.equal(r.ok, false);
  assert.equal(r.uncertain, true);
  assert.equal(writes.length, 1);
});

test("chatgesture markread : horizon = arrivée du dernier message, prouvé à la relecture", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const last = msgRaw("1795777000009", { clientmessageid: "123456" });
  const conv: any = { lastMessage: last, properties: { consumptionhorizon: "1795777000000;1;0" } };
  const writes = chatServer(p, {}, conv);
  const r = (await p.run("chatgesture", { kind: "markread", thread: GROUP_ID })).result;
  assert.equal(r.ok, true);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].url.endsWith("/properties?name=consumptionhorizon"));
  const [arrived, , cid] = writes[0].body.consumptionhorizon.split(";");
  assert.equal(Number(arrived), 1795777000009);
  assert.equal(cid, "123456");
  // Déjà lu : rien n'est écrit.
  const again = (await p.run("chatgesture", { kind: "markread", thread: GROUP_ID })).result;
  assert.equal(again.already, true);
  assert.equal(writes.length, 1);
});

test("chatgesture send : HTML du composeur (échappé, liens), prouvé par son clientmessageid", async () => {
  const p = teamsPage();
  p.ctx.crypto = globalThis.crypto;
  await withTeamsBearer(p);
  const messages: any = {};
  const writes = chatServer(p, messages);
  const text = "Voir <script>x</script> & https://github.com/o/r/pull/1.\n\nMerci";
  const r = (await p.run("chatgesture", { kind: "send", thread: GROUP_ID, text })).result;
  assert.equal(r.ok, true);
  assert.equal(writes.length, 1);
  const b = writes[0].body;
  assert.equal(writes[0].method, "POST");
  assert.equal(b.messagetype, "RichText/Html");
  assert.equal(b.imdisplayname, "Damien B");
  assert.match(b.clientmessageid, /^\d{19}$/);
  assert.equal(
    b.content,
    '<p>Voir &lt;script&gt;x&lt;/script&gt; &amp; <a href="https://github.com/o/r/pull/1" title="https://github.com/o/r/pull/1" target="_blank" rel="noreferrer noopener">https://github.com/o/r/pull/1</a>.</p><p>&nbsp;</p><p>Merci</p>',
  );
  assert.equal(r.id, Object.keys(messages)[0]);
  // Uniquement la première adresse du service : jamais de second envoi.
  assert.ok(writes[0].url.startsWith("https://emea.ng.msg.teams.microsoft.com/"));
});

test("chatgesture send en réponse : citation écrite comme Teams (id, auteur, heure, extrait), prouvée relue", async () => {
  const p = teamsPage();
  p.ctx.crypto = globalThis.crypto;
  await withTeamsBearer(p);
  const messages: any = {
    "1795777000001": msgRaw("1795777000001", { imdisplayname: "Ana Martin", content: "<p>On livre <b>vendredi</b> ?</p>" }),
  };
  const writes = chatServer(p, messages);
  const reply = { id: "1795777000001", sender: "Ana Martin", text: "On livre vendredi ?" };
  const r = (await p.run("chatgesture", { kind: "send", thread: GROUP_ID, text: "Oui", reply })).result;
  assert.equal(r.ok, true);
  assert.equal(writes.length, 1);
  const html = writes[0].body.content;
  assert.match(html, /^<blockquote itemscope itemtype="http:\/\/schema\.skype\.com\/Reply" itemid="1795777000001">/);
  assert.match(html, /<strong itemprop="mri" itemid="8:orgid:[^"]+">Ana Martin<\/strong>/);
  assert.match(html, /<span itemprop="time" itemid="\d{13}"><\/span>/);
  assert.match(html, /<p itemprop="preview">On livre vendredi \?<\/p><\/blockquote><p>Oui<\/p>$/);
});

test("chatgesture send en réponse : message cité différent de celui affiché → rien ne part", async () => {
  const p = teamsPage();
  p.ctx.crypto = globalThis.crypto;
  await withTeamsBearer(p);
  const messages: any = { "1795777000001": msgRaw("1795777000001", { imdisplayname: "Ana Martin", content: "<p>Autre chose</p>" }) };
  const writes = chatServer(p, messages);
  const r = (await p.run("chatgesture", { kind: "send", thread: GROUP_ID, text: "Oui", reply: { id: "1795777000001", sender: "Ana Martin", text: "On livre vendredi ?" } })).result;
  assert.equal(r.ok, false);
  assert.equal(r.attempted, false);
  assert.equal(writes.length, 0);
});

test("chatgesture send avec mention : un élément par mot, liste properties.mentions, prouvée relue", async () => {
  const p = teamsPage();
  p.ctx.crypto = globalThis.crypto;
  await withTeamsBearer(p);
  const messages: any = { "1795777000001": msgRaw("1795777000001") }; // Ana Martin a écrit dans le fil
  const writes = chatServer(p, messages);
  const r = (await p.run("chatgesture", { kind: "send", thread: GROUP_ID, text: "@Ana Martin tu valides <ça> ?", mentions: ["Ana Martin"] })).result;
  assert.equal(r.ok, true);
  assert.equal(writes.length, 1);
  const b = writes[0].body;
  assert.equal(
    b.content,
    '<p><span itemscope itemtype="http://schema.skype.com/Mention" itemid="0">Ana</span> <span itemscope itemtype="http://schema.skype.com/Mention" itemid="1">Martin</span> tu valides &lt;ça&gt; ?</p>',
  );
  assert.deepEqual(JSON.parse(b.properties.mentions), [
    { "@type": "http://schema.skype.com/Mention", itemid: 0, mri: "8:orgid:ana", mentionType: "person", displayName: "Ana" },
    { "@type": "http://schema.skype.com/Mention", itemid: 1, mri: "8:orgid:ana", mentionType: "person", displayName: "Martin" },
  ]);
});

test("chatgesture send avec mention : personne absente du fil ou homonymes → rien ne part", async () => {
  const p = teamsPage();
  p.ctx.crypto = globalThis.crypto;
  await withTeamsBearer(p);
  const messages: any = {
    "1795777000001": msgRaw("1795777000001"),
    "1795777000002": msgRaw("1795777000002", { from: "https://x/v1/users/ME/contacts/8:orgid:ana2" }),
  };
  const writes = chatServer(p, messages);
  const absent = (await p.run("chatgesture", { kind: "send", thread: GROUP_ID, text: "@Marc oui", mentions: ["Marc"] })).result;
  assert.equal(absent.ok, false);
  assert.equal(absent.attempted, false);
  const twins = (await p.run("chatgesture", { kind: "send", thread: GROUP_ID, text: "@Ana Martin oui", mentions: ["Ana Martin"] })).result;
  assert.equal(twins.attempted, false);
  assert.match(twins.error, /plusieurs/);
  assert.equal(writes.length, 0);
});

test("chatgesture send : réseau coupé pendant l'envoi → incertain, aucun second envoi", async () => {
  const p = teamsPage();
  p.ctx.crypto = globalThis.crypto;
  await withTeamsBearer(p);
  const posts: string[] = [];
  p.setResponse((url: string, init: any) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    if (url.includes("fetchShortProfile")) return fakeResponse(JSON.stringify({ value: [] }));
    if (init && init.method === "POST") {
      posts.push(url);
      throw new TypeError("Failed to fetch");
    }
    return fakeResponse(JSON.stringify({ messages: [] }));
  });
  const r = (await p.run("chatgesture", { kind: "send", thread: GROUP_ID, text: "Bonjour" })).result;
  assert.equal(r.ok, false);
  assert.equal(r.uncertain, true);
  assert.equal(posts.length, 1);
});

test("chatgesture : conversation sans id Teams, rien ne part", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const before = p.fetchCalls.length;
  const r = (await p.run("chatgesture", { kind: "send", thread: "name:Ana", text: "x" })).result;
  assert.equal(r.attempted, false);
  assert.equal(p.fetchCalls.length, before);
});

// --- Présence, note de statut, recherche de personnes (op teamspeople) -------------------
const presenceServer = (p: any, state: any) => {
  const calls: Array<{ url: string; method: string; body: any; auth: string }> = [];
  p.setResponse((url: string, init: any) => {
    const method = (init && init.method) || "GET";
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body, auth: (init && init.headers && init.headers.Authorization) || "" });
    if (url.endsWith("/v1/me/presence")) return fakeResponse(JSON.stringify(state.me));
    if (url.endsWith("/v1/me/publishnote")) {
      state.me.note = { message: body.message, expiry: body.expiry };
      return fakeResponse("", { status: 200 });
    }
    if (url.endsWith("/v1/me/forceavailability/")) {
      if (state.refuse) return fakeResponse("{}", { status: state.refuse });
      if (!state.ignore) state.me.forcedAvailability = body ? { availability: body.availability, expiry: body.desiredExpirationTime } : undefined;
      if (body) state.me.availability = body.availability;
      return fakeResponse("", { status: 200 });
    }
    if (url.endsWith("/presence/getpresence/")) return fakeResponse(JSON.stringify(body.map((x: any) => ({ mri: x.mri, presence: { availability: "Busy", activity: "InAMeeting" } }))));
    if (url.includes("/users/searchV2")) return fakeResponse(JSON.stringify({ value: [{ displayName: "Ana Martin", mri: "8:orgid:ana", email: "ana@x" }, { displayName: "" }] }));
    return fakeResponse("{}", { status: 404 });
  });
  return calls;
};

test("teamspeople : présence et note lues avec le bearer de Teams, rien d'autre ne sort", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const calls = presenceServer(p, { me: { availability: "Busy", activity: "InAMeeting", note: { message: "<p>Atelier &amp; démo</p><p>&nbsp;</p>", expiry: "2099-01-01T10:00:00.000Z" } } });
  const r = (await p.run("teamspeople", { kind: "me" })).result;
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { ok: true, availability: "Busy", activity: "InAMeeting", ooo: false, note: { message: "Atelier & démo", expiry: "2099-01-01T10:00:00.000Z" }, forced: { availability: "", expiry: "" } });
  assert.equal(calls[0].url, "https://presence.teams.microsoft.com/v1/me/presence");
  assert.equal(calls[0].auth, "Bearer MT-SECRET");
  assert.ok(!/MT-SECRET/.test(JSON.stringify(r)));
  const of = (await p.run("teamspeople", { kind: "of", mris: ["8:orgid:ana", "pas-un-mri", "8:orgid:ana"] })).result;
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body)), [{ mri: "8:orgid:ana" }]);
  assert.equal(of.people["8:orgid:ana"].activity, "InAMeeting");
});

test("teamspeople note : écrite avec l'échéance donnée, prouvée en relisant", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const state = { me: { availability: "Busy", note: { message: "Atelier", expiry: "2099-01-01T10:00:00.000Z" } } };
  const calls = presenceServer(p, state);
  const r = (await p.run("teamspeople", { kind: "note", message: "  Retour   lundi ", expiry: "2099-01-01T10:00:00.000Z" })).result;
  assert.equal(r.ok, true);
  assert.equal(r.message, "Retour lundi");
  const put = calls.find((c) => c.method === "PUT")!;
  assert.equal(put.url, "https://presence.teams.microsoft.com/v1/me/publishnote");
  // Écrite comme Teams : un paragraphe HTML, texte échappé.
  assert.deepEqual(put.body, { message: "<p>Retour lundi</p>", expiry: "2099-01-01T10:00:00.000Z" });
  // Échéance invalide : rien ne part.
  const before = calls.length;
  const bad = (await p.run("teamspeople", { kind: "note", message: "x", expiry: "demain" })).result;
  assert.equal(bad.ok, false);
  assert.equal(bad.attempted, false);
  assert.equal(calls.length, before);
});

test("teamspeople force : le statut choisi part comme le menu de Teams et se prouve en relisant", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const state: any = { me: { availability: "Available", activity: "Available" } };
  const calls = presenceServer(p, state);
  const r = (await p.run("teamspeople", { kind: "force", availability: "DoNotDisturb", expiry: "2099-01-01T10:00:00.000Z" })).result;
  assert.equal(r.ok, true);
  assert.equal(r.forced.availability, "DoNotDisturb");
  const put = calls.find((c) => c.method === "PUT")!;
  assert.equal(put.url, "https://presence.teams.microsoft.com/v1/me/forceavailability/");
  assert.equal(put.auth, "Bearer MT-SECRET");
  assert.deepEqual(put.body, { availability: "DoNotDisturb", desiredExpirationTime: "2099-01-01T10:00:00.000Z" });
  assert.ok(!/MT-SECRET/.test(JSON.stringify(r)));
  // Hors ligne : l'activité « OffWork », comme Teams ; sans échéance : pas de desiredExpirationTime.
  await p.run("teamspeople", { kind: "force", availability: "Offline", expiry: "" });
  assert.deepEqual(calls.filter((c) => c.method === "PUT").pop()!.body, { availability: "Offline", activity: "OffWork" });
});

test("teamspeople reset : PUT sans corps, prouvé quand plus aucun statut n'est choisi", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const state: any = { me: { availability: "Busy", forcedAvailability: { availability: "Busy", expiry: "2099-01-01T10:00:00.000Z" } } };
  const calls = presenceServer(p, state);
  const r = (await p.run("teamspeople", { kind: "reset" })).result;
  assert.equal(r.ok, true);
  const put = calls.find((c) => c.method === "PUT")!;
  assert.equal(put.body, null);
});

test("teamspeople force : statut inconnu ou échéance invalide, rien ne part ; refus net, attempted sans doute", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const state: any = { me: { availability: "Available" } };
  const calls = presenceServer(p, state);
  for (const args of [{ availability: "Lunch" }, { availability: "Busy", expiry: "ce soir" }]) {
    const bad = (await p.run("teamspeople", { kind: "force", ...args })).result;
    assert.equal(bad.ok, false);
    assert.equal(bad.attempted, false);
  }
  assert.equal(calls.length, 0);
  state.refuse = 403;
  const refused = (await p.run("teamspeople", { kind: "force", availability: "Busy" })).result;
  assert.equal(refused.ok, false);
  assert.equal(refused.attempted, true);
  assert.ok(!refused.uncertain);
});

test("teamspeople force : parti mais jamais relu tel quel, incertain (jamais refait)", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const state: any = { me: { availability: "Available" }, ignore: true };
  presenceServer(p, state);
  const r = (await p.run("teamspeople", { kind: "force", availability: "Away" })).result;
  assert.equal(r.ok, false);
  assert.equal(r.uncertain, true);
});

test("teamspeople search : requête en chaîne JSON sur le middletier du locataire, noms seulement", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const calls = presenceServer(p, { me: {} });
  const r = (await p.run("teamspeople", { kind: "search", query: "  ana ", limit: 5 })).result;
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.people)), [{ name: "Ana Martin", mri: "8:orgid:ana", email: "ana@x" }]);
  assert.ok(calls[0].url.startsWith("https://teams.cloud.microsoft/api/mt/part/emea-03/beta/users/searchV2?"));
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body, "ana");
});

test("teamspeople sans jeton Teams observé : refus sans appel réseau", async () => {
  const p = teamsPage();
  const before = p.fetchCalls.length;
  const r = (await p.run("teamspeople", { kind: "me" })).result;
  assert.equal(r.ok, false);
  assert.equal(p.fetchCalls.length, before);
});

// --- Tête-à-tête trouvé ou créé sur le service (op chatdm) ---------------------------------
const dmServer = (p: any, state: { exists: boolean; refuse?: number }) => {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  p.setResponse((url: string, init: any) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    const method = (init && init.method) || "GET";
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    if (method === "POST" && url.endsWith("/v1/threads")) {
      if (state.refuse) return fakeResponse("{}", { status: state.refuse });
      state.exists = true;
      return fakeResponse("", { status: 201 });
    }
    if (url.includes("/v1/users/ME/conversations/")) {
      const id = decodeURIComponent(url.split("/conversations/")[1].split("?")[0]);
      return state.exists ? fakeResponse(JSON.stringify({ id })) : fakeResponse("{}", { status: 404 });
    }
    return fakeResponse("{}", { status: 404 });
  });
  return calls;
};
const DM_ID = `19:${ME_GUID}_${OTHER_GUID}@unq.gbl.spaces`; // guids triés, comme Teams

test("chatdm : tête-à-tête existant trouvé par son id calculé comme Teams, rien n'est écrit", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const calls = dmServer(p, { exists: true });
  const r = (await p.run("chatdm", { mri: `8:orgid:${OTHER_GUID}` })).result;
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { ok: true, id: DM_ID, created: false });
  assert.ok(!calls.some((c) => c.method !== "GET"));
});

test("chatdm : tête-à-tête absent créé comme Teams (uniquerosterthread), puis relu", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const calls = dmServer(p, { exists: false });
  const r = (await p.run("chatdm", { mri: `8:orgid:${OTHER_GUID}` })).result;
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.id, DM_ID);
  const post = calls.find((c) => c.method === "POST")!;
  assert.ok(post.url.endsWith("/v1/threads"));
  assert.deepEqual(post.body, {
    members: [{ id: `8:orgid:${ME_GUID}`, role: "Admin" }, { id: `8:orgid:${OTHER_GUID}`, role: "Admin" }],
    properties: { threadType: "chat", chatFilesIndexId: "2", fixedRoster: true, uniquerosterthread: true },
  });
});

test("chatdm : identifiant inattendu, soi-même ou création refusée → la page", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const calls = dmServer(p, { exists: false, refuse: 403 });
  for (const mri of ["pas-un-mri", `8:orgid:${ME_GUID}`]) {
    const r = (await p.run("chatdm", { mri })).result;
    assert.equal(r.ok, false);
    assert.equal(r.attempted, false);
  }
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  const refused = (await p.run("chatdm", { mri: `8:orgid:${OTHER_GUID}` })).result;
  assert.equal(refused.ok, false);
  assert.equal(refused.attempted, false);
  assert.match(refused.error, /403/);
});

test("meetingshapes : structure des conversations de réunion seulement, jamais de texte", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const MEET = "19:meeting_abc@thread.v2";
  p.setResponse((url: string) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    if (url.includes(`/conversations/${encodeURIComponent(MEET)}/messages`))
      return fakeResponse(JSON.stringify({ messages: [
        { id: "1795777000001", messagetype: "Event/Call", content: '<partlist type="ended"><part identity="x"><name>Ana Secret</name></part></partlist>', properties: { callId: "c1" } },
        { id: "1795777000002", messagetype: "RichText/Html", content: "<p>texte secret</p>", properties: {} },
      ] }));
    if (url.includes("/v1/users/ME/conversations"))
      return fakeResponse(JSON.stringify({ conversations: [
        { id: MEET, threadProperties: { productThreadType: "Meeting", topic: "Sujet secret", meeting: JSON.stringify({ subject: "Sujet secret", organizerId: "o" }) } },
        { id: "19:grp@thread.v2", threadProperties: { topic: "Groupe" } },
      ] }));
    return fakeResponse("{}", { status: 404 });
  });
  const r = (await p.run("meetingshapes", {})).result;
  assert.equal(r.ok, true);
  assert.equal(r.chats.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(r.chats[0].messages[0])), { id: "1795777000001", type: "Event/Call", root: "partlist", tags: ["partlist", "part", "name"], props: ["callId"], startShape: "", endShape: "" });
  assert.deepEqual(JSON.parse(JSON.stringify(r.chats[0].meetingKeys)), ["subject", "organizerId"]);
  assert.ok(!/secret/i.test(JSON.stringify(r)));
});

test("chatsearch : chaque mot présent (casse et accents ignorés), fils récents d'abord, sans jeton", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const DM = `19:${ME_GUID}_${OTHER_GUID}@unq.gbl.spaces`;
  const GRP = "19:grp@thread.v2";
  const msgs: Record<string, any[]> = {
    [GRP]: [
      { id: "1795777000003", messagetype: "RichText/Html", imdisplayname: "Ana Martin", from: "https://x/v1/users/ME/contacts/8:orgid:ana", originalarrivaltime: new Date(1795777000003).toISOString(), content: "<p>La PR #214 est prête pour la RÉVISION</p>", properties: {} },
      { id: "1795777000002", messagetype: "RichText/Html", imdisplayname: "Ana Martin", from: "https://x/v1/users/ME/contacts/8:orgid:ana", originalarrivaltime: new Date(1795777000002).toISOString(), content: "<p>Supprimé</p>", properties: { deletetime: "1" } },
      { id: "1795777000001", messagetype: "Event/Call", content: "<partlist/>", properties: {} },
    ],
    [DM]: [
      { id: "1795777000005", messagetype: "RichText/Html", imdisplayname: "Damien B", from: `https://x/v1/users/ME/contacts/8:orgid:${ME_GUID}`, originalarrivaltime: new Date(1795777000005).toISOString(), content: "<p>Je fais la revision de la PR ce soir</p>", properties: {} },
    ],
  };
  p.setResponse((url: string) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    if (url.includes("fetchShortProfile")) return fakeResponse(JSON.stringify({ value: [{ mri: `8:orgid:${OTHER_GUID}`, displayName: "Marc Petit" }] }));
    for (const id of Object.keys(msgs)) if (url.includes(`/conversations/${encodeURIComponent(id)}/messages`)) return fakeResponse(JSON.stringify({ messages: msgs[id] }));
    if (url.includes("/v1/users/ME/conversations"))
      return fakeResponse(JSON.stringify({ conversations: [
        { id: GRP, threadProperties: { topic: "Équipe Interop" }, lastMessage: { id: "1795777000003", originalarrivaltime: new Date(1795777000003).toISOString() } },
        { id: DM, threadProperties: {}, lastMessage: { id: "1795777000005", originalarrivaltime: new Date(1795777000005).toISOString() } },
      ] }));
    return fakeResponse("{}", { status: 404 });
  });
  const r = (await p.run("chatsearch", { query: "pr revision" })).result;
  assert.equal(r.ok, true);
  assert.equal(r.scanned, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(r.results.map((h: any) => [h.conversation, h.sender, h.mine, h.text]))), [
    ["Marc Petit", "Damien B", true, "Je fais la revision de la PR ce soir"],
    ["Équipe Interop", "Ana Martin", false, "La PR #214 est prête pour la RÉVISION"],
  ]);
  assert.ok(!/MT-SECRET|skypetoken/i.test(JSON.stringify(r)));
  const short = (await p.run("chatsearch", { query: "a" })).result;
  assert.equal(short.ok, false);
});

test("chatsearch : lectures en parallèle (4 au plus), cadencées à 8 par seconde, cache tant que rien ne bouge", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const ids = Array.from({ length: 8 }, (_, i) => `19:c${i}@thread.v2`);
  const last: Record<string, string> = Object.fromEntries(ids.map((id, i) => [id, String(1795777000000 + i)]));
  let inFlight = 0;
  let peak = 0;
  const starts: number[] = [];
  const reads: string[] = [];
  p.setResponse(async (url: string) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    const hit = ids.find((id) => url.includes(`/conversations/${encodeURIComponent(id)}/messages`));
    if (hit) {
      reads.push(hit);
      starts.push(Date.now());
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 300)); // latence réseau
      inFlight--;
      return fakeResponse(JSON.stringify({ messages: [
        { id: last[hit], messagetype: "RichText/Html", imdisplayname: "Ana Martin", from: "https://x/v1/users/ME/contacts/8:orgid:ana", originalarrivaltime: new Date(Number(last[hit])).toISOString(), content: `<p>bilan ${hit}</p>`, properties: {} },
      ] }));
    }
    if (url.includes("/v1/users/ME/conversations"))
      return fakeResponse(JSON.stringify({ conversations: ids.map((id) => ({ id, threadProperties: { topic: id }, lastMessage: { id: last[id], originalarrivaltime: new Date(Number(last[id])).toISOString() } })) }));
    return fakeResponse("{}", { status: 404 });
  });
  const t0 = Date.now();
  const r = (await p.run("chatsearch", { query: "bilan" })).result;
  const took = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 8);
  assert.equal(reads.length, 8);
  assert.ok(peak > 1 && peak <= 4, `en parallèle : ${peak}`);
  // Une par une, 8 lectures de 300 ms prenaient plus de 2,4 s.
  assert.ok(took < 1800, `durée ${took} ms`);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  assert.ok(gaps.every((g) => g >= 110), `départs trop rapprochés : ${gaps}`);
  // Même recherche, rien n'a bougé : aucune relecture des messages.
  reads.length = 0;
  const again = (await p.run("chatsearch", { query: "bilan c3" })).result;
  assert.equal(reads.length, 0);
  assert.equal(again.results.length, 1);
  // Un nouveau message dans une conversation : seule celle-là est relue.
  last[ids[5]] = "1795777009999";
  await p.run("chatsearch", { query: "bilan" });
  assert.deepEqual(reads, [ids[5]]);
});

test("chatmeetings : conversations lues en parallèle, résultats dans l'ordre demandé", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const ids = Array.from({ length: 6 }, (_, i) => `19:meeting_m${i}@thread.v2`);
  let inFlight = 0;
  let peak = 0;
  p.setResponse(async (url: string) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    const i = ids.findIndex((id) => url.includes(`/conversations/${encodeURIComponent(id)}/messages`));
    if (i >= 0) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 50 * (6 - i))); // les premières répondent le plus tard
      inFlight--;
      return fakeResponse(JSON.stringify({ messages: [] }));
    }
    return fakeResponse("{}", { status: 404 });
  });
  const r = (await p.run("chatmeetings", { threads: ids })).result;
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.chats.map((c: any) => c.thread))), ids);
  assert.ok(peak > 1 && peak <= 4, `en parallèle : ${peak}`);
});

test("chatgesture hide : propriété « hidden » de la conversation, prouvée relue ; déjà dans l'état voulu, rien n'est écrit", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const conv: any = { properties: {} };
  const writes: any[] = [];
  p.setResponse((url: string, init: any) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    const method = (init && init.method) || "GET";
    if (method === "PUT" && url.includes("/properties?name=hidden")) {
      const body = JSON.parse(init.body);
      writes.push({ url, body });
      conv.properties.hidden = body.hidden;
      return fakeResponse("", { status: 200 });
    }
    if (url.includes(`/conversations/${encodeURIComponent(GROUP_ID)}`)) return fakeResponse(JSON.stringify(conv));
    return fakeResponse("{}", { status: 404 });
  });
  const r = (await p.run("chatgesture", { kind: "hide", thread: GROUP_ID, hidden: true })).result;
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].body)), { hidden: "true" });
  const again = (await p.run("chatgesture", { kind: "hide", thread: GROUP_ID, hidden: true })).result;
  assert.equal(again.already, true);
  const back = (await p.run("chatgesture", { kind: "hide", thread: GROUP_ID, hidden: false })).result;
  assert.equal(back.ok, true);
  assert.equal(conv.properties.hidden, "false");
  assert.equal(writes.length, 2);
});

test("les ops du pont ont des noms uniques : une clé en double écraserait silencieusement la première", () => {
  const start = BRIDGE.indexOf("const ops = {");
  assert.ok(start > 0);
  const names = [...BRIDGE.slice(start).matchAll(/^    ([a-z]+): (?:async )?\(/gm)].map((m) => m[1]);
  const seen = new Set<string>();
  const twice = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
  assert.deepEqual(twice, []);
  assert.ok(names.includes("react") && names.includes("reactlast"));
});

test("chatgesture send : deux personnes mentionnées côte à côte, relues séparément, envoi prouvé", async () => {
  const p = teamsPage();
  p.ctx.crypto = globalThis.crypto;
  await withTeamsBearer(p);
  const messages: any = {
    "1795777000001": msgRaw("1795777000001"),
    "1795777000002": msgRaw("1795777000002", { imdisplayname: "Marc Dupont", from: "https://x/v1/users/ME/contacts/8:orgid:marc" }),
  };
  chatServer(p, messages);
  const r = (await p.run("chatgesture", { kind: "send", thread: GROUP_ID, text: "@Ana Martin @Marc Dupont on se voit ?", mentions: ["Ana Martin", "Marc Dupont"] })).result;
  assert.equal(r.ok, true, r.error);
  const sent = Object.values(messages).find((m: any) => m.clientmessageid) as any;
  const back = (await p.run("chatread", { thread: GROUP_ID, last: 10 })).result;
  const mine = back.messages.find((m: any) => m.id === String(sent.id));
  assert.deepEqual(JSON.parse(JSON.stringify(mine.mentions)), ["Ana Martin", "Marc Dupont"]);
});

test("chatread : toutes les réactions du message, avec leur nombre et la mienne, quelle que soit la clé", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const messages: any = {
    "1795777000001": msgRaw("1795777000001", {
      properties: {
        emotions: JSON.stringify([
          { key: "like", users: [{ mri: MY_MRI, time: 1 }, { mri: "8:orgid:ana", time: 2 }] },
          { key: "1f44f_clappinghands", users: [{ mri: "8:orgid:ana", time: 3 }] },
          { key: "Pas une clé!", users: [{ mri: "8:orgid:ana", time: 4 }] },
          { key: "sad", users: [] },
        ]),
      },
    }),
  };
  chatServer(p, messages);
  const r = (await p.run("chatread", { thread: GROUP_ID, last: 5 })).result;
  const m = r.messages[0];
  assert.deepEqual(JSON.parse(JSON.stringify(m.reactions)), ["like"]);
  assert.deepEqual(JSON.parse(JSON.stringify(m.reactionCounts)), [
    { key: "like", count: 2, mine: true },
    { key: "1f44f_clappinghands", count: 1, mine: false },
  ]);
});

test("chatmeetings : une carte par fin d'appel (mid = message de fin), créneau prévu, transcription détectée", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const MEET = "19:meeting_YTM1abc@thread.v2";
  const iso = (s: string) => new Date(s).toISOString();
  const start = new Date("2026-11-27T11:00:48").getTime();
  const end = new Date("2026-11-27T11:20:16").getTime();
  const msgs = [
    { id: String(start), messagetype: "Event/Call", content: `<partlist type="started"><meetingdetails><starttime>${iso("2026-11-27T11:00:00")}</starttime><endtime>${iso("2026-11-27T11:20:00")}</endtime></meetingdetails></partlist>` },
    { id: String(start + 2070), messagetype: "RichText/Media_CallTranscript", content: "" },
    { id: String(start + 9000), messagetype: "RichText/Html", content: "<p>Bonjour</p>" },
    { id: String(end), messagetype: "Event/Call", content: "<ended/><partlist type=\"ended\"><part><name>x</name><duration>1168</duration></part></partlist>" },
    // Une occurrence sans transcription et sans créneau prévu : heures réelles.
    { id: String(end + 86400000), messagetype: "Event/Call", content: "<partlist type=\"started\"></partlist>" },
    { id: String(end + 86400000 + 600000), messagetype: "Event/Call", content: "<ended/>" },
  ];
  p.setResponse((url: string) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    if (url.includes(`/conversations/${encodeURIComponent(MEET)}/messages`)) return fakeResponse(JSON.stringify({ messages: msgs.slice().reverse() }));
    return fakeResponse("{}", { status: 404 });
  });
  const r = (await p.run("chatmeetings", { threads: [MEET, "pas-un-id-teams", "19:x@thread.tacv2"] })).result;
  assert.equal(r.ok, true);
  assert.equal(r.chats.length, 1);
  const [later, first] = r.chats[0].recaps;
  assert.equal(first.mid, String(end));
  assert.equal(first.when, "vendredi 27 novembre 2026 11:00 - 11:20");
  assert.equal(first.transcript, true);
  assert.equal(later.transcript, false);
  assert.equal(later.when, "samedi 28 novembre 2026 11:20 - 11:30");
});

test("chatmeetings : appels transcrits d'un groupe et d'un tête-à-tête aussi (seuls les transcrits)", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const GROUP = "19:abc123def@thread.v2";
  const DM = "19:11111111-1111-1111-1111-111111111111_22222222-2222-2222-2222-222222222222@unq.gbl.spaces";
  const t0 = new Date("2026-11-26T14:00:05").getTime();
  // Un appel transcrit (« Réunion maintenant »), puis un appel sans transcription : seul le premier compte.
  const calls = (base: number) => [
    { id: String(base), messagetype: "Event/Call", content: '<partlist type="started" alt=""></partlist>' },
    { id: String(base + 60000), messagetype: "RichText/Media_CallTranscript", content: "" },
    { id: String(base + 1800000), messagetype: "Event/Call", content: "<ended/><partlist type=\"ended\"></partlist>" },
    { id: String(base + 7200000), messagetype: "Event/Call", content: '<partlist type="started"></partlist>' },
    { id: String(base + 7500000), messagetype: "Event/Call", content: "<ended/>" },
  ];
  p.setResponse((url: string) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    if (url.includes(`/conversations/${encodeURIComponent(GROUP)}/messages`)) return fakeResponse(JSON.stringify({ messages: calls(t0).reverse() }));
    if (url.includes(`/conversations/${encodeURIComponent(DM)}/messages`)) return fakeResponse(JSON.stringify({ messages: calls(t0 + 86400000).reverse() }));
    return fakeResponse("{}", { status: 404 });
  });
  const r = (await p.run("chatmeetings", { threads: [GROUP, DM], topics: { [GROUP]: "Projet X" } })).result;
  assert.equal(r.ok, true);
  const [g, d] = r.chats;
  assert.equal(g.thread, GROUP);
  assert.equal(g.recaps.length, 1);
  assert.equal(g.recaps[0].mid, String(t0 + 1800000));
  assert.equal(g.recaps[0].transcript, true);
  assert.equal(g.recaps[0].when, "jeudi 26 novembre 2026 14:00 - 14:30");
  assert.equal(d.thread, DM);
  assert.equal(d.recaps.length, 1);
  assert.equal(d.recaps[0].when, "vendredi 27 novembre 2026 14:00 - 14:30");
});

test("chatmeetings : remonte les pages précédentes (au plus 3) pour un appel plus ancien", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const GROUP = "19:busy@thread.v2";
  const t0 = new Date("2026-11-20T10:00:00").getTime();
  const older = [
    { id: String(t0), messagetype: "Event/Call", content: '<partlist type="started"></partlist>' },
    { id: String(t0 + 1000), messagetype: "RichText/Media_CallTranscript", content: "" },
    { id: String(t0 + 600000), messagetype: "Event/Call", content: "<ended/>" },
  ];
  const recent = Array.from({ length: 5 }, (_, i) => ({ id: String(t0 + 86400000 + i), messagetype: "RichText/Html", content: "<p>x</p>" }));
  const seen: string[] = [];
  p.setResponse((url: string) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    if (url.includes(`/conversations/${encodeURIComponent(GROUP)}/messages`)) {
      seen.push(url);
      const back = `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/conversations/${encodeURIComponent(GROUP)}/messages?view=msnp24Equivalent&pageSize=200&startTime=${t0 + 86400000}`;
      if (url.includes("startTime=")) return fakeResponse(JSON.stringify({ messages: older.slice().reverse(), _metadata: {} }));
      return fakeResponse(JSON.stringify({ messages: recent.slice().reverse(), _metadata: { backwardLink: back } }));
    }
    return fakeResponse("{}", { status: 404 });
  });
  const r = (await p.run("chatmeetings", { threads: [GROUP] })).result;
  assert.equal(seen.length, 2);
  assert.equal(r.chats[0].recaps.length, 1);
  assert.equal(r.chats[0].recaps[0].mid, String(t0 + 600000));
});

test("chatmeetings : heures prévues en UTC sans « Z » (relevé en direct), réunion récurrente au jour de l'appel", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const MEET = "19:meeting_serie@thread.v2";
  // L'appel du 26/11 à 09:01 (heure locale), d'une série commencée le 15/10 à 09:00 - 09:20 locales.
  const start = new Date("2026-11-26T09:01:10").getTime();
  const end = new Date("2026-11-26T09:24:00").getTime();
  const utc = (local: string) => new Date(local).toISOString().replace(/\.\d{3}Z$/, ""); // sans « Z »
  const msgs = [
    { id: String(start), messagetype: "Event/Call", content: `<partlist><meetingdetails><starttime>${utc("2026-10-15T09:00:00")}</starttime><endtime>${utc("2026-10-15T09:20:00")}</endtime></meetingdetails></partlist>` },
    { id: String(end), messagetype: "Event/Call", content: "<ended/>" },
  ];
  p.setResponse((url: string) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    if (url.includes(`/conversations/${encodeURIComponent(MEET)}/messages`)) return fakeResponse(JSON.stringify({ messages: msgs }));
    return fakeResponse("{}", { status: 404 });
  });
  const r = (await p.run("chatmeetings", { threads: [MEET] })).result;
  assert.equal(r.chats[0].recaps[0].when, "jeudi 26 novembre 2026 09:00 - 09:20");
});

test("chatmeetings : heure prévue sans fuseau au format américain lue en UTC aussi", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const MEET = "19:meeting_format@thread.v2";
  const start = new Date("2026-11-26T09:00:30").getTime();
  const end = new Date("2026-11-26T10:00:10").getTime();
  const us = (local: string) => {
    const d = new Date(local);
    const z = (n: number) => String(n).padStart(2, "0");
    return `${z(d.getUTCMonth() + 1)}/${z(d.getUTCDate())}/${d.getUTCFullYear()} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:00`;
  };
  const msgs = [
    { id: String(start), messagetype: "Event/Call", content: `<partlist><meetingdetails><starttime>${us("2026-11-26T09:00:00")}</starttime><endtime>${us("2026-11-26T10:00:00")}</endtime></meetingdetails></partlist>` },
    { id: String(end), messagetype: "Event/Call", content: "<ended/>" },
  ];
  p.setResponse((url: string) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    if (url.includes(`/conversations/${encodeURIComponent(MEET)}/messages`)) return fakeResponse(JSON.stringify({ messages: msgs }));
    return fakeResponse("{}", { status: 404 });
  });
  const r = (await p.run("chatmeetings", { threads: [MEET] })).result;
  assert.equal(r.chats[0].recaps[0].when, "jeudi 26 novembre 2026 09:00 - 10:00");
});

test("chatmeetings : une occurrence déplacée garde le créneau porté par son message de fin", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const MEET = "19:meeting_deplacee@thread.v2";
  const start = new Date("2026-11-24T11:01:05").getTime();
  const end = new Date("2026-11-24T12:11:22").getTime();
  const us = (local: string) => {
    const d = new Date(local);
    const z = (n: number) => String(n).padStart(2, "0");
    return `${z(d.getUTCMonth() + 1)}/${z(d.getUTCDate())}/${d.getUTCFullYear()} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:00`;
  };
  const slot = (a: string, b: string) => `<meetingdetails><starttime>${us(a)}</starttime><endtime>${us(b)}</endtime></meetingdetails>`;
  const msgs = [
    { id: String(start), messagetype: "Event/Call", content: `<partlist>${slot("2026-10-15T11:00:00", "2026-10-15T11:20:00")}</partlist>` },
    { id: String(end), messagetype: "Event/Call", content: `<ended/><partlist>${slot("2026-11-24T11:00:00", "2026-11-24T11:45:00")}</partlist>` },
  ];
  p.setResponse((url: string) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    if (url.includes(`/conversations/${encodeURIComponent(MEET)}/messages`)) return fakeResponse(JSON.stringify({ messages: msgs }));
    return fakeResponse("{}", { status: 404 });
  });
  const r = (await p.run("chatmeetings", { threads: [MEET] })).result;
  assert.equal(r.chats[0].recaps[0].when, "mardi 24 novembre 2026 11:00 - 11:45");
});

test("chatmeetings : l'agenda (Graph) donne le créneau d'une occurrence déplacée, seulement sans ambiguïté", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  // Teams a déjà appelé Graph : son jeton est connu de la page.
  await p.ctx.window.fetch("https://graph.microsoft.com/v1.0/me/events", { headers: { authorization: "Bearer GRAPH-SECRET" } });
  await new Promise((r) => setImmediate(r));
  const MEET = "19:meeting_deplacee2@thread.v2";
  const start = new Date("2026-11-24T11:01:05").getTime();
  const end = new Date("2026-11-24T12:11:22").getTime();
  const msgs = [
    { id: String(start), messagetype: "Event/Call", content: "<partlist></partlist>" },
    { id: String(end), messagetype: "Event/Call", content: "<ended/>" },
  ];
  const utc = (local: string) => new Date(local).toISOString().replace(/Z$/, "0000");
  let events: any[] = [
    { subject: "Point hebdo", start: { dateTime: utc("2026-11-24T11:00:00") }, end: { dateTime: utc("2026-11-24T11:45:00") } },
    { subject: "Autre réunion", start: { dateTime: utc("2026-11-24T11:00:00") }, end: { dateTime: utc("2026-11-24T12:00:00") } },
  ];
  const graphAuth: string[] = [];
  p.setResponse((url: string, init: any) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    if (url.startsWith("https://graph.microsoft.com/v1.0/me/calendarView")) {
      graphAuth.push((init && init.headers && init.headers.Authorization) || "");
      return fakeResponse(JSON.stringify({ value: events }));
    }
    if (url.includes(`/conversations/${encodeURIComponent(MEET)}/messages`)) return fakeResponse(JSON.stringify({ messages: msgs }));
    return fakeResponse("{}", { status: 404 });
  });
  const r = (await p.run("chatmeetings", { threads: [MEET], topics: { [MEET]: "Point hebdo" } })).result;
  assert.equal(r.chats[0].recaps[0].when, "mardi 24 novembre 2026 11:00 - 11:45");
  assert.equal(r.chats[0].recaps[0].calendar, true);
  assert.equal(graphAuth[0], "Bearer GRAPH-SECRET");
  assert.ok(!/GRAPH-SECRET/.test(JSON.stringify(r)));
  // Deux événements du même sujet : ambigu, le créneau de l'appel reste.
  events = [events[0], { ...events[0] }];
  const twice = (await p.run("chatmeetings", { threads: [MEET], topics: { [MEET]: "Point hebdo" } })).result;
  assert.equal(twice.chats[0].recaps[0].calendar, false);
  assert.equal(twice.chats[0].recaps[0].when, "mardi 24 novembre 2026 11:01 - 12:11");
});

test("chatmeetings : l'agenda reconnaît la réunion par sa conversation, même quand le sujet diffère", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  await p.ctx.window.fetch("https://graph.microsoft.com/v1.0/me/events", { headers: { authorization: "Bearer GRAPH-SECRET" } });
  await new Promise((r) => setImmediate(r));
  const MEET = "19:meeting_migration@thread.v2";
  const start = new Date("2026-11-24T11:02:00").getTime();
  const end = new Date("2026-11-24T11:40:00").getTime();
  const msgs = [
    { id: String(start), messagetype: "Event/Call", content: "<partlist></partlist>" },
    { id: String(end), messagetype: "Event/Call", content: "<ended/>" },
  ];
  const utc = (local: string) => new Date(local).toISOString().replace(/Z$/, "0000");
  const join = `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(MEET)}/0?context=x`;
  const events = [
    // Sujet de l'agenda différent du nom de la conversation : reconnue par le lien.
    { subject: "Suivi : Migration weekly", onlineMeeting: { joinUrl: join }, start: { dateTime: utc("2026-11-24T11:00:00") }, end: { dateTime: utc("2026-11-24T11:30:00") } },
    { subject: "Migration weekly", start: { dateTime: utc("2026-11-24T11:00:00") }, end: { dateTime: utc("2026-11-24T12:00:00") } },
  ];
  p.setResponse((url: string) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    if (url.startsWith("https://graph.microsoft.com/v1.0/me/calendarView")) return fakeResponse(JSON.stringify({ value: events }));
    if (url.includes(`/conversations/${encodeURIComponent(MEET)}/messages`)) return fakeResponse(JSON.stringify({ messages: msgs }));
    return fakeResponse("{}", { status: 404 });
  });
  const r = (await p.run("chatmeetings", { threads: [MEET], topics: { [MEET]: "Migration weekly" } })).result;
  assert.equal(r.chats[0].recaps[0].calendar, true);
  assert.equal(r.chats[0].recaps[0].when, "mardi 24 novembre 2026 11:00 - 11:30");
});

test("chatmeetings : un appel coupé puis relancé ne donne qu'une réunion (celle qui a la transcription)", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  const MEET = "19:meeting_coupee@thread.v2";
  const iso = (s: string) => new Date(s).toISOString();
  const details = `<meetingdetails><starttime>${iso("2026-11-25T15:00:00")}</starttime><endtime>${iso("2026-11-25T15:30:00")}</endtime></meetingdetails>`;
  const t = (s: string) => new Date(s).getTime();
  const msgs = [
    { id: String(t("2026-11-25T15:00:20")), messagetype: "Event/Call", content: `<partlist>${details}</partlist>` },
    { id: String(t("2026-11-25T15:03:00")), messagetype: "Event/Call", content: "<ended/>" },
    { id: String(t("2026-11-25T15:04:00")), messagetype: "Event/Call", content: `<partlist>${details}</partlist>` },
    { id: String(t("2026-11-25T15:05:00")), messagetype: "RichText/Media_CallTranscript", content: "" },
    { id: String(t("2026-11-25T15:29:00")), messagetype: "Event/Call", content: "<ended/>" },
  ];
  p.setResponse((url: string) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    if (url.includes(`/conversations/${encodeURIComponent(MEET)}/messages`)) return fakeResponse(JSON.stringify({ messages: msgs }));
    return fakeResponse("{}", { status: 404 });
  });
  const r = (await p.run("chatmeetings", { threads: [MEET] })).result;
  assert.equal(r.chats[0].recaps.length, 1);
  assert.equal(r.chats[0].recaps[0].mid, String(t("2026-11-25T15:29:00")));
  assert.equal(r.chats[0].recaps[0].transcript, true);
  assert.equal(r.chats[0].recaps[0].when, "mercredi 25 novembre 2026 15:00 - 15:30");
});

test("calendarevents : l'agenda de la période, signé avec le jeton Graph de Teams, pages suivies, rien d'autre que l'agenda", async () => {
  const p = teamsPage();
  await withTeamsBearer(p);
  await p.ctx.window.fetch("https://graph.microsoft.com/v1.0/me/events", { headers: { authorization: "Bearer GRAPH-SECRET" } });
  await new Promise((r) => setImmediate(r));
  const MEET = "19:meeting_abc@thread.v2";
  const CHANNEL = "19:canal42@thread.tacv2";
  const urls: string[] = [];
  const first = {
    value: [
      { id: "e1", subject: "Weekly Hexaflux", start: { dateTime: "2026-11-25T08:45:00.0000000" }, end: { dateTime: "2026-11-25T09:15:00.0000000" },
        isOnlineMeeting: true, onlineMeeting: { joinUrl: `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(MEET)}/0?context=%7b%7d` },
        organizer: { emailAddress: { name: "Ana Martin", address: "ana@x.test" } }, showAs: "busy", sensitivity: "normal", type: "occurrence", body: { content: "secret" } },
      { id: "e2", subject: "Out of the office", start: { dateTime: "2026-11-25T18:00:00.0000000" }, end: { dateTime: "2026-11-26T07:00:00.0000000" }, showAs: "oof", sensitivity: "normal" },
    ],
    "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skip=2",
  };
  const second = {
    value: [
      { id: "e3", subject: "Revue d'équipe", start: { dateTime: "2026-11-26T10:00:00.0000000" }, end: { dateTime: "2026-11-26T11:00:00.0000000" },
        onlineMeeting: { joinUrl: `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(CHANNEL)}/1700000000000?context=x` } },
      { id: "e4", subject: "Unsubscribe", isAllDay: true, start: { dateTime: "2026-11-25T00:00:00.0000000" }, end: { dateTime: "2026-11-26T00:00:00.0000000" }, sensitivity: "private" },
    ],
  };
  const auth: string[] = [];
  p.setResponse((url: string, init: any) => {
    if (url.includes("/authsvc/")) return fakeResponse(AUTHZ_TWO);
    if (url.startsWith("https://graph.microsoft.com/v1.0/me/calendarView")) {
      urls.push(url);
      auth.push((init && init.headers && init.headers.Authorization) || "");
      return fakeResponse(JSON.stringify(url.includes("$skip=2") ? second : first));
    }
    return fakeResponse("{}", { status: 404 });
  });
  const r = (await p.run("calendarevents", { start: "2026-11-23", end: "2026-11-29" })).result;
  assert.equal(r.ok, true, r.error);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes("isAllDay") && urls[0].includes("onlineMeeting"));
  assert.equal(auth[0], "Bearer GRAPH-SECRET");
  const text = JSON.stringify(r);
  assert.ok(!/GRAPH-SECRET|secret|ana@x\.test/.test(text), "ni jeton, ni corps, ni adresse");
  const [weekly, away, channel, allDay] = r.events;
  assert.equal(weekly.thread, MEET);
  assert.equal(weekly.start, "2026-11-25T08:45:00Z");
  assert.equal(weekly.organizer, "Ana Martin");
  assert.equal(weekly.online, true);
  assert.equal(weekly.recurring, true);
  assert.equal(away.show_as, "oof");
  assert.equal(away.online, false);
  assert.equal(channel.thread, CHANNEL);
  assert.equal(allDay.all_day, true);
  assert.equal(allDay.start_day, "2026-11-25");
  assert.equal(allDay.private, true);
  // Période illisible ou trop longue : refusée sans appel.
  assert.equal((await p.run("calendarevents", { start: "2026-11-23", end: "x" })).result.ok, false);
  assert.equal((await p.run("calendarevents", { start: "2026-01-01", end: "2026-12-31" })).result.ok, false);
  assert.equal(urls.length, 2);
});

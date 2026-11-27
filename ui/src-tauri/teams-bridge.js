(() => {
  // Transcription d'une réunion : Teams l'affiche dans une iframe SharePoint
  // (xplatplugins.aspx, onglet « Transcript » du récapitulatif). Ce script est injecté
  // dans toutes les frames de la fenêtre Teams intégré : dans cette iframe-là seulement,
  // il répond à la page Teams qui l'a ouverte en relisant la transcription affichée.
  // Lecture seule : il fait défiler la liste, ne clique sur rien.
  if (window.top !== window) {
    if (window.__trameFrame || !/(^|\.)sharepoint\.com$/i.test(location.hostname)) return;
    window.__trameFrame = true;
    const TEAMS_ORIGIN = /^https:\/\/(teams\.microsoft\.com|teams\.cloud\.microsoft|[a-z0-9-]+\.teams\.microsoft\.com)$/i;
    // Seulement une iframe posée directement dans Teams (pas une page SharePoint ouverte ailleurs).
    const parentIsTeams = () => {
      const a = location.ancestorOrigins;
      return Boolean(a && a.length === 1 && TEAMS_ORIGIN.test(a[0]));
    };
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const flatText = (s) => (s || "").replace(/[\u2060\u200b]/g, "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const TIME = /^\d{1,2}:\d{2}(:\d{2})?$/;
    // Liste de Stream (Fluent UI, virtualisée) : une cellule `.ms-List-cell` par entrée,
    // avec un en-tête (orateur `itemDisplayName`, horodatage `Header-timestamp-N`,
    // absents d'une suite du même orateur) et le texte (`sub-entry-N`, classe
    // `entryText`). « Transcription démarrée / arrêtée » est une entrée `eventText` :
    // elle est marquée comme événement. Hors de cette forme, on se rabat sur le texte.
    const CELLS = '.ms-List-cell[data-list-index], [role="listitem"]';
    const entryOf = (cell) => {
      const pick = (sel) => flatText(cell.querySelector(sel)?.innerText);
      if (cell.querySelector('[class*="eventText"]') && !cell.querySelector('[class*="entryText"]')) return { event: true };
      let speaker = pick('[class*="itemDisplayName"]');
      let time = pick('[id^="Header-timestamp"]');
      let text = pick('[id^="sub-entry"], [class*="entryText"]');
      if (!speaker && !time && !text) {
        const lines = (cell.innerText || "").split("\n").map(flatText).filter(Boolean);
        const at = lines.findIndex((l) => TIME.test(l));
        if (at >= 0) {
          time = lines[at];
          speaker = at > 0 ? lines[at - 1] : "";
          text = lines.slice(at + 1).join(" ");
        } else text = lines.join(" ");
      }
      return { speaker, time, text };
    };
    // Les cellules de Stream quand elles sont là, sinon les éléments de liste les plus fins.
    const cells = () => {
      const stream = Array.from(document.querySelectorAll(".ms-List-cell[data-list-index]"));
      return stream.length ? stream : Array.from(document.querySelectorAll(CELLS)).filter((c) => !c.querySelector(CELLS));
    };
    const scroller = () => {
      for (let el = cells()[0]; el && el !== document.body; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
      }
      return null;
    };
    const DENIED = /(acc[eè]s refus[eé]|access denied|n.avez pas acc[eè]s|don.t have access|pas l.autorisation d.afficher|not have permission to view)/i;
    const NONE = /(aucune transcription|no transcript|transcription (n.est pas|indisponible)|transcript (is )?(not available|unavailable))/i;
    const waitCells = async (end) => {
      while (!cells().length && Date.now() < end) {
        const txt = document.body?.innerText || "";
        if (DENIED.test(txt)) return "denied";
        if (NONE.test(txt)) return "none";
        await pause(400);
      }
      return cells().length ? "" : "empty";
    };
    // Toute la liste : Stream ne dessine que les entrées visibles. On la parcourt de
    // haut en bas en cumulant par index, puis on remet le défilement où il était.
    const collect = async (budgetMs) => {
      const end = Date.now() + budgetMs;
      const missing = await waitCells(end);
      if (missing) return { ok: false, reason: missing };
      const box = scroller();
      const seen = new Map();
      const add = () =>
        cells().forEach((c, i) => {
          const k = c.getAttribute("data-list-index") ?? `t${i}`;
          if (!seen.has(k)) seen.set(k, entryOf(c));
        });
      const gapsOf = () => {
        const idx = Array.from(seen.keys()).map(Number).filter((n) => Number.isInteger(n));
        return idx.length ? Math.max(...idx) + 1 - idx.length : 0;
      };
      // Un passage de haut en bas. Stream charge la suite par pages en approchant du
      // bas : arrivé en bas, on attend (4 s au plus) que la liste s'allonge avant de
      // conclure qu'elle est finie.
      let bottom = false;
      const sweep = async () => {
        box.scrollTop = 0;
        await pause(300);
        add();
        for (let idle = 0; idle < 8 && Date.now() < end; ) {
          const before = `${seen.size}/${box.scrollHeight}/${box.scrollTop}`;
          box.scrollTop += Math.max(150, box.clientHeight * 0.7);
          await pause(250);
          add();
          const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
          if (before === `${seen.size}/${box.scrollHeight}/${box.scrollTop}` || atBottom) {
            idle += 1;
            if (atBottom) await pause(250);
          } else idle = 0;
          bottom = atBottom;
        }
      };
      const top = box ? box.scrollTop : 0;
      add();
      if (box) {
        await sweep();
        // Un index sauté (rendu trop lent pendant le défilement) : un second passage.
        if (gapsOf() && Date.now() < end) await sweep();
        box.scrollTop = top;
      } else bottom = true;
      const sorted = Array.from(seen.entries()).sort(([a], [b]) => (Number(a) || 0) - (Number(b) || 0));
      const gaps = gapsOf();
      const entries = sorted.map(([, v]) => v).filter((e) => !e.event);
      // Le OneDrive qui sert la transcription est celui de l'organisateur.
      const owner = (location.pathname.match(/^\/personal\/([^/]+)/) || [])[1] || "";
      return { ok: true, entries, gaps, owner, complete: bottom && gaps === 0 && Date.now() < end };
    };
    // Diagnostic : la forme de la page (balises, rôles, longueurs), jamais le texte.
    const probe = () => {
      const tag = (el) => {
        const cls = (typeof el.className === "string" ? el.className : "").split(/\s+/).filter((c) => /[A-Za-z]{4,}/.test(c)).slice(0, 3).join(".");
        return [el.tagName.toLowerCase(), el.id ? `#${el.id.slice(0, 40)}` : "", cls ? `.${cls}` : "",
          el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : "",
          el.getAttribute("data-list-index") ? `[idx=${el.getAttribute("data-list-index")}]` : ""].join("");
      };
      const path = [];
      for (let el = cells()[0]; el && el !== document.body && path.length < 14; el = el.parentElement) path.push(tag(el));
      const sample = cells().slice(0, 6).map((c) =>
        [c, ...c.querySelectorAll("*")].slice(0, 30).map((el) => `${tag(el)} t${(el.innerText || "").length}`));
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"]'))
        .map((b) => flatText(b.getAttribute("aria-label") || b.innerText).slice(0, 40)).filter(Boolean).slice(0, 40);
      return { path: location.pathname.replace(/\/personal\/[^/]+/, "/personal/…").slice(0, 80), cells: cells().length,
        scrollable: Boolean(scroller()), cell_path: path, cell_sample: sample, buttons };
    };
    let busy = false;
    window.addEventListener("message", async (e) => {
      const d = e.data;
      if (!d || d.trame !== "trame-transcript" || typeof d.nonce !== "string") return;
      if (e.source !== window.parent || !TEAMS_ORIGIN.test(e.origin) || !parentIsTeams()) return;
      // Accusé immédiat : la page Teams cesse de répéter sa demande.
      e.source.postMessage({ trame: "trame-transcript-ack", nonce: d.nonce }, e.origin);
      if (busy) return;
      busy = true;
      let result;
      try {
        const budget = Math.min(Number(d.budget_ms) || 60000, 150000);
        if (d.mode === "probe") {
          await waitCells(Date.now() + 20000);
          result = { ok: true, probe: probe() };
        } else result = await collect(budget);
      } catch (err) {
        result = { ok: false, reason: "error", error: String((err && err.message) || err) };
      } finally {
        busy = false;
      }
      e.source.postMessage({ trame: "trame-transcript-result", nonce: d.nonce, ...result }, e.origin);
    });
    return;
  }
  if (window.__trame) return;
  if (!/(^|\.)teams\.(microsoft|cloud\.microsoft)\.com$|^teams\.cloud\.microsoft$/.test(location.hostname)) return;

  // --- Hôtes des API Teams ---------------------------------------------------
  // Les seuls hôtes que le pont appelle (webfetch) et retient (capture) : ceux que le
  // client Teams interroge déjà. Jamais un tiers : l'appel se fait avec les credentials
  // de la page, il ne doit sortir ni vers un autre domaine ni (pour l'auth) vers le moteur.
  const API_HOSTS =
    /(^|\.)(teams\.microsoft\.com|teams\.cloud\.microsoft|teams\.live\.com|msg\.teams\.microsoft\.com|asyncgw\.teams\.microsoft\.com|presence\.teams\.microsoft\.com|substrate\.office\.com|graph\.microsoft\.com|outlook\.office365\.com|teams\.events\.data\.microsoft\.com)$/i;
  // GIF animés choisis dans Teams : CDN public de Giphy, demandé SANS credentials ni
  // en-tête (rien de la page ne sort vers ce tiers), comme Teams qui l'affiche par son adresse.
  const GIF_HOSTS = /(^|\.)giphy\.com$/i;
  const gifBlob = async (url) => {
    try {
      const res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
      const blob = res.ok ? await res.blob() : null;
      return blob && /^image\//.test(blob.type || "") ? blob : null;
    } catch {
      return null;
    }
  };
  // Hôtes des fichiers joints (liens de partage, téléchargements pré-signés) : `filelink`.
  const FILE_HOSTS = /(^|\.)(sharepoint\.com|onedrive\.live\.com|onedrive\.com|1drv\.ms)$/i;
  // En-têtes d'authentification : on note leur PRÉSENCE, jamais leur valeur, et webfetch
  // refuse de les poser (c'est la page, pas le moteur, qui porte l'auth).
  const AUTH_HEADER = /^(authorization|authentication|cookie|x-skypetoken|x-ms-\S*token|.*[-_]?token|.*bearer.*)$/i;

  // --- Capture réseau en lecture seule --------------------------------------
  // Sert UNIQUEMENT à découvrir quelles API internes Teams appelle et comment. On ne
  // garde que la STRUCTURE : méthode, hôte, gabarit de chemin (segments opaques masqués),
  // type de réponse, statut, et la PRÉSENCE (jamais la valeur) d'en-têtes d'auth. Aucun
  // jeton, cookie, en-tête d'autorisation, paramètre de requête ni corps de message n'est
  // lu ni conservé. Le résumé (structure seule) sort via l'op `diagnose`.
  const apiCapture = (() => {
    const MAX = 150;
    const seen = new Map(); // clé -> { method, host, path, type, status, count, auth, first, last }
    const sockets = new Map(); // clé -> { scheme, host, path, count, first, last } (WebSocket)
    // PRIVÉ À LA PAGE — jamais exposé. Dernier en-tête d'auth que Teams a lui-même posé par
    // hôte d'API, pour resigner un appel `webfetch` vers CE MÊME hôte avec l'auth de la page
    // (le client Teams fait déjà exactement cet appel). Transitoire, en mémoire de la page
    // seulement : jamais renvoyé au moteur, jamais dans `summary`/`diagnose`, jamais journalisé,
    // jamais persisté. Interdiction absolue d'ajouter `creds` à un objet renvoyé.
    const creds = new Map(); // host -> { authorization?, xSkypetoken?, at } (repli par hôte)
    // Les jetons de Teams sont par RESSOURCE (audience), pas par hôte : sur teams.cloud.microsoft,
    // tenantsv2 et me/settings n'ont pas le même bearer. On garde donc aussi l'auth par endpoint
    // EXACT (hôte + chemin) pour resigner avec le bon jeton. Même règle : privé à la page.
    const credsByPath = new Map(); // "host\npathname" -> { authorization?, xSkypetoken?, at }
    const pathKey = (host, pathname) => host + "\n" + pathname;
    // PRIVÉ À LA PAGE. Une URL GET sûre et idempotente que Teams a appelée avec succès (auth),
    // rejouée signée par l'auto-test pour vérifier que la signature en page fonctionne (200 vs
    // 401). Jamais renvoyée au moteur ; seul le STATUT de l'auto-test sort (voir diagnose).
    let probeUrl = "";
    // Endpoints GET sûrs (sans effet, sans id sensible) servant de sonde de signature.
    const SAFE_PROBE = /\/(users\/tenantsv2|usersettings\/|me\/settings\/|sharepoint\/sites\/validSites|v1\.0\/domains)\b/i;
    const tmpl = (path) =>
      (path || "/")
        .split("/")
        .map((seg) =>
          !seg
            ? seg
            : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)
              ? "{guid}"
              : /^(19|8|48):/.test(seg) || /@thread\.|@unq\.gbl|@eu\.teams/.test(seg)
                ? "{thread}"
                : /^\d{6,}$/.test(seg)
                  ? "{n}"
                  : /^[A-Za-z0-9_%.-]{20,}$/.test(seg)
                    ? "{id}"
                    : seg,
        )
        .join("/");
    // Famille de service, pour regrouper la lecture : rien de sensible.
    const service = (host, path) =>
      /msg\.teams/.test(host) ? "chatsvc"
      : /presence\.teams/.test(host) ? "presence"
      : /asyncgw\.teams/.test(host) ? "asyncgw"
      : /substrate\.office/.test(host) ? "substrate"
      : /graph\.microsoft/.test(host) ? "graph"
      : /(^|\.)teams\.(microsoft|cloud\.microsoft|live)/.test(host)
        ? (/\/api\//.test(path) ? "middletier" : "teams")
        : "autre";
    // Noms (jamais valeurs) des en-têtes d'auth présents sur une requête Teams.
    const authNames = (headers) => {
      const out = new Set();
      try {
        const push = (k) => AUTH_HEADER.test(String(k)) && out.add(String(k).toLowerCase());
        if (!headers) return out;
        if (typeof headers.forEach === "function") headers.forEach((_v, k) => push(k));
        else if (Array.isArray(headers)) headers.forEach(([k]) => push(k));
        else Object.keys(headers).forEach(push);
      } catch {}
      return out;
    };
    // Lit la VALEUR d'un en-tête depuis des en-têtes de requête (Headers, tableau, ou objet).
    const headerValue = (headers, name) => {
      try {
        if (!headers) return "";
        const want = name.toLowerCase();
        if (typeof headers.get === "function") return headers.get(name) || headers.get(want) || "";
        if (Array.isArray(headers)) {
          const hit = headers.find(([k]) => String(k).toLowerCase() === want);
          return hit ? String(hit[1] || "") : "";
        }
        for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return String(headers[k] || "");
      } catch {}
      return "";
    };
    const storeCreds = (map, key, authorization, xSkypetoken) => {
      const prev = map.get(key) || {};
      map.set(key, {
        authorization: authorization || prev.authorization || "",
        xSkypetoken: xSkypetoken || prev.xSkypetoken || "",
        at: Date.now(),
      });
    };
    // Retient, PRIVÉ À LA PAGE, l'auth que Teams vient de poser, par hôte ET par endpoint exact,
    // afin de resigner un `webfetch` avec le bon jeton. On ne garde que authorization + x-skypetoken.
    const rememberCreds = (rawUrl, headers) => {
      try {
        let u;
        try {
          u = new URL(String(rawUrl || ""), location.origin);
        } catch {
          return;
        }
        if (!API_HOSTS.test(u.hostname) || !headers) return;
        const authorization = headerValue(headers, "authorization");
        const xSkypetoken = headerValue(headers, "x-skypetoken");
        if (!authorization && !xSkypetoken) return;
        storeCreds(creds, u.hostname, authorization, xSkypetoken);
        if (credsByPath.size >= 80 && !credsByPath.has(pathKey(u.hostname, u.pathname))) {
          let oldestKey, oldest = Infinity;
          for (const [k, v] of credsByPath) if ((v.at || 0) < oldest) ((oldest = v.at || 0), (oldestKey = k));
          if (oldestKey) credsByPath.delete(oldestKey);
        }
        storeCreds(credsByPath, pathKey(u.hostname, u.pathname), authorization, xSkypetoken);
      } catch {}
    };
    // Rendues à `webfetch`/l'auto-test UNIQUEMENT (dans la page). Jamais sérialisées vers le moteur.
    // Priorité au jeton de l'endpoint exact (bonne audience), repli sur le dernier jeton de l'hôte.
    const credsFor = (rawUrl) => {
      try {
        const u = new URL(String(rawUrl || ""), location.origin);
        return credsByPath.get(pathKey(u.hostname, u.pathname)) || creds.get(u.hostname) || null;
      } catch {
        return creds.get(String(rawUrl)) || null;
      }
    };
    // Bearer d'audience api.spaces.skype.com : celui que Teams pose sur ses appels middletier
    // (`/api/mt/…`). C'est le jeton que `authsvc/v1.0/authz` échange contre le jeton du service
    // de chat. Rendu à `chatsvc` UNIQUEMENT (dans la page), jamais sérialisé vers le moteur.
    const mtBearer = () => {
      let best = null;
      for (const [k, v] of credsByPath) {
        const [host, pathname] = k.split("\n");
        if (!v.authorization || !/(^|\.)teams\.(microsoft\.com|cloud\.microsoft)$/i.test(host) || !/^\/api\/mt\//.test(pathname)) continue;
        if (!best || (v.at || 0) > (best.at || 0)) best = v;
      }
      return best ? best.authorization : "";
    };
    // Base des API middletier de CE locataire (« https://teams.cloud.microsoft/api/mt/part/emea-03/ »),
    // relevée sur les appels que Teams fait lui-même. Pas un secret : un chemin.
    const mtBase = () => {
      let best = null;
      for (const [k, v] of credsByPath) {
        const [host, pathname] = k.split("\n");
        const m = /^(\/api\/mt\/part\/[a-z0-9-]+\/)/i.exec(pathname);
        if (!m || !/(^|\.)teams\.(microsoft\.com|cloud\.microsoft)$/i.test(host)) continue;
        if (!best || (v.at || 0) > best.at) best = { base: `https://${host}${m[1]}`, at: v.at || 0 };
      }
      return best ? best.base : "";
    };
    // Source du credential retenu pour une URL (pour l'auto-test) : "path" | "host" | "none".
    const credsSource = (rawUrl) => {
      try {
        const u = new URL(String(rawUrl || ""), location.origin);
        if (credsByPath.has(pathKey(u.hostname, u.pathname))) return "path";
        if (creds.has(u.hostname)) return "host";
      } catch {}
      return "none";
    };
    const note = (method, rawUrl, status, authSet, contentType) => {
      let u;
      try {
        u = new URL(rawUrl, location.origin);
      } catch {
        return;
      }
      // On ne retient que les API : hôtes de service Teams/Microsoft, et sur l'hôte de la
      // page seulement les chemins d'API (jamais les assets statiques ou la navigation).
      if (!API_HOSTS.test(u.hostname)) return;
      if (u.hostname === location.hostname && !/\/api\/|\/csa\/|\/middletier\//.test(u.pathname)) return;
      const path = tmpl(u.pathname);
      const key = `${(method || "GET").toUpperCase()} ${u.hostname} ${path}`;
      const auth = Array.from(authSet || []);
      const now = Date.now();
      // Retient une sonde de signature : GET authentifié, réussi, sans effet ni id sensible.
      if ((method || "GET").toUpperCase() === "GET" && status === 200 && auth.includes("authorization") && SAFE_PROBE.test(u.pathname)) {
        probeUrl = u.origin + u.pathname + u.search;
      }
      const prev = seen.get(key);
      if (prev) {
        prev.count++;
        prev.last = now;
        prev.status = status || prev.status;
        if ((contentType || "").length) prev.type = contentType;
        for (const a of auth) if (!prev.auth.includes(a)) prev.auth.push(a);
      } else {
        if (seen.size >= MAX) {
          // Évince le plus ancien pour rester borné.
          let oldestKey, oldest = Infinity;
          for (const [k, v] of seen) if (v.last < oldest) ((oldest = v.last), (oldestKey = k));
          if (oldestKey) seen.delete(oldestKey);
        }
        seen.set(key, {
          method: (method || "GET").toUpperCase(),
          service: service(u.hostname, u.pathname),
          host: u.hostname,
          path,
          type: contentType || "",
          status: status || 0,
          count: 1,
          hasQuery: Boolean(u.search),
          auth,
          first: now,
          last: now,
        });
      }
    };
    // Connexion WebSocket ouverte par la page (ex. trouter, le canal de push : il prévient,
    // les messages sont relus en REST depuis un Web Worker). On ne retient que l'URL
    // de connexion (hôte + gabarit de chemin masqué) et un compte — jamais une frame, jamais
    // de contenu. Sert à repérer le service de chat/présence.
    const noteSocket = (rawUrl) => {
      let u;
      try {
        u = new URL(rawUrl, location.origin);
      } catch {
        return;
      }
      if (!/^wss?:$/.test(u.protocol)) return;
      const path = tmpl(u.pathname);
      const key = `${u.hostname} ${path}`;
      const now = Date.now();
      const prev = sockets.get(key);
      if (prev) {
        prev.count++;
        prev.last = now;
      } else {
        if (sockets.size >= 40) {
          let oldestKey, oldest = Infinity;
          for (const [k, v] of sockets) if (v.last < oldest) ((oldest = v.last), (oldestKey = k));
          if (oldestKey) sockets.delete(oldestKey);
        }
        sockets.set(key, { scheme: u.protocol.replace(":", ""), host: u.hostname, path, hasQuery: Boolean(u.search), count: 1, first: now, last: now });
      }
    };
    // --- Frames WebSocket : STRUCTURE seulement (découverte du protocole trouter) ---------
    // On n'enregistre JAMAIS le contenu d'une frame : on parse le JSON uniquement pour relever
    // les NOMS de clés (chemins), en masquant les clés dynamiques (id, guid, nombres). Aucune
    // valeur, aucun texte de message. Sert à comprendre comment arrivent messages/présence.
    const frames = new Map(); // "host\ndir\nshape" -> { host, dir, shape, count, minLen, maxLen, last }
    const maskFrameKey = (k) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k) ? "{guid}"
      : /^(19|8|48):/.test(k) || /@thread\.|@unq\.gbl/.test(k) ? "{id}"
      : /^\d{3,}$/.test(k) ? "{n}"
      : k.length > 40 ? "{k}"
      : k;
    const shapeOf = (data) => {
      if (typeof data !== "string") return "binary";
      if (data.length > 200000) return "text(large)";
      let obj;
      try {
        obj = JSON.parse(data);
      } catch {
        return "text";
      }
      const keys = new Set();
      const walk = (v, depth, prefix) => {
        if (keys.size > 60 || depth > 3) return;
        if (v && typeof v === "object" && !Array.isArray(v)) {
          for (const k of Object.keys(v)) {
            const p = prefix ? prefix + "." + maskFrameKey(k) : maskFrameKey(k);
            keys.add(p); // NOM de clé seulement, jamais la valeur
            walk(v[k], depth + 1, p);
          }
        } else if (Array.isArray(v) && v.length) {
          walk(v[0], depth + 1, prefix + "[]");
        }
      };
      walk(obj, 0, "");
      return Array.from(keys).sort().join(",").slice(0, 400) || typeof obj;
    };
    const noteFrame = (host, dir, data) => {
      try {
        const len = typeof data === "string" ? data.length : (data && (data.byteLength || data.size)) || 0;
        if (!len && dir === "in") return; // ignore les pings vides
        const shape = shapeOf(data);
        const key = `${host}\n${dir}\n${shape}`;
        const now = Date.now();
        const f = frames.get(key);
        if (f) {
          f.count++;
          f.minLen = Math.min(f.minLen, len);
          f.maxLen = Math.max(f.maxLen, len);
          f.last = now;
        } else {
          if (frames.size >= 80) {
            let oldestKey, oldest = Infinity;
            for (const [k, v] of frames) if (v.last < oldest) ((oldest = v.last), (oldestKey = k));
            if (oldestKey) frames.delete(oldestKey);
          }
          frames.set(key, { host, dir, shape, count: 1, minLen: len, maxLen: len, last: now });
        }
      } catch {}
    };
    const summary = () => {
      const rows = Array.from(seen.values()).sort((a, b) => b.last - a.last);
      const byService = {};
      for (const r of rows) byService[r.service] = (byService[r.service] || 0) + 1;
      const wsRows = Array.from(sockets.values()).sort((a, b) => b.last - a.last);
      const frameRows = Array.from(frames.values()).sort((a, b) => b.last - a.last);
      return {
        count: rows.length,
        byService,
        // Chaque entrée : structure seule, aucune valeur d'auth ni paramètre de requête.
        endpoints: rows.slice(0, 80).map((r) => ({
          method: r.method,
          service: r.service,
          host: r.host,
          path: r.path,
          type: r.type,
          status: r.status,
          count: r.count,
          hasQuery: r.hasQuery,
          auth: r.auth.slice(0, 6), // noms d'en-têtes seulement
        })),
        // WebSockets : URL de connexion seulement (jamais de contenu).
        sockets: wsRows.slice(0, 20).map((s) => ({ scheme: s.scheme, host: s.host, path: s.path, hasQuery: s.hasQuery, count: s.count })),
        // Frames WebSocket : STRUCTURE seulement (noms de clés masqués, sens, taille, compte) ;
        // jamais aucune valeur ni contenu de message.
        frames: frameRows.slice(0, 40).map((f) => ({ host: f.host, dir: f.dir, shape: f.shape, count: f.count, minLen: f.minLen, maxLen: f.maxLen })),
      };
    };
    // credsFor n'est fourni que pour l'usage interne à la page (webfetch). summary ne
    // l'expose jamais ; rememberCreds alimente le cache depuis les hooks.
    return { note, noteSocket, noteFrame, authNames, rememberCreds, credsFor, credsSource, mtBearer, mtBase, summary, safeProbe: () => probeUrl };
  })();

  // --- Service de chat de Teams (chatsvc), appelé DANS la page --------------------------
  // Teams v2 lit et écrit les messages par l'API REST du service de chat
  // (`/v1/users/ME/conversations…`), depuis un Web Worker : le hook fetch/XHR de la fenêtre ne
  // voit pas ces appels. On ouvre notre propre session, comme le client : le bearer middletier
  // (audience api.spaces.skype.com) est échangé par `authsvc/v1.0/authz` contre un jeton du
  // service de chat et l'adresse régionale du service.
  // PRIVÉ À LA PAGE : `session` (jeton du chat, adresse) n'est jamais renvoyé au moteur, jamais
  // journalisé, jamais persisté. Seuls sortent le statut HTTP, la région et le corps métier.
  const chatsvc = (() => {
    const AUTHZ = "https://teams.microsoft.com/api/authsvc/v1.0/authz";
    const RENEW_MS = 5 * 60 * 1000;
    let session = null; // { token, exp, bases: [url…], region } — jamais exposé
    let pending = null;
    // Chemins permis (lecture) : la liste, une conversation, ses messages, un message. Ids
    // encodés par le moteur (encodeURIComponent) ; rien d'autre ne passe.
    // Un id ne peut être ni « . » ni « .. », ni contenir un « / » ou « \ » encodé.
    const PATHS = /^\/v1\/users\/ME\/conversations(\/(?!\.{1,2}(\/|$))(?![^/]*%(2[fF]|5[cC]))[A-Za-z0-9%._~-]+(\/messages(\/\d{1,20})?)?)?$/;
    const QUERY_KEYS = new Set(["view", "pageSize", "startTime", "targetType", "syncState"]);
    const baseOk = (raw) => {
      try {
        const u = new URL(String(raw || ""));
        return u.protocol === "https:" && API_HOSTS.test(u.hostname) ? u.origin + u.pathname.replace(/\/+$/, "") : "";
      } catch {
        return "";
      }
    };
    const open = async () => {
      const bearer = apiCapture.mtBearer();
      if (!bearer) {
        const e = new Error("aucun jeton Teams observé pour l'instant (ouvre une conversation)");
        e.stage = "bearer";
        throw e;
      }
      let res;
      try {
        res = await fetch(AUTHZ, { method: "POST", credentials: "omit", headers: { Authorization: bearer } });
      } catch (err) {
        const e = new Error(`échec réseau vers authsvc : ${String((err && err.message) || err)}`);
        e.stage = "authz";
        throw e;
      }
      let body = null;
      try {
        body = JSON.parse(await res.text());
      } catch {}
      const token = body && body.tokens && body.tokens.skypeToken;
      const gtms = (body && body.regionGtms) || {};
      const bases = [baseOk(gtms.chatService), baseOk(gtms.chatServiceAfd)].filter(Boolean);
      if (!res.ok || !token || !bases.length) {
        const e = new Error(res.ok ? "réponse authsvc incomplète" : `authsvc refusé (HTTP ${res.status})`);
        e.stage = "authz";
        e.status = res.status;
        throw e;
      }
      const ttl = Number(body.tokens.expiresIn) > 0 ? Number(body.tokens.expiresIn) * 1000 : 60 * 60 * 1000;
      session = { token, exp: Date.now() + ttl, bases, region: String(body.region || ""), me: meOf(token) };
      return session;
    };
    // Identifiant Teams (mri « 8:orgid:… ») de l'utilisateur, lu dans la charge du jeton du chat
    // (champ skypeid). Seul l'identifiant sert, pour reconnaître SES réactions ; le jeton reste ici.
    const meOf = (token) => {
      try {
        const part = String(token).split(".")[1] || "";
        const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
        const id = String(json.skypeid || "");
        return id ? (id.startsWith("8:") ? id : "8:" + id) : "";
      } catch {
        return "";
      }
    };
    const ensure = async (force) => {
      if (!force && session && session.exp - Date.now() > RENEW_MS) return session;
      if (!pending) pending = open().finally(() => (pending = null));
      return pending;
    };
    const send = async (s, method, path, search) => {
      let lastErr = null;
      for (const base of s.bases) {
        try {
          return await fetch(base + path + search, {
            method,
            credentials: "omit",
            headers: { Authentication: `skypetoken=${s.token}`, Accept: "application/json" },
          });
        } catch (err) {
          lastErr = err; // réseau : on essaie l'autre adresse du service
        }
      }
      const e = new Error(`échec réseau vers le service de chat : ${String((lastErr && lastErr.message) || lastErr)}`);
      e.stage = "chatsvc";
      throw e;
    };
    // --- Écritures : une table fermée, UN seul essai (jamais rejoué sur l'autre adresse du
    // service : un envoi en double est pire qu'un envoi incertain) ---
    const CONV = /^(19:[A-Za-z0-9_.:=-]{1,200}@(thread\.(v2|skype|tacv2)|unq\.gbl\.spaces)|48:notes)$/;
    const MID = /^\d{1,20}$/;
    const WRITES = {
      markread: (c) => ["PUT", `/v1/users/ME/conversations/${encodeURIComponent(c)}/properties`, "?name=consumptionhorizon"],
      react: (c, m) => ["PUT", `/v1/users/ME/conversations/${encodeURIComponent(c)}/messages/${m}/properties`, "?name=emotions"],
      unreact: (c, m) => ["DELETE", `/v1/users/ME/conversations/${encodeURIComponent(c)}/messages/${m}/properties`, "?name=emotions"],
      delete: (c, m) => ["DELETE", `/v1/users/ME/conversations/${encodeURIComponent(c)}/messages/${m}`, "?behavior=softDelete"],
      edit: (c, m) => ["PUT", `/v1/users/ME/conversations/${encodeURIComponent(c)}/messages/${m}`, ""],
      send: (c) => ["POST", `/v1/users/ME/conversations/${encodeURIComponent(c)}/messages`, ""],
      // Création d'un tête-à-tête (c : son id calculé, jamais mis dans le chemin).
      thread: () => ["POST", "/v1/threads", ""],
    };
    // { ok, status } ; { sent: false } si rien n'est parti (refus avant l'appel) ; { sent: true,
    // unknown: true } si l'appel est parti sans réponse lisible (réseau coupé en route).
    const write = async (kind, conv, mid, body) => {
      if (!WRITES[kind] || !CONV.test(String(conv || "")) || (mid != null && !MID.test(String(mid))))
        return { ok: false, sent: false, error: "écriture non autorisée" };
      let s;
      try {
        s = await ensure(false);
      } catch (err) {
        return { ok: false, sent: false, stage: err.stage || "authz", error: String((err && err.message) || err) };
      }
      const [method, path, search] = WRITES[kind](conv, mid);
      try {
        const res = await fetch(s.bases[0] + path + search, {
          method,
          credentials: "omit",
          headers: { Authentication: `skypetoken=${s.token}`, Accept: "application/json", "Content-Type": "application/json" },
          body: body == null ? undefined : JSON.stringify(body),
        });
        if (res.status === 401) session = null; // la prochaine opération rouvre la session
        let json = null;
        try {
          const t = await res.text();
          json = t ? JSON.parse(t) : null;
        } catch {}
        return { ok: res.ok, sent: true, status: res.status, json };
      } catch (err) {
        return { ok: false, sent: true, unknown: true, error: `réseau coupé pendant l'appel : ${String((err && err.message) || err)}` };
      }
    };
    // GET sur un chemin permis. Renvoie { ok, status, json } : corps métier seulement.
    const get = async ({ path, query } = {}) => {
      const p = String(path || "");
      if (!PATHS.test(p)) return { ok: false, stage: "chatsvc", error: "chemin du service de chat non autorisé" };
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query || {})) if (QUERY_KEYS.has(k) && v != null) qs.set(k, String(v));
      const search = qs.toString() ? "?" + qs.toString() : "";
      try {
        let s = await ensure(false);
        let res = await send(s, "GET", p, search);
        // Jeton expiré ou révoqué : une seule nouvelle session, puis on rend la main.
        if (res.status === 401) {
          s = await ensure(true);
          res = await send(s, "GET", p, search);
        }
        const out = { ok: res.ok, status: res.status, region: s.region };
        const text = await res.text().catch(() => "");
        if (text.length > 4_000_000) return { ...out, ok: false, error: "réponse trop volumineuse" };
        try {
          out.json = text ? JSON.parse(text) : null;
        } catch {
          out.ok = false;
          out.error = "réponse non JSON";
        }
        if (!res.ok && !out.error) out.error = `service de chat refusé (HTTP ${res.status})`;
        return out;
      } catch (err) {
        return { ok: false, stage: err.stage || "chatsvc", status: err.status || 0, error: String((err && err.message) || err) };
      }
    };
    // Auto-test : une conversation, statut seulement (jamais de corps). Au plus toutes les 5 min.
    let lastTest = null;
    const selftest = async () => {
      if (lastTest && Date.now() - lastTest.at < 5 * 60 * 1000) return lastTest;
      const r = await get({ path: "/v1/users/ME/conversations", query: { view: "msnp24Equivalent", pageSize: 1 } });
      lastTest = { ok: Boolean(r.ok), status: r.status || 0, stage: r.ok ? "ok" : r.stage || "chatsvc", region: r.region || "", at: Date.now() };
      if (!r.ok && r.error) lastTest.error = r.error;
      return lastTest;
    };
    // Image d'un message servie par le stockage de Teams (AMS : *.asm.skype.com, ou asyncgw),
    // demandée DANS la page : jeton du chat pour AMS, auth que Teams a posée pour asyncgw.
    const IMAGE_HOSTS = /(^|\.)(asm\.skype\.com|asyncgw\.teams\.microsoft\.com)$/i;
    const image = async (raw) => {
      let u;
      try {
        u = new URL(String(raw || ""));
      } catch {
        return null;
      }
      if (u.protocol === "https:" && GIF_HOSTS.test(u.hostname)) return gifBlob(u.toString());
      if (u.protocol !== "https:" || !IMAGE_HOSTS.test(u.hostname)) return null;
      try {
        const headers = {};
        if (/asm\.skype\.com$/i.test(u.hostname)) {
          const s = await ensure(false);
          headers.Authorization = `skype_token ${s.token}`;
        } else {
          const c = apiCapture.credsFor(u.toString());
          if (c && c.authorization) headers.Authorization = c.authorization;
          if (c && c.xSkypetoken) headers["X-Skypetoken"] = c.xSkypetoken;
        }
        const res = await fetch(u.toString(), { credentials: "omit", headers });
        const blob = res.ok ? await res.blob() : null;
        return blob && /^image\//.test(blob.type || "") ? blob : null;
      } catch {
        return null;
      }
    };
    // Noms affichés de personnes (mri « 8:orgid:… »), demandés au middletier comme le fait Teams
    // (fetchShortProfile), gardés en mémoire de la page. Sert à nommer les tête-à-tête.
    const names = new Map(); // mri -> displayName
    const people = async (mris) => {
      const want = Array.from(new Set((mris || []).filter((m) => /^8:[A-Za-z0-9:._-]{3,120}$/.test(m) && !names.has(m)))).slice(0, 100);
      const base = apiCapture.mtBase();
      const bearer = apiCapture.mtBearer();
      if (want.length && base && bearer) {
        try {
          const url = `${base}beta/users/fetchShortProfile?isMailAddress=false&enableGuest=true&skypeTeamsInfo=true&canBeSmtpAddress=false&includeIBBarredUsers=true&includeDisabledAccounts=true`;
          const res = await fetch(url, {
            method: "POST",
            credentials: "omit",
            headers: { Authorization: bearer, "Content-Type": "application/json" },
            body: JSON.stringify(want),
          });
          const body = res.ok ? JSON.parse(await res.text()) : null;
          for (const p of (body && body.value) || []) {
            const name = String((p && p.displayName) || "").trim();
            if (p && p.mri && name) names.set(String(p.mri), name);
          }
        } catch {}
      }
      return Object.fromEntries((mris || []).filter((m) => names.has(m)).map((m) => [m, names.get(m)]));
    };
    // Mon identifiant, la session ouverte au besoin (« » si elle ne s'ouvre pas).
    const whoami = async () => {
      try {
        return (await ensure(false)).me || "";
      } catch {
        return "";
      }
    };
    return { get, write, selftest, image, people, whoami, me: () => (session ? session.me : ""), last: () => lastTest };
  })();

  // Pose les hooks passifs. La capture de STRUCTURE ne retient que les NOMS d'en-têtes d'auth.
  // En plus, et UNIQUEMENT en mémoire de la page, on retient la VALEUR d'auth que Teams pose
  // (authorization/x-skypetoken) pour pouvoir resigner un `webfetch` vers le même hôte : cette
  // valeur ne part jamais vers le moteur (voir `creds`). On renvoie toujours l'objet d'origine.
  const hostOf = (rawUrl) => {
    try {
      return new URL(String(rawUrl || ""), location.origin).hostname;
    } catch {
      return "";
    }
  };
  (() => {
    try {
      const of = window.fetch;
      if (typeof of === "function" && !of.__trameWrapped) {
        const wrapped = function (input, init) {
          let url = "", method = "GET", authSet;
          try {
            if (typeof Request !== "undefined" && input instanceof Request) {
              url = input.url;
              method = input.method || "GET";
              authSet = apiCapture.authNames(input.headers);
              apiCapture.rememberCreds(url, input.headers);
            } else {
              url = String(input);
            }
            if (init) {
              if (init.method) method = init.method;
              if (init.headers) {
                const h = apiCapture.authNames(init.headers);
                authSet = authSet ? new Set([...authSet, ...h]) : h;
                apiCapture.rememberCreds(url, init.headers);
              }
            }
          } catch {}
          const p = of.apply(this, arguments);
          try {
            p.then(
              (res) => {
                try {
                  apiCapture.note(method, url, res.status, authSet, (res.headers.get("content-type") || "").split(";")[0]);
                } catch {}
              },
              () => {},
            );
          } catch {}
          return p;
        };
        wrapped.__trameWrapped = true;
        window.fetch = wrapped;
      }
      const XP = XMLHttpRequest && XMLHttpRequest.prototype;
      if (XP && !XP.open.__trameWrapped) {
        const oOpen = XP.open, oSend = XP.send, oSet = XP.setRequestHeader;
        const wOpen = function (method, url) {
          this.__trame = { method: method || "GET", url: String(url || ""), auth: new Set(), creds: {} };
          return oOpen.apply(this, arguments);
        };
        wOpen.__trameWrapped = true;
        XP.open = wOpen;
        XP.setRequestHeader = function (name, value) {
          try {
            const n = String(name);
            if (this.__trame && AUTH_HEADER.test(n)) {
              this.__trame.auth.add(n.toLowerCase());
              // Valeur gardée seulement en mémoire de la page, pour resigner le même hôte.
              if (/^(authorization|x-skypetoken)$/i.test(n)) this.__trame.creds[n.toLowerCase()] = value;
            }
          } catch {}
          return oSet.apply(this, arguments);
        };
        XP.send = function () {
          try {
            const meta = this.__trame;
            if (meta) {
              apiCapture.rememberCreds(meta.url, {
                authorization: meta.creds.authorization,
                "x-skypetoken": meta.creds["x-skypetoken"],
              });
              this.addEventListener("loadend", () => {
                try {
                  const ct = (this.getResponseHeader && this.getResponseHeader("content-type") || "").split(";")[0];
                  apiCapture.note(meta.method, meta.url, this.status, meta.auth, ct);
                } catch {}
              });
            }
          } catch {}
          return oSend.apply(this, arguments);
        };
      }
      // WebSocket : on note l'URL de connexion et la STRUCTURE des frames (noms de clés
      // masqués, sens, taille) pour découvrir le protocole trouter. Jamais le contenu d'une
      // frame. On renvoie une vraie WebSocket inchangée (on observe, on ne modifie rien).
      const OWS = window.WebSocket;
      if (typeof OWS === "function" && !OWS.__trameWrapped) {
        const WS = function (url, protocols) {
          let host = "";
          try {
            apiCapture.noteSocket(String(url));
            host = hostOf(String(url));
          } catch {}
          const sock = protocols === undefined ? new OWS(url) : new OWS(url, protocols);
          try {
            const origSend = sock.send;
            sock.send = function (data) {
              try {
                apiCapture.noteFrame(host, "out", data);
              } catch {}
              return origSend.apply(this, arguments);
            };
            // Écoute passive : un listener de plus, qui n'altère ni n'empêche la frame.
            sock.addEventListener("message", (ev) => {
              try {
                apiCapture.noteFrame(host, "in", ev && ev.data);
              } catch {}
            });
          } catch {}
          return sock;
        };
        WS.prototype = OWS.prototype;
        WS.__trameWrapped = true;
        for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
          try {
            WS[k] = OWS[k];
          } catch {}
        }
        window.WebSocket = WS;
      }
    } catch {}
  })();

  const reply = (payload) => window.__TAURI_INTERNALS__.invoke("teams_bridge_reply", { payload });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el?.getAttribute?.("aria-label") || el?.innerText || "").replace(/\s+/g, " ").trim();
  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const rail = () => document.querySelector('[role="tree"]');
  const items = () => Array.from(rail()?.querySelectorAll('[role="treeitem"]') || []);
  // --- Repères de Teams web dont dépendent les opérations du pont ---
  // [clé, quand le vérifier, sélecteur]. Le contrôle « probe » les cherche sans rien changer :
  //   page   : toujours là une fois Teams affiché ;
  //   chat   : une conversation ouverte ;
  //   thread : des messages affichés dans cette conversation ;
  //   hover  : barre d'actions d'un message, montrée par un survol (aucun clic) ;
  //   unread : une ligne de la liste annoncée « Non lu » ;
  //   menu   : seulement dans un menu ou après un geste. Le contrôle ne les ouvre pas (un
  //            menu ouvert dans la fenêtre cachée gênerait l'opération en cours, et ouvrir
  //            celui de « Marquer comme lu » ou du statut frôle le geste réel) : ils sont
  //            constatés quand l'opération qui s'en sert les cherche (voir seen()).
  // Les sélecteurs vides se vérifient en script (titre de la fenêtre, instance CKEditor,
  // entrée « cet appareil »).
  // Le moteur (backend/teams_check.py) dit ce qui en dépend ; backend/tests/
  // test_teams_landmarks.py les vérifie sur des fragments de la vraie page.
  const LANDMARKS = [
    ["rail", "page", '[role="tree"]'],
    ["rail_item", "page", '[role="tree"] [role="treeitem"]'],
    ["rail_id", "page", '[role="tree"] [role="treeitem"] [id*="19:"]'],
    ["me", "page", '[data-tid="me-control-avatar-trigger"]'],
    ["me_presence", "page", '[data-tid="me-control-avatar-presence"]'],
    ["new_chat", "page", '[data-testid="simple-collab-left-rail-header-new-message-button"], [data-tid="chat-list-new-chat-button"], [data-tid="new-chat-button"], button[aria-label^="Nouveau message"], button[aria-label^="New message"], button[aria-label^="New chat"], button[aria-label^="Nouvelle conversation"]'],
    ["search_input", "page", '#ms-searchux-input, [data-tid="AUTOSUGGEST_INPUT"]'],
    ["chat_app", "page", '[data-tid="app-bar-wrapper"] [data-tid="86fcd49b-61a2-4701-b771-54728cd291fb"], [data-tid="app-bar-wrapper"] [aria-label="Conversation"], [data-tid="app-bar-wrapper"] [aria-label="Chat"]'],
    ["title", "chat", ''],
    ["editor", "chat", '[data-tid="ckeditor"][contenteditable="true"], [data-tid="ckeditor"] [contenteditable="true"]'],
    ["editor_model", "chat", ''],
    ["send", "chat", '[data-tid="sendMessageCommands-send"], [data-tid="newMessageCommands-send"], button[aria-label^="Send"], button[aria-label^="Envoyer"]'],
    ["attach", "chat", '[data-tid="sendMessageCommands-FilePicker"], [data-tid="newMessageCommands-FilePicker"]'],
    ["main_pane", "chat", '[data-tid="message-pane-layout"], [role="main"]'],
    ["messages", "thread", '[data-tid="chat-pane-item"], [role="main"] [role="list"] > [role="listitem"]'],
    ["message_body", "thread", '[data-tid="chat-pane-message"]'],
    ["message_id", "thread", '[id^="content-"]'],
    ["action_bar", "hover", '[data-tid="message-actions-container"]'],
    ["react_like", "hover", '[data-tid="message-actions-like"]'],
    ["react_heart", "hover", '[data-tid="message-actions-heart"]'],
    ["react_laugh", "hover", '[data-tid="message-actions-laugh"]'],
    ["react_surprised", "hover", '[data-tid="message-actions-surprised"]'],
    ["quote", "hover", '[data-tid="message-actions-quoted-reply"], [data-tid="message-actions-more"]'],
    ["unread", "unread", '[data-tid="unread"]'],
    ["me_menu", "menu", '[data-tid="me-control-menu-dialog"]'],
    ["status_entry", "menu", '[data-tid="set-presence-status-menu-item"]'],
    ["status_choice", "menu", '[data-tid="me_control_presence_availability_available"]'],
    ["duration_entry", "menu", '[data-tid="set-availability-duration"]'],
    ["duration_panel", "menu", '[data-tid="me-control-set-availability-update-availability-button"]'],
    ["duration_lists", "menu", '#set-availability-choose-availability-dropdown, #set-availability-clear-availability-after-dropdown'],
    ["expiry_date", "menu", '[data-tid="me-control-set-availability"] input[aria-haspopup="dialog"]'],
    ["expiry_time", "menu", '[data-tid="custom-expiry-time-picker"]'],
    ["note_edit", "menu", '[data-tid="me-control-menu-status-message-edit-button"], [data-tid="me-control-set-status-message-button"], [data-tid="me-control-menu-set-status-message"]'],
    ["read_entry", "menu", '[data-tid="change-read-status-menu-item"]'],
    ["mention_list", "menu", '[data-tid="AutocompletePopup-Mentions"]'],
    ["delete_entry", "menu", '[data-tid="message-actions-delete"]'],
    ["people_picker", "menu", '[data-tid="chat-with"] input[role="combobox"], #people-picker-input, [data-tid="people-picker-search"], [data-tid="people-picker-input"]'],
    ["people_list", "menu", '[data-tid="people-picker-list"] [role="option"]'],
    ["search_tab", "menu", '[data-tid="messages-tab"]'],
    ["attach_menu", "menu", ''],
    ["discard_confirm", "menu", '[data-tid="messagedraft-discard-confirm"]'],
    ["fav_move", "menu", '[data-tid="move-to-menu-item"], [data-testid="move-to-menu-item"]'],
    ["fav_section", "menu", '[data-tid="move-to-sub-menu-item"], [data-testid="move-to-sub-menu-item"]'],
    ["fav_remove", "menu", '[data-tid="remove-item-from-section-menu-item"], [data-testid="remove-item-from-section-menu-item"]'],
  ];
  const LM = Object.fromEntries(LANDMARKS.map(([key, , sel]) => [key, sel]));
  // Ce que les opérations ont constaté en cherchant un repère de menu : vrai trouvé, faux
  // absent. Le contrôle le rapporte au moteur. Rend `ok` pour s'écrire en ligne.
  const marks = {};
  const seen = (key, ok) => {
    marks[key] = { ok: Boolean(ok), at: Date.now() };
    return ok;
  };
  let running = 0;
  // Présence : Teams web ne l'écrit pas dans le texte de la ligne, seulement sur le
  // badge de l'avatar. On remonte les libellés courts trouvés autour de l'avatar ; le
  // moteur ne garde qu'un statut connu (« En réunion », « Available »…), sinon rien.
  const PRESENCE_NODES = '[class*="resence" i], [data-tid*="resence" i], [class*="Avatar" i], [role="img"], svg[aria-label]';
  const presenceOf = (el) => {
    const out = [];
    for (const n of el.querySelectorAll(PRESENCE_NODES)) {
      for (const v of [n.getAttribute("aria-label"), n.getAttribute("title")]) {
        const t = (v || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 80) continue;
        out.push(t);
        // « Romain CUREAU, Disponible » : le statut est la dernière partie.
        const tail = t.split(/[,–—]/).pop().trim();
        if (tail && tail !== t) out.push(tail);
      }
      if (out.length >= 8) break;
    }
    return out.slice(0, 8);
  };
  // « En train d'écrire » : dans la liste, Teams remplace l'aperçu de la ligne par trois
  // points animés (data-testid typing-indicator), pour toute conversation sauf celle
  // ouverte. Celle-ci l'écrit en toutes lettres sous le fil : « Ana est en train
  // d’écrire… », « Ana and Marc are typing… ».
  const TYPING_ROW = '[data-testid="typing-indicator"]';
  const TYPING_TEXT = /\b(est|sont) en train d.\s?[eé]crire|\b(is|are) typing\b/i;
  const paneTyping = () => {
    // Le fil et la zone de saisie de la conversation ouverte (message-pane-layout depuis
    // que Teams web n'a plus de [role="main"]).
    const main = document.querySelector(LM.main_pane);
    if (!main) return "";
    const walk = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!TYPING_TEXT.test(n.data)) continue;
      const el = n.parentElement;
      // Un message qui contient ces mots n'est pas l'indicateur.
      if (!el || el.closest(MSGS) || el.closest('[contenteditable="true"]') || !visible(el)) continue;
      return flat(el.innerText || n.data).replace(/[.…\s]+$/, "").slice(0, 120);
    }
    return "";
  };
  // Accusé de lecture : l'icône d'état de ton dernier message (« Envoyé », « Vu »,
  // « Sent », « Seen », « Lu par… »). Teams ne la met que sous ton dernier message.
  const SEEN = /^(vu|seen|lu|read)\b/i;
  const statusOf = (el) => {
    const icon = el.querySelector('[id^="read-status-icon-"]');
    const l = (icon?.getAttribute("aria-label") || "").trim();
    return !l ? "" : SEEN.test(l) ? "seen" : "sent";
  };
  const lastStatus = () => {
    const icons = Array.from(document.querySelectorAll(`${MSGS} [id^="read-status-icon-"]`));
    const last = icons[icons.length - 1];
    return last ? statusOf(last.closest(MSGS) || last.parentElement) : "";
  };
  // Section « Favoris » de Teams : un dossier de la liste dont la valeur finit par
  // « ~Favorites », quelle que soit la langue ; ses conversations portent « ~Favorites/ ».
  const FAV_FOLDER = '[role="treeitem"][data-conversation-folder="true"][data-fui-tree-item-value$="~Favorites"]';
  const isFolder = (el) => el.getAttribute("data-conversation-folder") === "true";
  const inFavorites = (el) => (el.getAttribute("data-fui-tree-item-value") || "").includes("~Favorites/");
  const favFolderName = () =>
    label(document.querySelector(`${FAV_FOLDER} [data-testid="conversation-folder-header"]`)) || "";
  const railItems = () => {
    const open = titleName();
    const openEl = open ? findItem(open) : null;
    return items().map((el) => ({
      label: label(el),
      aria: el.getAttribute("aria-expanded") === "true" ? "expanded=true" : "",
      // Un dossier contient ses conversations : jamais l'identifiant de la première.
      id: isFolder(el) ? "" : el.querySelector('[id*="19:"]')?.id || (el.id && el.id.includes("19:") ? el.id : ""),
      ...(isFolder(el) ? { folder: el.matches(FAV_FOLDER) ? "favorites" : "section" } : {}),
      ...(inFavorites(el) ? { fav: true } : {}),
      presence: presenceOf(el),
      typing: Boolean(el.querySelector(TYPING_ROW)),
      // La conversation ouverte dans cette fenêtre : ce que montre son fil.
      ...(el === openEl ? { open: true, typing_text: paneTyping(), status: lastStatus() } : {}),
    }));
  };
  const railScroller = () => {
    for (let el = rail(); el && el !== document.body; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
    }
    return null;
  };
  const titleName = () => {
    const p = document.title.split("|").map((x) => x.trim());
    return p.length >= 3 ? p.slice(1, -1).join(" | ").replace(/\s*\((you|vous|moi)\)\s*$/i, "") : null;
  };
  const isOpen = (name) => norm(titleName()) === norm(name);
  const KIND = /^(chat|group chat|meeting chat|conversation de groupe|conversation de reunion|conversation|channel|canal)\s+/;
  const findItem = (name) => {
    const n = norm(name);
    const all = items();
    const exact = all.filter((el) => {
      // Teams web prefixes an unread conversation with "Non lu" / "Unread".
      const l = norm(label(el)).replace(KIND, "").replace(/^(non lus?|unread)\s+/, "");
      return l === n || l.startsWith(n + " ");
    });
    return exact.sort((a, b) => label(a).length - label(b).length)[0] || null;
  };
  // Pastille « non lu » d'une ligne de la liste, et entrée lu / non lu de son menu.
  const UNREAD = LM.unread;
  const READ_ENTRY = LM.read_entry;
  const sendReady = () => {
    const btn = sendButton();
    return Boolean(btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true");
  };
  const visible = (el) => Boolean(el && el.getClientRects().length);
  // Un élément décrit par sa structure seule (balise, rôle, data-tid), jamais son texte :
  // pour dire dans une erreur où se trouvait le focus.
  const describe = (el) => {
    if (!el || el === document.body) return "rien";
    const tid = el.getAttribute("data-tid") || el.getAttribute("data-testid");
    const role = el.getAttribute("role");
    return [el.tagName.toLowerCase(), role && `role=${role}`, tid && `data-tid=${tid}`].filter(Boolean).join(" ");
  };
  const editor = () => {
    const picks = [
      '[data-tid="ckeditor"][contenteditable="true"]',
      '[data-tid="ckeditor"] [contenteditable="true"]',
      '[data-tid="message-compose"] [contenteditable="true"]',
      '[role="main"] [role="textbox"][contenteditable="true"]',
      '[role="textbox"][contenteditable="true"]',
    ];
    for (const sel of picks) {
      const el = Array.from(document.querySelectorAll(sel)).find(visible);
      if (el) return el;
    }
    return null;
  };
  const REACTIONS = /^\s*\d+\s+(réactions?|reactions?)\b.*$/gim;
  // Teams web nomme le bouton sendMessageCommands-send (newMessageCommands-send avant) ;
  // son libellé reste le dernier recours.
  const sendButton = () =>
    document.querySelector('[data-tid="sendMessageCommands-send"], [data-tid="newMessageCommands-send"]') ||
    document.querySelector('button[aria-label^="Send"], button[aria-label^="Envoyer"]');
  // Wall-clock deadline: the window is hidden, so timers can be throttled to 1 s or
  // more and counting iterations would wait far longer than the engine does.
  const waitFor = async (check, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return true;
      await sleep(150);
    }
    return check();
  };
  // U+2060 / U+200B : caract\u00e8res de remplissage que CKEditor glisse apr\u00e8s un saut de ligne.
  const flat = (s) => (s || "").replace(/[\u2060\u200b]/g, "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  // La zone de saisie de Teams est un CKEditor 5 : son élément éditable porte l'instance.
  // Un texte posé dans le DOM sans passer par son modèle n'existe pas pour Teams
  // (Envoyer reste inactif, puis l'éditeur se redessine vide) : on écrit dans le modèle.
  const cke = (box) => {
    for (let el = box; el; el = el.parentElement) if (el.ckeditorInstance) return el.ckeditorInstance;
    return null;
  };
  // Texte du modèle de l'éditeur, null quand il est illisible (pas d'instance, autre version).
  const modelText = (box) => {
    try {
      const ed = cke(box);
      if (!ed) return null;
      let out = "";
      for (const step of ed.model.createRangeIn(ed.model.document.getRoot())) {
        out += typeof step.item.data === "string" ? step.item.data : " ";
      }
      return flat(out);
    } catch {
      return null;
    }
  };
  const typeInModel = (box, text) => {
    const ed = cke(box);
    if (!ed) throw new Error("pas d'instance CKEditor");
    text.split(/\r?\n/).forEach((line, i) => {
      if (i) ed.execute(ed.commands.get("shiftEnter") ? "shiftEnter" : "enter");
      if (line) ed.model.change((writer) => ed.model.insertContent(writer.createText(line), ed.model.document.selection));
    });
  };
  // --- Code partagé en Markdown : ``` … ``` en bloc de code, `…` en code en ligne ---
  // L'analyseur HTML de l'éditeur de Teams range un <pre><code> en bloc de code (élément
  // « codeBlock » de son schéma) et un <code> en attribut « code » du texte : on lui
  // donne ce HTML plutôt que de dessiner nous-mêmes dans son modèle.
  const FENCE_OPEN = /^ {0,3}```[^`]*$/;
  const FENCE_CLOSE = /^ {0,3}```\s*$/;
  const INLINE = /`([^`\n]+)`/g;
  // Blocs de prose et blocs de code ; une clôture absente laisse les ``` en texte.
  const codeParts = (text) => {
    const lines = String(text).split(/\r?\n/);
    const parts = [];
    let prose = [];
    const flush = () => {
      // Les lignes vides collées à un bloc de code : Teams espace déjà les blocs.
      const s = prose.join("\n").replace(/^\n+|\n+$/g, "");
      if (s) parts.push({ text: s });
      prose = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const end = FENCE_OPEN.test(lines[i]) ? lines.findIndex((l, j) => j > i && FENCE_CLOSE.test(l)) : -1;
      if (end < 0) {
        prose.push(lines[i]);
        continue;
      }
      flush();
      parts.push({ block: lines.slice(i + 1, end).join("\n") });
      i = end;
    }
    flush();
    return parts;
  };
  const hasCode = (text) => codeParts(text).some((p) => "block" in p || /`[^`\n]+`/.test(p.text));
  // Texte tel que Teams l'affiche une fois le message mis en forme (sans les marques).
  const shownOf = (text) =>
    hasCode(text) ? codeParts(text).map((p) => ("block" in p ? p.block : p.text.replace(INLINE, "$1"))).join("\n") : text;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Hors <pre>, le HTML replie les espaces : on garde ceux du texte.
  const keepSpaces = (s) => s.replace(/ {2}/g, " \u00a0").replace(/^ /, "\u00a0");
  const codeHtml = (text) =>
    codeParts(text)
      .map((p) =>
        "block" in p
          ? `<pre><code>${esc(p.block)}</code></pre>`
          : `<p>${p.text
              .split("\n")
              .map((line) => keepSpaces(esc(line)).replace(INLINE, (_, c) => `<code>${c}</code>`))
              .join("<br>")}</p>`,
      )
      .join("");
  const typeCode = (box, text) => {
    const ed = cke(box);
    if (!ed) throw new Error("pas d'instance CKEditor");
    const frag = ed.data.parse(codeHtml(text));
    // Chaque bloc et chaque code en ligne doivent avoir survécu à l'analyse : sinon le
    // schéma de Teams a changé et on repasse en texte brut plutôt qu'en code perdu.
    let blocks = 0;
    let inline = 0;
    for (const step of ed.model.createRangeIn(frag)) {
      if (step.type === "elementStart" && step.item.name === "codeBlock") blocks++;
      if (step.type === "text" && step.item.hasAttribute("code")) inline++;
    }
    const parts = codeParts(text);
    const wantBlocks = parts.filter((p) => "block" in p).length;
    const wantInline = parts.reduce((n, p) => n + ("text" in p ? (p.text.match(INLINE) || []).length : 0), 0);
    // Deux codes en ligne collés ne font qu'un texte dans le modèle : on n'exige que leur présence.
    if (blocks < wantBlocks || (wantInline && !inline)) throw new Error("mise en forme du code refusée par l'éditeur");
    ed.model.change(() => ed.model.insertContent(frag, ed.model.document.selection));
  };
  const clear = (box) => {
    try {
      const ed = cke(box);
      if (ed) return void ed.setData("");
    } catch {
      /* repli sur le DOM */
    }
    box.focus();
    document.execCommand("selectAll", false);
    document.execCommand("delete", false);
  };
  const caretAtEnd = (box) => {
    box.focus();
    const range = document.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };
  // La fenêtre Teams de Trame est cachée : sans focus, execCommand n'insère souvent
  // rien. Le collage simulé puis l'événement beforeinput passent par l'éditeur de
  // Teams lui-même, sans focus.
  // Rend « code » quand le Markdown de code a été mis en forme : le texte affiché est alors
  // sans ses marques (shownOf). Sinon les ``` et ` restent tels quels, comme tapés.
  const insert = async (box, text) => {
    // Visible dans la zone ET connu de l'éditeur, quand son modèle est lisible.
    const ok = (key) => () => {
      if (!flat(box.innerText).includes(key)) return false;
      const known = modelText(box);
      return known === null || known.includes(key);
    };
    const raw = flat(text).slice(0, 20);
    const tries = [
      ...(hasCode(text) ? [["code", () => typeCode(box, text), flat(shownOf(text)).slice(0, 20)]] : []),
      ["ckeditor", () => typeInModel(box, text)],
      ["execCommand", () => document.execCommand("insertText", false, text)],
      [
        "paste",
        () => {
          const dt = new DataTransfer();
          dt.setData("text/plain", text);
          box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        },
      ],
      [
        "beforeinput",
        () => {
          box.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true }));
        },
      ],
    ];
    for (const [name, run, key = raw] of tries) {
      caretAtEnd(box);
      try {
        run();
      } catch {
        continue;
      }
      if (await waitFor(ok(key), 600)) return name;
      if (box.innerText.trim()) clear(box);
    }
    return null;
  };
  // Pièces jointes. Les fichiers arrivent du moteur (octets choisis par l'utilisateur
  // dans Trame) : la page ne lit jamais de fichier sur le disque. Ils passent par le
  // champ fichier de Teams (« Joindre »), sinon par un dépôt ou un collage sur l'éditeur,
  // comme si l'utilisateur les y glissait.
  const composeRoot = (box) => {
    const btn = sendButton();
    for (let el = box; el && el !== document.body; el = el.parentElement) if (btn && el.contains(btn)) return el;
    return box?.parentElement || null;
  };
  const shownText = (root) => {
    if (!root) return "";
    const parts = [root.innerText];
    for (const el of root.querySelectorAll("[aria-label], [title]")) parts.push(el.getAttribute("aria-label") || "", el.getAttribute("title") || "");
    return norm(parts.join(" "));
  };
  const REMOVE = /^(remove|supprimer|retirer|delete)\b/i;
  // « Supprimer » de la barre de la zone de saisie rejette tout le brouillon (avec une
  // confirmation) : ce n'est pas le retrait d'une pièce jointe.
  const DISCARD = '[data-tid="newMessageCommands-discard-draft"]';
  const removeButtons = (root) =>
    Array.from(root?.querySelectorAll("button[aria-label]") || []).filter(
      (b) => REMOVE.test(b.getAttribute("aria-label") || "") && !b.matches(DISCARD)
    );
  // Rejeter le brouillon que Teams garde pour la conversation (texte, image collée,
  // pièce jointe) : bouton « Supprimer », puis « Supprimer » dans la confirmation.
  const discardDraft = async () => {
    const btn = Array.from(document.querySelectorAll(DISCARD)).find(visible);
    if (!btn) return false;
    btn.click();
    const confirm = () => Array.from(document.querySelectorAll('[data-tid="messagedraft-discard-confirm"]')).find(visible);
    if (!seen("discard_confirm", await waitFor(confirm, 2000))) return false;
    confirm().click();
    return waitFor(() => !confirm(), 2000);
  };
  const uploading = (root) => Boolean(root?.querySelector('[role="progressbar"]'));
  // Teams enchaîne deux barres de progression (téléversement, puis droits de partage)
  // séparées d'un court répit : terminé seulement quand aucune n'est revenue depuis 1,5 s.
  const uploaded = async (box, until) => {
    let quiet = 0;
    while (Date.now() < until) {
      if (uploading(composeRoot(box))) quiet = 0;
      else if (!quiet) quiet = Date.now();
      else if (Date.now() - quiet >= 1500) return true;
      await sleep(250);
    }
    return !uploading(composeRoot(box));
  };
  const toFiles = (files) =>
    files.map((f) => {
      const bin = atob(f.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], f.name, { type: f.type || "application/octet-stream" });
    });
  // Seul le champ fichier de la zone de saisie : jamais un autre champ de la page (photo
  // de profil, arrière-plan…) qui enverrait le fichier ailleurs. Un champ réservé aux
  // images ne convient pas à un document.
  const fileInput = (root) =>
    Array.from(root?.querySelectorAll('input[type="file"]') || []).find((el) => !/^\s*image\//.test(el.accept || "")) || null;
  // Teams web n'a aucun champ fichier en attente : « Joindre » ouvre un menu dont
  // « Charger à partir de cet appareil » crée un champ éphémère et l'ouvre par click().
  // Le temps de ce geste, ce click() est retenu (aucune boîte de dialogue Windows dans
  // la fenêtre cachée) et le champ rendu au pont, qui y pose les fichiers.
  const PICKER = LM.attach;
  const pickerButton = (root) =>
    root?.querySelector(PICKER) ||
    Array.from(root?.querySelectorAll("button[aria-label]") || []).find((b) => /^(joindre|attach)\b/i.test(b.getAttribute("aria-label") || "")) ||
    null;
  const FROM_DEVICE = /(cet appareil|this device|mon ordinateur|my computer|upload from)/i;
  const deviceItem = () => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')).filter(visible);
    return (
      items.find((el) => FROM_DEVICE.test(`${el.innerText} ${el.getAttribute("aria-label") || ""}`)) ||
      (items.length === 2 && items.find((el) => !/cloud|onedrive/i.test(el.innerText))) ||
      null
    );
  };
  const closeMenu = () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
  const pickedInput = async (box) => {
    const btn = pickerButton(composeRoot(box));
    if (!btn) throw new Error("pas de bouton Joindre");
    const proto = HTMLInputElement.prototype;
    const own = { click: proto.click, showPicker: proto.showPicker };
    let caught = null;
    const hold = (name) =>
      function (...args) {
        if (this.type === "file") {
          caught = this;
          return undefined;
        }
        return own[name].apply(this, args);
      };
    proto.click = hold("click");
    if (own.showPicker) proto.showPicker = hold("showPicker");
    try {
      btn.click();
      if (!seen("attach_menu", await waitFor(() => deviceItem(), 2000))) throw new Error("menu Joindre sans « cet appareil »");
      deviceItem().click();
      if (!(await waitFor(() => caught, 2000))) throw new Error("Teams n'a pas ouvert de champ fichier");
      return caught;
    } finally {
      proto.click = own.click;
      if (own.showPicker) proto.showPicker = own.showPicker;
      if (!caught) closeMenu();
    }
  };
  const fill = (input, dt) => {
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const attach = async (box, files) => {
    const list = toFiles(files);
    const transfer = () => {
      const dt = new DataTransfer();
      list.forEach((f) => dt.items.add(f));
      return dt;
    };
    const names = files.map((f) => norm(f.name));
    const listed = () => {
      const t = shownText(composeRoot(box));
      return names.every((n) => t.includes(n));
    };
    const tries = [
      ["menu Joindre", async () => fill(await pickedInput(box), transfer())],
      [
        "champ fichier",
        () => {
          const input = fileInput(composeRoot(box));
          if (!input) throw new Error("pas de champ fichier");
          fill(input, transfer());
        },
      ],
      [
        "dépôt",
        () => {
          const dt = transfer();
          for (const type of ["dragenter", "dragover", "drop"]) {
            box.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
          }
        },
      ],
      [
        "collage",
        () => box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer(), bubbles: true, cancelable: true })),
      ],
    ];
    for (const [how, run] of tries) {
      if (late()) return null;
      try {
        await run();
      } catch {
        continue;
      }
      if (await waitFor(listed, 5000)) {
        // Teams téléverse le fichier (OneDrive) avant de permettre l'envoi, sans griser
        // Envoyer : on attend la fin, en gardant de quoi envoyer et confirmer avant que le
        // moteur abandonne.
        const end = Math.max(Date.now() + 2000, (deadline || Date.now() + 60000) - 20000);
        if (!(await uploaded(box, end))) return { how, error: "téléversement toujours en cours" };
        await waitFor(sendReady, 1500);
        return { how };
      }
    }
    return null;
  };
  const dropAttachments = (box) => removeButtons(composeRoot(box)).forEach((b) => b.click());
  // Un fichier pris par Teams après l'abandon (téléversement lent, essai suivant) arrive
  // dans la zone de saisie une fois le nettoyage fait : il y resterait, et partirait avec
  // le message suivant. On surveille donc encore quelques secondes et on le retire.
  const dropLateAttachments = async (box, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (removeButtons(composeRoot(box)).length) dropAttachments(box);
      await sleep(400);
    }
    dropAttachments(box);
  };
  // Ce qui occupe la zone de saisie, sans son texte : du texte tapé, des pièces jointes
  // (leurs noms), des éléments sans texte (image collée…).
  const composeState = (box) => {
    const ed = cke(box);
    let text = "";
    let objects = 0;
    try {
      for (const step of ed.model.createRangeIn(ed.model.document.getRoot())) {
        if (typeof step.item.data === "string") text += step.item.data;
        else if (step.type === "elementStart" && !/^(paragraph|softBreak)$/.test(step.item.name || "")) objects++;
      }
    } catch {
      text = box.innerText;
    }
    const files = removeButtons(composeRoot(box)).map((b) => (b.getAttribute("aria-label") || "").replace(REMOVE, "").trim());
    return { text: Boolean(flat(text)), files, objects };
  };
  // Refus « zone de saisie non vide » qui dit ce qui l'occupe : l'utilisateur peut la
  // vider depuis Trame (clearcompose) en connaissance de cause.
  const notEmpty = (box) => {
    const st = composeState(box);
    const what = [st.text && "du texte", st.files.length && `une pièce jointe (${st.files.join(", ")})`, !st.text && st.objects && "une image ou un élément collé"]
      .filter(Boolean)
      .join(" et ");
    return { ok: false, busy: true, error: `zone de saisie non vide : ${what || "contenu non identifié"} attend dans Teams` };
  };
  const NEW_CHAT = LM.new_chat;
  const TO_FIELD = LM.people_picker;
  // Recherche de Teams : champ du haut, page de résultats, bouton Conversation de la barre
  // d'applications pour en revenir (l'id est celui de l'application Conversation de Teams).
  const SEARCH_INPUT = LM.search_input;
  const CHAT_APP = LM.chat_app;
  const searchCards = () => Array.from(document.querySelectorAll('[data-tid="search-message-card"]'));
  // « Damien Battistella (Vous) » : tes propres messages.
  const SELF = /\s*\((vous|you)\)\s*$/i;
  // Une carte est une ligne de grille : en-tête (conversation), une cellule expéditeur et
  // date, puis la cellule du texte du message.
  const readCard = (card) => {
    const row = card.closest('[role="row"]') || card;
    const header = row.querySelector('[data-tid="message-app-card-header"]');
    const conversation = header?.querySelector("[title]")?.getAttribute("title") || "";
    const meta = row.querySelector('[id^="serp-message-card-content"]');
    const body = Array.from(row.querySelectorAll('[role="gridcell"]'))
      .filter((cell) => !cell.contains(meta) && !cell.contains(header))
      .map((cell) => cell.textContent)
      .join(" ");
    const who = flat(meta?.firstElementChild?.textContent);
    const mine = SELF.test(who);
    const sender = who.replace(SELF, "");
    // Conversation privée : l'en-tête porte ton propre nom ou « Conversation », pas celui
    // de l'autre personne. C'est alors l'expéditeur, sauf pour tes propres messages.
    let name = flat(conversation);
    if (!name || SELF.test(name) || /^(conversation|chat)$/i.test(name)) name = mine ? "" : sender;
    return {
      conversation: name,
      sender,
      mine,
      at: meta && meta.lastElementChild !== meta.firstElementChild ? flat(meta.lastElementChild.textContent) : "",
      text: flat(body),
    };
  };
  const MSGS = LM.messages;
  const lastMessages = (n) => Array.from(document.querySelectorAll(MSGS)).slice(-n).map((el) => flat(el.innerText));
  // Messages du fil apparus depuis cet instant : ni leur identifiant ni (sans identifiant)
  // leur élément n'étaient là. Un message déjà affiché, même redessiné, n'en fait pas partie.
  const newMessages = () => {
    const els = new Set(document.querySelectorAll(MSGS));
    const ids = new Set(Array.from(els, (el) => msgId(el)).filter(Boolean));
    return () =>
      Array.from(document.querySelectorAll(MSGS))
        .slice(-6)
        .filter((el) => {
          const id = msgId(el);
          return id ? !ids.has(id) : !els.has(el);
        });
  };
  let deadline = 0;
  const late = () => deadline && Date.now() > deadline;

  // --- Réunion de la conversation ouverte (lecture seule) ---
  // Une conversation de réunion porte, dans son en-tête, un bouton « Rejoindre » sans lien :
  // le lien de la réunion n'est que dans les données de la conversation que Teams donne aux
  // composants de cet en-tête (chat.meetingInformation.meetingJoinUrl), et « en cours » dans
  // isLive / chat.activeCall. Rien n'est cliqué. Pas de repli sur un lien collé dans le fil :
  // dans un groupe, il mènerait à une autre réunion que celle de la conversation.
  const MEETING_FROM = ['[data-tid="chat-join-button"]', '[data-tid="entity-header-toolbar"]', '[data-tid="chat-meeting-details"]'];
  const MEETUP = /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//;
  const fiberOf = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    return key ? el[key] : null;
  };
  const meetingInfo = () => {
    for (const sel of MEETING_FROM) {
      const el = document.querySelector(sel);
      for (let f = el && fiberOf(el), i = 0; f && i < 40; f = f.return, i++) {
        const props = f.memoizedProps;
        const chat = props && typeof props === "object" ? props.chat : null;
        if (!chat || typeof chat !== "object" || !("meetingInformation" in chat)) continue;
        const url = chat.meetingInformation?.meetingJoinUrl;
        if (typeof url !== "string" || !MEETUP.test(url)) return null;
        return { url, live: props.isLive === true || Boolean(chat.activeCall) };
      }
    }
    return null;
  };

  // --- Corps d'un message : texte, liens et cartes d'aperçu (lecture seule) ---
  // Le texte d'un lien Teams (« [ALL-141] Recherche identité - Jira ») n'est pas son adresse,
  // et un aperçu (carte Jira, aperçu d'un site) mêle titre, libellés et boutons. Lus par
  // innerText, les deux devenaient du texte bruité. Ici : le texte du corps sans les cartes ni
  // les boutons, ses liens (texte et adresse http(s)) et, par carte, un résumé (source,
  // titre, adresse, quelques champs). N'utilise que nodeType / tagName / childNodes /
  // getAttribute : ui/tests/messageParts.test.ts l'exécute tel quel sur des fragments relevés.
  // >>> message-parts
  const messageParts = (() => {
    const BLOCK = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "TABLE", "TR", "SECTION", "ARTICLE", "HEADER", "FOOTER", "FIGURE"]);
    const SKIP = new Set(["SCRIPT", "STYLE", "BUTTON", "SVG", "IMG", "TEMPLATE", "NOSCRIPT", "VIDEO", "AUDIO", "CANVAS"]);
    // Pas role=button : une mention (@quelqu'un) en est un, dans le texte du message.
    const SKIP_ROLES = new Set(["toolbar", "progressbar", "menu"]);
    const TRACKING = /^(atlOrigin|utm_\w+)$/i;
    const attr = (el, k) => (el && el.getAttribute && el.getAttribute(k)) || "";
    const tag = (el) => String(el.tagName || "").toUpperCase();
    const one = (s) => String(s || "").replace(/[\u2060\u200b]/g, "").replace(/\s+/g, " ").trim();
    const elements = (el) => Array.from(el.childNodes || []).filter((n) => n.nodeType === 1);
    const hasClass = (el, c) => ` ${attr(el, "class")} `.includes(` ${c} `);
    // Éléments les plus hauts qui répondent au test (on ne descend pas dans un élément trouvé).
    const find = (el, test, out = []) => {
      for (const c of elements(el)) {
        if (test(c)) out.push(c);
        else find(c, test, out);
      }
      return out;
    };
    const first = (el, test) => find(el, test)[0] || null;
    const isPreview = (el) => attr(el, "data-tid") === "url-preview";
    const isAppCard = (el) => attr(el, "data-testid") === "componentUXWrapperTestId" || attr(el, "data-tid") === "adaptive-card";
    const isCard = (el) => isAppCard(el) || isPreview(el) || (tag(el) === "A" && Boolean(first(el, isPreview)));
    // Citation d'une réponse (« Répondre ») : dans le HTML du service de chat, un <blockquote>
    // typé Reply (auteur, heure, extrait) ; dans la page, la carte de citation de Teams.
    const isQuote = (el) => /schema\.skype\.com\/Reply/i.test(attr(el, "itemtype")) || /quoted-reply/i.test(attr(el, "data-tid"));
    const isMention = (el) => /schema\.skype\.com\/Mention/i.test(attr(el, "itemtype"));
    const QUOTE_WHEN = /^(\d{1,2}\/\d{1,2}(\/\d{2,4})?\s+)?\d{1,2}:\d{2}$|^(hier|aujourd'hui|yesterday|today|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b.*\d{1,2}:\d{2}$/i;
    // Adresse ouvrable : http(s) seulement ; un lien « Safe Links » d'Outlook donne l'adresse
    // qu'il protège ; les paramètres de suivi (atlOrigin, utm_*) sont retirés.
    const safeUrl = (href) => {
      try {
        const u = new URL(String(href || "").trim());
        if (/(^|\.)safelinks\.protection\.outlook\.com$/i.test(u.hostname) && u.searchParams.get("url")) return safeUrl(u.searchParams.get("url"));
        if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) return "";
        const drop = Array.from(u.searchParams.keys()).filter((k) => TRACKING.test(k));
        if (!drop.length) return String(href).trim();
        for (const k of drop) u.searchParams.delete(k);
        return u.href;
      } catch {
        return "";
      }
    };
    // Dans la page, l'affichage réel décide (Teams met en bloc des <span> par CSS, comme
    // l'auteur et la date d'une citation) ; hors page (tests), la balise.
    const display = (el) => {
      if (typeof getComputedStyle !== "function" || !el.isConnected) return BLOCK.has(tag(el)) ? "block" : "inline";
      return getComputedStyle(el).display || "inline";
    };
    // Texte tel qu'affiché : blocs sur leur ligne, espaces repliés (sauf dans <pre>), sans
    // boutons, barres d'outils, images, éléments masqués ni cartes.
    const textOf = (root, seen = null) => {
      let out = "";
      let last = null;
      const walk = (n, pre) => {
        if (n.nodeType === 3) {
          let t = String(n.data || "");
          if (!pre) {
            t = t.replace(/[ \t\r\n\f]+/g, " ");
            if (!out || out.endsWith("\n") || out.endsWith(" ")) t = t.replace(/^ /, "");
          }
          out += t;
          return;
        }
        if (n.nodeType !== 1) return;
        const t = tag(n);
        // Pièces jointes : lues à part (messageFiles) ; leur grille porte aussi le texte
        // d'attente de Teams (« Le chargement est en cours… »), jamais celui du message.
        if (SKIP.has(t) || SKIP_ROLES.has(attr(n, "role")) || isCard(n) || attr(n, "data-tid") === "file-attachment-grid") return;
        // La citation est rendue à part (seen.quote), jamais mêlée au texte de la réponse.
        if (n !== root && isQuote(n)) {
          if (seen && !seen.quote) seen.quote = quoteOf(n);
          return;
        }
        if (seen && isMention(n)) {
          // Teams découpe un nom mentionné en un élément par mot : « Ana » puis « Lopez ».
          const from = last && !out.slice(last.end).trim() ? last.start : out.length;
          for (const c of Array.from(n.childNodes || [])) walk(c, pre);
          const name = one(out.slice(from));
          if (!name) return;
          if (last && from === last.start) seen.mentions[seen.mentions.length - 1] = name;
          else seen.mentions.push(name);
          last = { start: from, end: out.length };
          return;
        }
        if (t === "BR") {
          out += "\n";
          return;
        }
        const d = display(n);
        if (d === "none") return;
        if (t === "TABLE") {
          const md = tableOf(n);
          if (md) {
            if (out && !out.endsWith("\n")) out += "\n";
            out += `${md}\n`;
            return;
          }
        }
        const cell = d === "table-cell" || t === "TD" || t === "TH";
        const block = !cell && !d.startsWith("inline") && d !== "contents";
        if (block && out && !out.endsWith("\n")) out += "\n";
        for (const c of Array.from(n.childNodes || [])) walk(c, pre || t === "PRE");
        if (block && !out.endsWith("\n")) out += "\n";
        else if (cell && !out.endsWith(" ")) out += " ";
      };
      walk(root, false);
      return out.replace(/\u00a0/g, " ").replace(/[\u2060\u200b]/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
    };
    // Tableau du message en Markdown (« | a | b | », ligne de séparation après la première) :
    // lisible par le cerveau, rendu en vrai tableau par Trame. Cellules sur une ligne, « | »
    // échappé ; les tableaux imbriqués restent dans leur cellule. null s'il n'a pas deux colonnes.
    const rowsOf = (table) => {
      const rows = [];
      const walkRows = (el) => {
        for (const c of elements(el)) {
          if (tag(c) === "TR") rows.push(c);
          else if (tag(c) !== "TABLE") walkRows(c);
        }
      };
      walkRows(table);
      return rows;
    };
    const tableOf = (table) => {
      const rows = rowsOf(table)
        .map((tr) => elements(tr).filter((c) => tag(c) === "TD" || tag(c) === "TH").map((c) => one(textOf(c)).replace(/\|/g, "\\|")))
        .filter((r) => r.some(Boolean));
      const width = Math.max(0, ...rows.map((r) => r.length));
      if (rows.length < 1 || width < 2) return null;
      const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] || "").join(" | ")} |`;
      return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
    };
    // Liens du corps (hors cartes) : texte affiché et adresse, sans doublon.
    const linksOf = (root) => {
      const out = [];
      const seen = new Set();
      for (const a of find(root, (el) => isCard(el) || isQuote(el) || (tag(el) === "A" && attr(el, "href")))) {
        if (isCard(a) || isQuote(a)) continue;
        const url = safeUrl(attr(a, "href"));
        const text = one(textOf(a)) || url;
        if (!url || seen.has(`${text}\n${url}`)) continue;
        seen.add(`${text}\n${url}`);
        out.push({ text: text.slice(0, 300), url });
      }
      return out.slice(0, 20);
    };
    const sourceOf = (url, fallback = "") => {
      try {
        const h = new URL(url).hostname.replace(/^www\./, "");
        if (/(^|\.)atlassian\.net$/.test(h)) return "Jira";
        if (/(^|\.)github\.(com|io)$/.test(h)) return "GitHub";
        if (/(^|\.)gitlab\./.test(h)) return "GitLab";
        return fallback || h;
      } catch {
        return fallback;
      }
    };
    const shortUrl = (url) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/$/, "");
    // Aperçu d'un site : lien autour de data-tid=url-preview, son corps donne titre,
    // description et domaine. Seuls le titre et l'adresse sont gardés.
    const previewCard = (el) => {
      const a = tag(el) === "A" ? el : first(el, (x) => tag(x) === "A" && attr(x, "href"));
      const url = safeUrl(attr(a, "href"));
      const body = first(el, (x) => attr(x, "data-tid") === "url-preview-body");
      const parts = body ? elements(body).map((x) => one(textOf(x))).filter(Boolean) : [];
      const site = parts.length > 1 ? parts[parts.length - 1] : "";
      const source = sourceOf(url, site);
      let title = parts[0] || "";
      if (!title || title.toLowerCase() === source.toLowerCase()) title = url ? shortUrl(url) : title;
      return { source, title, url, fields: [] };
    };
    // Carte d'application (Jira…) : en-tête (source), puis la carte adaptative : son premier
    // lien est le titre, ses blocs de texte des champs (assignée, priorité, état). Les
    // boutons (Comment, Edit, Notify) ne sont jamais lus.
    const appCard = (el) => {
      const head = first(el, (x) => attr(x, "data-testid") === "headerTitleTestId");
      const titleLink = first(el, (x) => attr(x, "data-testid") === "titleLinkTestId");
      const ac = first(el, (x) => hasClass(x, "ac-adaptiveCard")) || el;
      const noActions = (x) => hasClass(x, "ac-actionSet") || SKIP.has(tag(x)) || SKIP_ROLES.has(attr(x, "role")) || attr(x, "role") === "button";
      const a = find(ac, (x) => noActions(x) || (tag(x) === "A" && safeUrl(attr(x, "href")))).find((x) => !noActions(x)) || null;
      const url = a ? safeUrl(attr(a, "href")) : "";
      const blocks = find(ac, (x) => noActions(x) || hasClass(x, "ac-textBlock"))
        .filter((x) => !noActions(x))
        .map((x) => one(textOf(x)).slice(0, 120))
        .filter((t) => /[\p{L}\p{N}]/u.test(t));
      const title = (a ? one(textOf(a)) : "") || blocks[0] || "";
      const fields = blocks.filter((t) => t !== title).slice(0, 3);
      const source = one(textOf(head || { childNodes: [] })) || one(attr(titleLink, "aria-label")) || sourceOf(url);
      return { source: source.slice(0, 60), title: title.slice(0, 200), url, fields };
    };
    const cardsOf = (root) =>
      find(root, (el) => isAppCard(el) || isPreview(el) || (tag(el) === "A" && Boolean(first(el, isPreview))))
        .map((el) => (isAppCard(el) ? appCard(el) : previewCard(el)))
        .filter((c) => c.title || c.url)
        .slice(0, 5);
    // Auteur, heure et extrait d'une citation : par leurs propriétés (service de chat), sinon
    // par leurs lignes (auteur, heure si elle en a l'air, puis l'extrait).
    const quoteOf = (el) => {
      const prop = (k) => first(el, (x) => attr(x, "itemprop") === k);
      const lines = textOf(el).split("\n").map(one).filter(Boolean);
      const mri = prop("mri");
      const preview = prop("preview");
      let sender = mri ? one(textOf(mri)) : lines.shift() || "";
      if (mri && lines[0] === sender) lines.shift();
      const at = QUOTE_WHEN.test(lines[0] || "") && (preview || lines.length > 1) ? lines.shift() : "";
      const text = preview ? textOf(preview) : lines.join("\n");
      sender = sender.slice(0, 200);
      return text || sender ? { sender, at: at.slice(0, 40), text: text.slice(0, 2000) } : null;
    };
    const EMPTY = () => ({ text: "", links: [], cards: [], quote: null, mentions: [] });
    return (root) => {
      if (!root) return EMPTY();
      const seen = { quote: null, mentions: [] };
      const text = textOf(root, seen);
      return { text, links: linksOf(root), cards: cardsOf(root), quote: seen.quote, mentions: [...new Set(seen.mentions)].slice(0, 20) };
    };
  })();
  // <<< message-parts
  // Le corps d'un message du fil : bulle de Teams, sinon son contenu.
  const partsOf = (el) => {
    const parts = messageParts(el.querySelector('[data-tid="chat-pane-message"]') || el.querySelector('[id^="content-"]'));
    return { ...parts, text: parts.text.replace(REACTIONS, "").replace(/\s+\n/g, "\n").trim() };
  };

  // --- Pièces jointes d'un message du fil (lecture, et preuve d'envoi) ---
  // Fichier : une carte de « file-attachment-grid », nommée par son aria-label ; son titre
  // porte « nom + lien » (SharePoint / OneDrive). Image : celles du corps du message (les
  // émojis n'ont pas de data-gallery-src). Une image jointe s'affiche en vignette : son nom
  // n'est jamais dans le texte visible, seulement dans ces attributs. N'utilise que nodeType /
  // tagName / childNodes / getAttribute : ui/tests/sentFiles.test.ts l'exécute tel quel.
  // >>> message-files
  const messageFiles = (() => {
    const attr = (el, k) => (el && el.getAttribute && el.getAttribute(k)) || "";
    const elements = (el) => Array.from((el && el.childNodes) || []).filter((n) => n.nodeType === 1);
    const all = (el, test, out = []) => {
      for (const c of elements(el)) {
        if (test(c)) out.push(c);
        all(c, test, out);
      }
      return out;
    };
    const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
    const isGrid = (el) => attr(el, "data-tid") === "file-attachment-grid";
    const isBody = (el) => attr(el, "data-tid") === "chat-pane-message";
    const isCard = (el) => attr(el, "role") === "group" && Boolean(attr(el, "aria-label").trim());
    // Puce de fichier (vidéo Stream, notamment) : pas de carte « group », un bouton dont le
    // title porte « nom \n lien ». Son aria-label (« Pièce jointe nom. Appuyez… ») ne sert pas de nom.
    const isChiclet = (el) => attr(el, "data-testid") === "file-attachment" && !isCard(el);
    const VIDEO = /\.(mp4|m4v|mov|webm|wmv|avi|mkv)$/i;
    const kindOf = (el, name) => (/video/i.test(attr(el, "filepreviewtype")) || VIDEO.test(name) ? "video" : "");
    const filesOf = (root) => {
      const grids = all(root, isGrid);
      const cards = Array.from(new Set(grids.flatMap((grid) => all(grid, isCard))));
      const inCard = new Set(cards.flatMap((card) => all(card, isChiclet)));
      const chiclets = Array.from(new Set(grids.flatMap((grid) => all(grid, isChiclet)))).filter((el) => !inCard.has(el));
      return [
        ...cards.map((card) => {
          const title = attr(all(card, (el) => attr(el, "data-testid") === "content-card-custom-title")[0], "aria-label");
          const url = (title.match(/https:\/\/\S+/) || [""])[0];
          const name = attr(card, "aria-label").trim();
          return { name, url, kind: kindOf(card, name), labels: [attr(card, "aria-label"), attr(card, "title"), title].filter(Boolean) };
        }),
        ...chiclets.map((el) => {
          const [first = "", ...rest] = attr(el, "title").split(/\r?\n/);
          const name = first.trim() || attr(el, "data-tid").replace(/^file-chiclet-/, "").trim();
          const url = (rest.join(" ").match(/https:\/\/\S+/) || [""])[0];
          return { name, url, kind: kindOf(el, name), labels: [attr(el, "title"), attr(el, "aria-label")].filter(Boolean) };
        }),
      ].filter((f) => f.name);
    };
    const isImg = (el) => String(el.tagName || "").toUpperCase() === "IMG";
    // Images jointes ou collées : servies par Teams, avec leur source d'origine.
    const attachedOf = (root) =>
      all(root, isBody).flatMap((body) => all(body, (el) => isImg(el) && Boolean(attr(el, "data-gallery-src") || attr(el, "data-orig-src"))));
    // GIF animé choisi dans Teams (Giphy) : une simple <img> vers le CDN de Giphy, sans
    // attribut de Teams. Montré comme une image ; il ne prouve pas l'envoi d'un fichier.
    const GIF = /^https:\/\/([a-z0-9-]+\.)*giphy\.com\//i;
    const imagesOf = (root) =>
      all(root, isBody).flatMap((body) =>
        all(body, (el) => isImg(el) && Boolean(attr(el, "data-gallery-src") || attr(el, "data-orig-src") || GIF.test(attr(el, "src"))))
      );
    const imageLabels = (img) => ["alt", "title", "aria-label"].map((k) => attr(img, k)).filter(Boolean);
    // Même fichier, au renommage près d'un doublon par Teams / OneDrive : « nom 1.png »,
    // « nom (1).png ». Le libellé peut entourer le nom (« Image capture.png, 102 Ko »).
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sameFile = (wanted, label) => {
      const n = fold(wanted);
      const dot = n.lastIndexOf(".");
      const [stem, ext] = dot > 0 ? [n.slice(0, dot), n.slice(dot)] : [n, ""];
      const re = String.raw`(^|[\s,:;«"'(])` + esc(stem) + String.raw`(?: \d{1,3}| ?\(\d{1,3}\))?` + esc(ext) + String.raw`(?=$|[\s,:;»"')])`;
      return new RegExp(re).test(fold(label));
    };
    const IMAGE = /\.(png|jpe?g|gif|bmp|webp|heic|heif)$/i;
    // Fichiers voulus que ces messages ne montrent pas. Chaque carte ou image ne vaut que pour
    // un fichier. Une image affichée sans son nom (collée dans le corps par Teams) vaut pour
    // une image voulue que rien d'autre ne montre.
    const missing = (wanted, roots) => {
      const cards = roots.flatMap(filesOf).map((f) => f.labels);
      const imgs = roots.flatMap((root) => attachedOf(root)).map(imageLabels);
      const left = [];
      for (const name of wanted) {
        const take = (pool) => {
          const i = pool.findIndex((labels) => labels.some((l) => sameFile(name, l)));
          return i >= 0 && pool.splice(i, 1).length > 0;
        };
        if (take(cards) || take(imgs)) continue;
        left.push(name);
      }
      return left.filter((name) => {
        if (!IMAGE.test(name)) return true;
        const i = imgs.findIndex((labels) => !labels.some((l) => wanted.some((w) => sameFile(w, l))));
        return !(i >= 0 && imgs.splice(i, 1).length > 0);
      });
    };
    return { filesOf: (root) => filesOf(root).map(({ name, url, kind }) => (kind ? { name, url, kind } : { name, url })), imagesOf, missing, sameFile };
  })();
  // <<< message-files
  const filesOf = messageFiles.filesOf;
  const imagesOf = messageFiles.imagesOf;
  // 2048 px : assez pour lire une capture d'écran une fois zoomée dans la visionneuse. Le
  // budget (taille des data URL cumulées) garde les 8 aperçus à cette résolution.
  const THUMBS = { max: 8, width: 2048, budget: 6_000_000 };
  const loaded = (img) => img.complete && img.naturalWidth > 0;
  const local = (src) => {
    try {
      return src.startsWith("blob:") || src.startsWith("data:image/") || new URL(src).origin === location.origin;
    } catch {
      return false;
    }
  };
  // L'image d'origine, demandée au service Teams qui la sert (AMS), signée DANS la page
  // avec l'auth que Teams a posée pour cet hôte (comme `webfetch`) : pour une image que
  // Teams n'a pas encore chargée (chargement différé) ou qu'il affiche par son adresse.
  const fetchSigned = async (img) => {
    const urls = ["data-orig-src", "data-gallery-src", "src"].map((k) => img.getAttribute(k) || "");
    for (const raw of urls) {
      let u;
      try {
        u = new URL(raw, location.origin);
      } catch {
        continue;
      }
      if (u.protocol === "https:" && GIF_HOSTS.test(u.hostname)) {
        const blob = await gifBlob(u.toString());
        if (blob) return blob;
        continue;
      }
      if (u.protocol !== "https:" || !API_HOSTS.test(u.hostname)) continue;
      const headers = {};
      const c = apiCapture.credsFor(u.toString());
      if (c && c.authorization) headers["Authorization"] = c.authorization;
      if (c && c.xSkypetoken) headers["X-Skypetoken"] = c.xSkypetoken;
      try {
        const res = await fetch(u.toString(), { credentials: "include", headers });
        const blob = res.ok ? await res.blob() : null;
        if (blob && /^image\//.test(blob.type || res.headers.get("content-type") || "")) return blob;
      } catch {}
    }
    return null;
  };
  // Miniature JPEG d'une image d'un message : celle que Teams affiche déjà (adresse blob:
  // de la page), sinon l'originale demandée au service Teams ; null si rien n'est lisible.
  const thumbnail = async (img) => {
    try {
      const src = img.currentSrc || img.src || "";
      const blob = loaded(img) && local(src) ? await (await fetch(src)).blob() : await fetchSigned(img);
      if (!blob) return null;
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, THUMBS.width / bitmap.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return { data: canvas.toDataURL("image/jpeg", 0.8), width: canvas.width, height: canvas.height };
    } catch {
      return null;
    }
  };
  // >>> thread-climb
  // Lit le fil affiché de la fin vers le début. Teams ne dessine qu'une fenêtre du fil et
  // rouvre une conversation là où on l'avait laissée : on descend d'abord tout en bas
  // (jusqu'à ce que Teams ne charge plus rien), puis on remonte par pas qui se recouvrent.
  // Une vue ne s'ajoute que si elle recoupe ce qui est déjà lu : sans message commun, Teams
  // a sauté plus loin que l'écran lu (des messages manqueraient au milieu), alors on
  // redescend d'un demi-pas pour retrouver le raccord, et sinon on s'arrête là plutôt que
  // de laisser un trou. `snap()` : messages affichés, dans l'ordre, chacun avec sa `key`.
  // `enough(acc)` : assez lu. top : le début de la conversation est atteint.
  const climb = async (box, snap, enough, late = () => false, budget = 20000) => {
    if (!box) {
      const acc = snap();
      return { acc, top: !enough(acc), gap: false };
    }
    const end = Date.now() + budget;
    // En bas : stable quand ni la hauteur ni le dernier message dessiné ne bougent plus
    // (Teams dessine après le défilement, et charge parfois des messages plus récents).
    for (let seen = "", tries = 0; tries < 12; tries++) {
      box.scrollTop = box.scrollHeight;
      await sleep(250);
      const view = snap();
      const now = `${box.scrollHeight}|${view.length ? view[view.length - 1].key : ""}`;
      if (now === seen) break;
      seen = now;
    }
    let acc = snap();
    // "more" : des messages plus anciens ajoutés ; "gap" : vue sans message commun.
    const merge = () => {
      const known = new Set(acc.map((m) => m.key));
      const view = snap();
      const cut = view.findIndex((m) => known.has(m.key));
      if (cut < 0) return view.length ? "gap" : "";
      const older = view.slice(0, cut).filter((m) => !known.has(m.key));
      if (older.length) acc = [...older, ...acc];
      return older.length ? "more" : "";
    };
    const step = () => Math.max(120, Math.floor(box.clientHeight * 0.6));
    let top = false;
    let gap = false;
    for (let stalls = 0; !enough(acc) && Date.now() < end && !late(); ) {
      const height = box.scrollHeight;
      const atTop = box.scrollTop <= 0;
      if (atTop) {
        // Teams charge la suite quand on arrive en haut : un petit aller-retour pour qu'il
        // voie un défilement même si l'on y est déjà.
        box.scrollTop = Math.min(200, height);
        await sleep(50);
        box.scrollTop = 0;
      } else box.scrollTop = Math.max(0, box.scrollTop - step());
      let res = "";
      await waitFor(() => (res = merge()) === "more" || box.scrollHeight !== height, atTop ? 1500 : 400);
      res = merge() || res;
      if (res === "gap") {
        box.scrollTop = Math.min(box.scrollHeight, box.scrollTop + Math.floor(step() / 2));
        await sleep(200);
        if (merge() === "gap") {
          gap = true;
          break;
        }
      }
      if (res === "more" || box.scrollHeight !== height) stalls = 0;
      else if (atTop && ++stalls >= 3) {
        // Trois essais en haut sans rien de nouveau : c'est le début de la conversation.
        // Une limite de temps atteinte, elle, ne dit rien du début (top reste faux).
        top = true;
        break;
      }
    }
    box.scrollTop = box.scrollHeight;
    return { acc, top, gap };
  };
  // <<< thread-climb
  // Après la lecture, seuls les messages encore affichés ont leurs images dans la page :
  // les plus récents d'abord, dans la limite du nombre et du poids. Les autres restent
  // « image » sans aperçu (à voir dans Teams).
  const thumbnails = async (messages) => {
    const byId = new Map();
    for (const el of document.querySelectorAll(MSGS)) {
      const id = el.querySelector('[id^="content-"]')?.id || el.getAttribute("data-mid") || el.id;
      if (id) byId.set(id, el);
    }
    // Teams charge les images au fil de l'eau : celles du fil encore en cours de chargement
    // ont un court délai, toutes ensemble, avant la capture.
    const pending = messages
      .filter((m) => m.images)
      .flatMap((m) => imagesOf(byId.get(m.key) || document.createElement("div")))
      .filter((img) => !loaded(img));
    if (pending.length)
      await Promise.race([Promise.all(pending.map((img) => (img.decode ? img.decode() : Promise.resolve()).catch(() => {}))), sleep(2500)]);
    let count = 0;
    let weight = 0;
    for (const m of [...messages].reverse()) {
      const n = m.images;
      const imgs = n ? imagesOf(byId.get(m.key) || document.createElement("div")) : [];
      const out = [];
      for (let i = 0; i < n; i++) {
        const shot = count < THUMBS.max && weight < THUMBS.budget && imgs[i] ? await thumbnail(imgs[i]) : null;
        if (shot) {
          count++;
          weight += shot.data.length;
        }
        out.push(shot || { data: null, width: 0, height: 0 });
      }
      m.images = out;
    }
  };

  // --- Lecture d'un fil par le service de chat (sans ouvrir la conversation) ---
  // Rend exactement la forme de l'op `read` (expéditeur, texte, heure telle que Teams
  // l'affiche, id, réactions, fichiers, images, liens, cartes) : le moteur garde une seule
  // conversion. Le corps HTML d'un message passe par les mêmes extracteurs que la page.
  // Conversion d'un message du service de chat vers la forme de l'op `read`. N'utilise que
  // nodeType / tagName / childNodes / getAttribute sur le corps HTML (parsé par l'appelant) :
  // ui/tests/chatMessage.test.ts l'exécute tel quel avec messageParts.
  // >>> chat-message
  const chatMessage = (() => {
    // Messages écrits par quelqu'un ; les événements (ajout de membre, appel…) sont ignorés.
    const USER_TYPES = /^(Text|RichText(\/Html|\/Media_Card|\/Media_GenericFile|\/UriObject)?)$/i;
    const EMOTIONS = { like: "like", heart: "heart", laugh: "laugh", surprised: "surprised" };
    const parseJson = (v) => {
      if (Array.isArray(v) || (v && typeof v === "object")) return v;
      try {
        return v ? JSON.parse(v) : null;
      } catch {
        return null;
      }
    };
    const pad = (n) => String(n).padStart(2, "0");
    const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
    // L'heure comme Teams l'affiche dans le fil : « 14:32 », « Hier 09:10 », « mardi 10:36 »
    // (cette semaine), « 25/11 16:05 ».
    const shown = (ts, now = new Date()) => {
      if (!Number.isFinite(ts)) return "";
      const d = new Date(ts);
      const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
      const diff = Math.round((day(now) - day(d)) / 86400000);
      if (diff === 0) return hm;
      if (diff === 1) return `Hier ${hm}`;
      if (diff > 1 && diff < 7) return `${DAYS[d.getDay()]} ${hm}`;
      const dm = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
      return d.getFullYear() === now.getFullYear() ? `${dm} ${hm}` : `${dm}/${d.getFullYear()} ${hm}`;
    };
    const attr = (el, k) => (el && el.getAttribute && el.getAttribute(k)) || "";
    const all = (el, test, out = []) => {
      for (const c of (el && el.childNodes) || []) {
        if (c.nodeType !== 1) continue;
        if (test(c)) out.push(c);
        all(c, test, out);
      }
      return out;
    };
    // Images collées dans le corps : servies par le stockage de Teams (AMS).
    // Un GIF animé choisi dans Teams (Giphy) n'est qu'une <img> vers le CDN de Giphy : sans
    // lui, un message fait d'un seul GIF n'aurait rien et disparaîtrait du fil.
    const GIF = /^https:\/\/([a-z0-9-]+\.)*giphy\.com\//i;
    const bodyImages = (root) =>
      all(root, (el) => String(el.tagName || "").toUpperCase() === "IMG" && (/AMSImage/i.test(attr(el, "itemtype")) || GIF.test(attr(el, "src")))).map((el) =>
        attr(el, "src")
      );
    const VIDEO_FILE = /^(mp4|m4v|mov|webm|wmv|avi|mkv)$/i;
    const filesFrom = (props) =>
      (parseJson(props && props.files) || [])
        .map((f) => {
          const name = String((f && (f.fileName || f.title)) || "").trim();
          const url = String((f && (f.objectUrl || (f.fileInfo && f.fileInfo.shareUrl))) || "");
          const type = String((f && f.fileType) || name.split(".").pop() || "");
          return VIDEO_FILE.test(type) ? { name, url, kind: "video" } : { name, url };
        })
        .filter((f) => f.name);
    const cardsFrom = (props) =>
      (parseJson(props && props.links) || [])
        .map((l) => {
          const url = String((l && l.url) || "");
          const p = (l && l.previewenabled !== false && l.preview) || {};
          let source = "";
          try {
            source = url ? new URL(url).hostname.replace(/^www\./, "") : "";
          } catch {}
          return { source, title: String(p.title || "").slice(0, 200), url, fields: [] };
        })
        .filter((c) => c.title && c.url)
        .slice(0, 5);
    const mineIn = (props, me) => {
      if (!me) return [];
      const out = new Set();
      for (const e of parseJson(props && props.emotions) || []) {
        const key = EMOTIONS[e && e.key];
        if (key && ((e && e.users) || []).some((u) => u && u.mri === me)) out.add(key);
      }
      return Array.from(out);
    };
    const isUser = (raw) => USER_TYPES.test(String((raw && raw.messagetype) || ""));
    // Analyse du corps HTML d'un message SANS le DOM de la page : Teams impose les Trusted
    // Types (DOMParser / innerHTML refusés sans TrustedHTML), et un arbre inerte ne charge ni
    // image ni script. Donne juste ce que lisent messageParts et bodyImages : nodeType, tagName,
    // childNodes, getAttribute.
    const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
    const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
    const decode = (s) =>
      s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
        if (e[0] === "#") {
          const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
      });
    const element = (tagName, attributes) => ({
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      attributes,
      childNodes: [],
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
      },
    });
    const parseHtml = (html) => {
      const root = element("div", {});
      const stack = [root];
      const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)|</g;
      for (const m of String(html || "").replace(/\r\n?/g, "\n").matchAll(re)) {
        const top = stack[stack.length - 1];
        if (m[1]) {
          const at = stack.map((e) => e.tagName).lastIndexOf(m[1].toUpperCase());
          if (at > 0) stack.length = at;
        } else if (m[2]) {
          const attrs = {};
          for (const a of (m[3] || "").matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
            attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
          const el = element(m[2], attrs);
          top.childNodes.push(el);
          if (!m[4] && !VOID.has(m[2].toLowerCase()) && stack.length < 64) stack.push(el);
        } else if (m[5] || m[0] === "<") {
          top.childNodes.push({ nodeType: 3, data: decode(m[5] || "<") });
        }
      }
      return root;
    };
    // Citation (« Répondre ») : le HTML ne porte l'heure du message cité que dans l'itemid d'un
    // <span itemprop="time"> vide ; la page l'affiche sur sa ligne (« 05/11/2026 14:02 »).
    const quoteTimes = (root) => {
      for (const el of all(root, (x) => attr(x, "itemprop") === "time" && /^\d{10,16}$/.test(attr(x, "itemid")))) {
        const d = new Date(Number(attr(el, "itemid")));
        if (Number.isNaN(d.getTime())) continue;
        el.tagName = "DIV";
        el.childNodes = [{ nodeType: 3, data: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}` }];
      }
      return root;
    };
    // raw : message du service de chat ; me : mri de l'utilisateur ; parse(html) → élément racine.
    const convert = (raw, me, parse, parts, now) => {
      const props = raw.properties || {};
      const ts = Date.parse(raw.originalarrivaltime || raw.composetime || "");
      const deleted = Boolean(props.deletetime);
      const root = deleted ? null : quoteTimes(parse(String(raw.content || "")));
      const p = root ? parts(root) : { text: "", links: [], cards: [], quote: null, mentions: [] };
      return {
        sender: String(raw.imdisplayname || "").trim(),
        text: deleted ? "Ce message a été supprimé." : String(p.text || "").replace(/\s+\n/g, "\n").trim(),
        at: shown(ts, now),
        id: String(raw.id || ""),
        status: null,
        reactions: deleted ? [] : mineIn(props, me),
        files: deleted ? [] : filesFrom(props),
        images: root ? bodyImages(root) : [],
        links: deleted ? [] : p.links || [],
        cards: deleted ? [] : [...(p.cards || []), ...cardsFrom(props)].slice(0, 5),
        quote: deleted ? null : p.quote || null,
        mentions: deleted ? [] : p.mentions || [],
        // Modifié par son auteur : Teams affiche « Modifié » à côté de l'heure.
        edited: !deleted && Boolean(props.edittime || raw.skypeeditedid),
        ts: Number.isFinite(ts) ? ts : null,
      };
    };
    return { convert, isUser, shown, parseHtml };
  })();
  // <<< chat-message

  const chatThread = (() => {
    const PAGE = 50;
    const MAX_PAGES = 12;
    const convert = (raw, me) => chatMessage.convert(raw, me, chatMessage.parseHtml, messageParts);
    // Miniatures des images, les plus récentes d'abord, dans les mêmes limites que la page.
    const pictures = async (messages) => {
      let count = 0;
      let weight = 0;
      for (const m of [...messages].reverse()) {
        const out = [];
        for (const src of m.images) {
          let shot = null;
          if (count < THUMBS.max && weight < THUMBS.budget) {
            try {
              const blob = await chatsvc.image(src);
              if (blob) {
                const bitmap = await createImageBitmap(blob);
                const scale = Math.min(1, THUMBS.width / bitmap.width);
                const canvas = document.createElement("canvas");
                canvas.width = Math.round(bitmap.width * scale);
                canvas.height = Math.round(bitmap.height * scale);
                canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                shot = { data: canvas.toDataURL("image/jpeg", 0.8), width: canvas.width, height: canvas.height };
              }
            } catch {}
          }
          if (shot) {
            count++;
            weight += shot.data.length;
          }
          out.push(shot || { data: null, width: 0, height: 0 });
        }
        m.images = out;
      }
    };
    // Les `last` derniers messages (au plus), ou ceux plus récents que `since` (epoch ms).
    // `top` : le début de la conversation est atteint (plus rien d'ancien à lire).
    return async ({ thread, last = 30, since = null }) => {
      const path = "/v1/users/ME/conversations/" + encodeURIComponent(String(thread || "")) + "/messages";
      let query = { view: "msnp24Equivalent", pageSize: PAGE };
      const acc = new Map();
      let top = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await chatsvc.get({ path, query });
        if (!r.ok) return { ok: false, stage: r.stage, status: r.status || 0, error: r.error || "lecture refusée par le service de chat" };
        const me = chatsvc.me();
        const list = (r.json && r.json.messages) || [];
        let oldest = Infinity;
        for (const raw of list) {
          if (!raw || !raw.id) continue;
          const t = Date.parse(raw.originalarrivaltime || raw.composetime || "");
          if (Number.isFinite(t)) oldest = Math.min(oldest, t);
          if (!chatMessage.isUser(raw)) continue;
          if (!acc.has(raw.id)) acc.set(raw.id, convert(raw, me));
        }
        const back = r.json && r.json._metadata && r.json._metadata.backwardLink;
        if (!list.length || !back) {
          top = true;
          break;
        }
        const kept = Array.from(acc.values()).filter((m) => m.text || m.files.length || m.images.length || m.cards.length);
        if (since != null ? oldest < since : kept.length >= last) break;
        // Page précédente : seuls les paramètres permis du lien de Teams sont repris.
        try {
          const q = new URL(back).searchParams;
          query = {};
          for (const k of ["view", "pageSize", "startTime", "syncState"]) if (q.get(k)) query[k] = q.get(k);
        } catch {
          break;
        }
      }
      const ordered = Array.from(acc.values())
        .filter((m) => m.text || m.files.length || m.images.length || m.cards.length)
        .filter((m) => since == null || m.ts == null || m.ts >= since)
        .sort((a, b) => (a.ts || 0) - (b.ts || 0) || Number(a.id) - Number(b.id));
      const shownMsgs = ordered.slice(-last);
      await pictures(shownMsgs);
      return { ok: true, messages: shownMsgs.map(({ ts, ...m }) => m), top: top && shownMsgs.length === ordered.length };
    };
  })();

  // --- Liste des conversations par le service de chat ---
  // Une ligne compacte par conversation : id Teams, sorte, sujet, dernier message (converti
  // comme un message du fil), horizon de lecture. Première lecture complète (quelques pages),
  // ensuite seulement ce qui a changé (`sync`, le syncState rendu au tour précédent).
  const chatList = (() => {
    const FULL_PAGES = 3;
    const mriOf = (from) => {
      const m = /\/contacts\/([^/?#]+)$/.exec(String(from || ""));
      return m ? decodeURIComponent(m[1]) : String(from || "").startsWith("8:") ? String(from) : "";
    };
    const kindOf = (id, tp) =>
      id === "48:notes" ? "self"
      : /@unq\.gbl\.spaces$/.test(id) ? "dm"
      : /@thread\.(v2|skype)$/.test(id) ? (/meeting/i.test(String((tp && tp.productThreadType) || "")) || (tp && tp.meeting) ? "meeting" : "group")
      : "other";
    // L'autre personne d'un tête-à-tête : « 19:<guid A>_<guid B>@unq.gbl.spaces ».
    const otherOf = (id, me) => {
      const m = /^19:([0-9a-f-]{36})_([0-9a-f-]{36})@unq\.gbl\.spaces$/i.exec(id);
      if (!m) return "";
      const mine = String(me || "").split(":").pop().toLowerCase();
      const g = m[1].toLowerCase() === mine ? m[2] : m[1];
      return `8:orgid:${g}`;
    };
    const syncOf = (meta) => {
      try {
        return (meta && meta.syncState && new URL(meta.syncState).searchParams.get("syncState")) || "";
      } catch {
        return "";
      }
    };
    const row = (c, me) => {
      const tp = c.threadProperties || {};
      const props = c.properties || {};
      const last = c.lastMessage || {};
      const lastTs = Date.parse(last.originalarrivaltime || last.composetime || "");
      const conv = last.id ? chatMessage.convert(last, me, chatMessage.parseHtml, messageParts) : null;
      return {
        id: String(c.id || ""),
        kind: kindOf(String(c.id || ""), tp),
        topic: String(tp.topic || "").trim(),
        hidden: String(tp.hidden || props.hidden || "") === "true",
        empty: String(props.isemptyconversation || "").toLowerCase() === "true",
        other: otherOf(String(c.id || ""), me),
        horizon: Number(String(props.consumptionhorizon || "").split(";")[0]) || 0,
        last: last.id
          ? {
              id: String(last.id),
              ts: Number.isFinite(lastTs) ? lastTs : 0,
              from: mriOf(last.from),
              sender: String(last.imdisplayname || "").trim(),
              user: chatMessage.isUser(last),
              text: conv ? conv.text : "",
              files: conv ? conv.files.length : 0,
              images: conv ? conv.images.length : 0,
              at: conv ? conv.at : "",
            }
          : null,
      };
    };
    return async ({ sync = "" } = {}) => {
      const path = "/v1/users/ME/conversations";
      let query = sync ? { view: "msnp24Equivalent", syncState: sync } : { view: "msnp24Equivalent", pageSize: 100 };
      const rows = [];
      let next = "";
      for (let page = 0; page < (sync ? 1 : FULL_PAGES); page++) {
        const r = await chatsvc.get({ path, query });
        if (!r.ok) return { ok: false, stage: r.stage, status: r.status || 0, error: r.error || "liste refusée par le service de chat" };
        const me = chatsvc.me();
        for (const c of (r.json && r.json.conversations) || []) if (c && c.id) rows.push(row(c, me));
        const meta = (r.json && r.json._metadata) || {};
        if (page === 0) next = syncOf(meta);
        const back = meta.backwardLink;
        if (sync || !back) break;
        try {
          const q = new URL(back).searchParams;
          query = { view: "msnp24Equivalent" };
          for (const k of ["pageSize", "startTime", "syncState"]) if (q.get(k)) query[k] = q.get(k);
        } catch {
          break;
        }
      }
      const people = await chatsvc.people(rows.filter((r) => r.kind === "dm" && r.other).map((r) => r.other));
      for (const r of rows) r.name = r.kind === "dm" ? people[r.other] || "" : r.topic;
      return { ok: true, me: chatsvc.me(), rows, sync: next, full: !sync };
    };
  })();

  // --- Gestes sur le service de chat : lu, réaction, suppression, envoi ---
  // Chaque geste vérifie AVANT d'écrire qu'il vise bien ce que l'utilisateur a vu (message
  // retrouvé par son id, même auteur, même début de texte ; pour supprimer : un de SES
  // messages), puis le PROUVE en relisant le service. Réponse : { ok } prouvé ; { attempted:
  // false } rien n'est parti (la page peut faire le geste) ; { uncertain: true } parti sans
  // preuve (jamais refait automatiquement).
  const chatGestures = (() => {
    const enc = (c) => encodeURIComponent(c);
    const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[…\s]+/g, " ").trim();
    const convertOf = (raw) => chatMessage.convert(raw, chatsvc.me(), chatMessage.parseHtml, messageParts);
    const getConv = async (c) => chatsvc.get({ path: `/v1/users/ME/conversations/${enc(c)}` });
    const getMsg = async (c, mid) => chatsvc.get({ path: `/v1/users/ME/conversations/${enc(c)}/messages/${mid}` });
    const mriOf = (from) => {
      const m = /\/contacts\/([^/?#]+)$/.exec(String(from || ""));
      return m ? decodeURIComponent(m[1]) : String(from || "");
    };
    const notSent = (error, extra = {}) => ({ ok: false, attempted: false, error, ...extra });
    const uncertain = (error) => ({ ok: false, attempted: true, uncertain: true, error });
    const proven = async (check, tries = [0, 700, 1500]) => {
      for (const wait of tries) {
        if (wait) await sleep(wait);
        try {
          const v = await check();
          if (v) return v;
        } catch {}
      }
      return null;
    };
    // Le message visé est-il celui que l'utilisateur a vu ? Même id, même auteur, même début.
    const target = async (c, ref) => {
      const mid = String((ref && ref.id) || "");
      if (!/^\d{1,20}$/.test(mid)) return { error: "message sans identifiant Teams" };
      const r = await getMsg(c, mid);
      if (!r.ok || !r.json) return { error: r.error || "message introuvable sur le service de chat" };
      const raw = r.json;
      const seen = convertOf(raw);
      const want = fold(ref.text).slice(0, 40);
      if (ref.sender && fold(ref.sender) !== fold(raw.imdisplayname)) return { error: "auteur différent de celui affiché" };
      if (want && !fold(seen.text).startsWith(want)) return { error: "texte différent de celui affiché" };
      return { mid, raw, seen };
    };
    const markread = async ({ thread }) => {
      const r = await getConv(thread);
      if (!r.ok || !r.json) return notSent(r.error || "conversation introuvable sur le service de chat");
      const last = r.json.lastMessage || {};
      const arrived = Date.parse(last.originalarrivaltime || "");
      if (!last.id || !Number.isFinite(arrived)) return { ok: true, already: true };
      const current = Number(String((r.json.properties || {}).consumptionhorizon || "").split(";")[0]) || 0;
      if (current >= arrived) return { ok: true, already: true };
      const w = await chatsvc.write("markread", thread, null, { consumptionhorizon: `${arrived};${Date.now()};${last.clientmessageid || last.id}` });
      if (!w.sent) return notSent(w.error);
      if (!w.ok && !w.unknown) return { ok: false, attempted: true, error: `marquer comme lu refusé (HTTP ${w.status})` };
      const ok = await proven(async () => {
        const v = await getConv(thread);
        return v.ok && Number(String((v.json.properties || {}).consumptionhorizon || "").split(";")[0]) >= arrived;
      });
      return ok ? { ok: true } : uncertain("lu non confirmé par le service de chat");
    };
    // Pose la réaction, ou la retire (remove) : jamais une bascule, l'état voulu est explicite.
    const react = async ({ thread, message, reaction, remove }) => {
      if (!["like", "heart", "laugh", "surprised"].includes(reaction)) return notSent("réaction inconnue");
      const off = remove === true;
      const t = await target(thread, message);
      if (t.error) return notSent(t.error);
      if (t.seen.reactions.includes(reaction) !== off) return { ok: true, already: true }; // déjà dans l'état voulu
      const w = off
        ? await chatsvc.write("unreact", thread, t.mid, { emotions: { key: reaction } })
        : await chatsvc.write("react", thread, t.mid, { emotions: { key: reaction, value: Date.now() } });
      if (!w.sent) return notSent(w.error);
      if (!w.ok && !w.unknown) return { ok: false, attempted: true, error: `réaction ${off ? "non retirée" : "refusée"} (HTTP ${w.status})` };
      const ok = await proven(async () => {
        const v = await getMsg(thread, t.mid);
        return v.ok && convertOf(v.json).reactions.includes(reaction) !== off;
      });
      return ok ? { ok: true } : uncertain(off ? "retrait de la réaction non confirmé par le service de chat" : "réaction non confirmée par le service de chat");
    };
    const remove = async ({ thread, message }) => {
      const t = await target(thread, message);
      if (t.error) return notSent(`${t.error} : rien n'a été supprimé`);
      const me = await chatsvc.whoami();
      if (!me || mriOf(t.raw.from) !== me) return notSent("ce message n'est pas à toi : rien n'a été supprimé");
      if ((t.raw.properties || {}).deletetime) return notSent("message déjà supprimé");
      const w = await chatsvc.write("delete", thread, t.mid, null);
      if (!w.sent) return notSent(w.error);
      if (!w.ok && !w.unknown) return { ok: false, attempted: true, error: `suppression refusée (HTTP ${w.status})` };
      const ok = await proven(async () => {
        const v = await getMsg(thread, t.mid);
        return v.ok && Boolean((v.json.properties || {}).deletetime);
      });
      return ok ? { ok: true } : uncertain("suppression non confirmée par le service de chat");
    };
    // Texte brut → HTML du composeur de Teams : un paragraphe par ligne, liens cliquables.
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const linkify = (s) => s.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}" title="${u}" target="_blank" rel="noreferrer noopener">${u}</a>`);
    const toHtml = (text) =>
      String(text)
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => `<p>${line.trim() ? linkify(esc(line)) : "&nbsp;"}</p>`)
        .join("");
    const clientId = () => {
      const a = new Uint32Array(3);
      crypto.getRandomValues(a);
      return (String(a[0]) + String(a[1]) + String(a[2])).replace(/^0+/, "1").padEnd(19, "7").slice(0, 19);
    };
    // Citation d'une réponse (« Répondre »), écrite comme le composeur de Teams : le message cité
    // par son id, son auteur (mri et nom), son heure (ms) et un extrait.
    const PREVIEW_MAX = 200;
    const quoteHtml = (t) => {
      const raw = t.raw;
      const at = Date.parse(raw.originalarrivaltime || raw.composetime || "") || Number(t.mid);
      const preview = String(t.seen.text || "").replace(/\s+/g, " ").trim();
      const cut = preview.length > PREVIEW_MAX ? preview.slice(0, PREVIEW_MAX - 1).trimEnd() + "…" : preview;
      return (
        `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="${esc(t.mid)}">` +
        `<strong itemprop="mri" itemid="${esc(mriOf(raw.from))}">${esc(String(raw.imdisplayname || ""))}</strong>` +
        `<span itemprop="time" itemid="${at}"></span>` +
        `<p itemprop="preview">${esc(cut)}</p></blockquote>`
      );
    };
    // Mentions (@Nom) : chaque nom doit être celui d'UNE personne de la conversation, l'autre
    // personne d'un tête-à-tête ou un auteur récent du fil (jamais une recherche dans
    // l'annuaire : on ne mentionne que quelqu'un qui est là). Sinon rien ne part, la page mentionne.
    const MENTION = "http://schema.skype.com/Mention";
    const membersOf = async (thread) => {
      const me = await chatsvc.whoami();
      const byName = new Map(); // nom replié -> Set(mri)
      const add = (name, mri) => {
        const k = fold(name);
        if (!k || !mri || mri === me) return;
        if (!byName.has(k)) byName.set(k, new Set());
        byName.get(k).add(mri);
      };
      const one = /^19:([0-9a-f-]{36})_([0-9a-f-]{36})@unq\.gbl\.spaces$/i.exec(thread);
      if (one) {
        const mine = String(me || "").split(":").pop().toLowerCase();
        const other = `8:orgid:${one[1].toLowerCase() === mine ? one[2] : one[1]}`;
        const names = await chatsvc.people([other]);
        if (names[other]) add(names[other], other);
      }
      const r = await chatsvc.get({ path: `/v1/users/ME/conversations/${enc(thread)}/messages`, query: { view: "msnp24Equivalent", pageSize: 200 } });
      for (const m of (r.ok && r.json && r.json.messages) || [])
        if (m && chatMessage.isUser(m)) add(String(m.imdisplayname || ""), mriOf(m.from));
      return byName;
    };
    const resolveMentions = async (thread, names) => {
      const members = await membersOf(thread);
      const out = [];
      for (const n of names) {
        const name = String(n || "").replace(/\s+/g, " ").trim();
        const mris = members.get(fold(name));
        if (!name || !mris) return { error: `« ${name} » n'est pas dans cette conversation` };
        if (mris.size > 1) return { error: `plusieurs « ${name} » dans cette conversation` };
        out.push({ name, mri: [...mris][0] });
      }
      return { people: out };
    };
    // Texte avec « @Nom » → HTML du composeur : un élément de mention par mot du nom, chacun
    // avec son itemid, et la liste `properties.mentions` qui relie chaque itemid à la personne.
    const withMentions = (text, people) => {
      const list = [];
      const line = (s) => {
        let html = "";
        let rest = s;
        while (rest) {
          let best = null;
          for (const p of people) {
            const i = rest.toLowerCase().indexOf("@" + p.name.toLowerCase());
            if (i >= 0 && (!best || i < best.i)) best = { i, p };
          }
          if (!best) {
            html += linkify(esc(rest));
            break;
          }
          html += linkify(esc(rest.slice(0, best.i)));
          html += best.p.name
            .split(" ")
            .map((word) => {
              const itemid = list.length;
              list.push({ "@type": MENTION, itemid, mri: best.p.mri, mentionType: "person", displayName: word });
              return `<span itemscope itemtype="${MENTION}" itemid="${itemid}">${esc(word)}</span>`;
            })
            .join(" ");
          rest = rest.slice(best.i + 1 + best.p.name.length);
        }
        return html;
      };
      const html = String(text)
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((l) => `<p>${l.trim() ? line(l) : "&nbsp;"}</p>`)
        .join("");
      return { html, list };
    };
    const send = async ({ thread, text, reply, mentions }) => {
      const body = String(text || "").trim();
      if (!body) return notSent("message vide");
      if (body.length > 28000) return notSent("message trop long");
      const wanted = Array.isArray(mentions) ? mentions.slice(0, 20) : [];
      let content = null;
      let mentioned = [];
      if (wanted.length) {
        const m = await resolveMentions(thread, wanted);
        if (m.error) return notSent(`${m.error} : rien n'a été envoyé`);
        const w = withMentions(body, m.people);
        if (w.list.length === 0) return notSent("aucune mention « @Nom » dans le texte : rien n'a été envoyé");
        content = w.html;
        mentioned = w.list;
      }
      // Réponse citée : le message cité doit être celui que l'utilisateur a vu (id, auteur, texte).
      let quote = "";
      if (reply) {
        const t = await target(thread, reply);
        if (t.error) return notSent(`${t.error} : rien n'a été envoyé`);
        if ((t.raw.properties || {}).deletetime) return notSent("message cité supprimé : rien n'a été envoyé");
        quote = quoteHtml(t);
      }
      const me = await chatsvc.whoami();
      const names = me ? await chatsvc.people([me]) : {};
      const cid = clientId();
      const w = await chatsvc.write("send", thread, null, {
        content: quote + (content || toHtml(body)),
        messagetype: "RichText/Html",
        contenttype: "text",
        amsreferences: [],
        clientmessageid: cid,
        imdisplayname: names[me] || "",
        properties: { importance: "", subject: "", ...(mentioned.length ? { mentions: JSON.stringify(mentioned) } : {}) },
      });
      if (!w.sent) return notSent(w.error);
      // Preuve : le message relu sur le service, retrouvé par son clientmessageid.
      const found = await proven(async () => {
        const v = await chatsvc.get({ path: `/v1/users/ME/conversations/${enc(thread)}/messages`, query: { view: "msnp24Equivalent", pageSize: 20 } });
        const hit = v.ok && ((v.json && v.json.messages) || []).find((m) => m && m.clientmessageid === cid);
        // Une réponse n'est prouvée qu'avec sa citation relue.
        if (hit && quote && !convertOf(hit).quote) return null;
        // Des mentions : prouvées quand chaque nom se relit mentionné.
        if (hit && wanted.length) {
          const got = convertOf(hit).mentions.map(fold);
          if (!wanted.every((n) => got.includes(fold(n)))) return null;
        }
        return hit ? { id: String(hit.id) } : null;
      }, w.ok ? [0, 700, 1500, 3000] : [0, 1500]);
      if (found) return { ok: true, id: found.id };
      // Refusé net par le service et absent à la relecture : rien n'est parti.
      if (!w.ok && !w.unknown && w.status >= 400 && w.status < 500) return notSent(`envoi refusé par le service de chat (HTTP ${w.status})`);
      return uncertain("envoi non confirmé : vérifie dans Teams avant de renvoyer");
    };
    // Modifier un de SES messages, en texte simple seulement : réécrire en texte brut un
    // message cité, avec mention, pièce jointe ou carte les perdrait. Ce refus est définitif
    // (attempted : la page ne ferait pas mieux). Prouvé quand la relecture montre le nouveau
    // texte, marqué « Modifié ».
    const refused = (error) => ({ ok: false, attempted: true, refused: true, error });
    const edit = async ({ thread, message, text }) => {
      const body = String(text || "").trim();
      if (!body) return refused("message vide : rien n'a été modifié");
      if (body.length > 28000) return refused("message trop long : rien n'a été modifié");
      const t = await target(thread, message);
      if (t.error) return notSent(`${t.error} : rien n'a été modifié`);
      const me = await chatsvc.whoami();
      if (!me || mriOf(t.raw.from) !== me) return notSent("ce message n'est pas à toi : rien n'a été modifié");
      if ((t.raw.properties || {}).deletetime) return refused("message supprimé : rien n'a été modifié");
      const s = t.seen;
      if (s.quote || s.mentions.length || s.files.length || s.images.length || s.cards.length)
        return refused("message avec citation, mention, pièce jointe ou aperçu : modifie-le dans Teams");
      const want = fold(body);
      if (fold(s.text) === want) return { ok: true, already: true };
      const w = await chatsvc.write("edit", thread, t.mid, {
        content: toHtml(body),
        messagetype: "RichText/Html",
        contenttype: "text",
        amsreferences: [],
        imdisplayname: String(t.raw.imdisplayname || ""),
        properties: { importance: "", subject: "" },
      });
      if (!w.sent) return notSent(w.error);
      if (!w.ok && !w.unknown) return { ok: false, attempted: true, error: `modification refusée (HTTP ${w.status})` };
      const ok = await proven(async () => {
        const v = await getMsg(thread, t.mid);
        if (!v.ok) return false;
        const after = convertOf(v.json);
        return after.edited && fold(after.text) === want;
      });
      return ok ? { ok: true } : uncertain("modification non confirmée par le service de chat");
    };
    const run = { markread, react, delete: remove, send, edit };
    return async (args) => {
      const kind = String((args && args.kind) || "");
      if (!run[kind]) return notSent("geste inconnu");
      if (!/^(19:[A-Za-z0-9_.:=-]{1,200}@(thread\.(v2|skype|tacv2)|unq\.gbl\.spaces)|48:notes)$/.test(String(args.thread || "")))
        return notSent("conversation sans identifiant Teams");
      try {
        return await run[kind](args);
      } catch (err) {
        return uncertain(String((err && err.message) || err));
      }
    };
  })();

  // --- Tête-à-tête avec quelqu'un, trouvé ou créé sur le service de chat ---
  // L'id d'un tête-à-tête se calcule comme Teams le fait : « 19:{guid A}_{guid B}@unq.gbl.spaces »,
  // les deux guids triés. S'il existe : rien n'est écrit. Sinon, il est créé comme le fait Teams
  // (POST /v1/threads, « uniquerosterthread » : un seul fil par paire, jamais de doublon), puis
  // relu. Aucun message n'est envoyé.
  const chatDm = (() => {
    const GUID = /^8:orgid:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
    const enc = (c) => encodeURIComponent(c);
    return async ({ mri } = {}) => {
      const other = GUID.exec(String(mri || ""));
      const me = await chatsvc.whoami();
      const mine = GUID.exec(String(me || ""));
      if (!other) return { ok: false, attempted: false, error: "identifiant Teams de la personne inattendu" };
      if (!mine) return { ok: false, attempted: false, error: "identifiant Teams de l'utilisateur inconnu" };
      if (other[1].toLowerCase() === mine[1].toLowerCase()) return { ok: false, attempted: false, error: "c'est toi" };
      const [a, b] = [mine[1].toLowerCase(), other[1].toLowerCase()].sort();
      const id = `19:${a}_${b}@unq.gbl.spaces`;
      const exists = async () => {
        const r = await chatsvc.get({ path: `/v1/users/ME/conversations/${enc(id)}`, query: { view: "msnp24Equivalent" } });
        return r.ok && r.json && String(r.json.id || id) === id;
      };
      if (await exists()) return { ok: true, id, created: false };
      const w = await chatsvc.write("thread", id, null, {
        members: [{ id: `8:orgid:${mine[1]}`, role: "Admin" }, { id: `8:orgid:${other[1]}`, role: "Admin" }],
        properties: { threadType: "chat", chatFilesIndexId: "2", fixedRoster: true, uniquerosterthread: true },
      });
      if (!w.sent) return { ok: false, attempted: false, error: w.error };
      for (const wait of [0, 700, 1500, 3000]) {
        if (wait) await sleep(wait);
        if (await exists()) return { ok: true, id, created: true };
      }
      // Pas relu : la page ouvre la conversation, comme avant (le fil est unique par paire :
      // une ouverture par la page ne crée jamais de doublon).
      return { ok: false, attempted: false, error: w.ok ? "tête-à-tête créé mais pas encore relu" : `création refusée (HTTP ${w.status || "?"})` };
    };
  })();
  // --- Sonde des conversations de réunion (découverte, lecture seule) ---
  // Pour câbler les réunions sur le service de chat, il faut savoir quel message porte la carte
  // « La réunion est terminée » de la page. La sonde ne rend que de la STRUCTURE : id et type de
  // chaque message, nom de la balise racine et des balises de son contenu, noms (jamais valeurs)
  // de ses propriétés ; et les ids (data-mid) des cartes de récapitulatif affichées. Aucun texte.
  const meetingShapes = async ({ chats = 3, per = 60 } = {}) => {
    const enc = (c) => encodeURIComponent(c);
    const list = await chatsvc.get({ path: "/v1/users/ME/conversations", query: { view: "msnp24Equivalent", pageSize: 100 } });
    if (!list.ok) return { ok: false, error: list.error || "liste refusée par le service de chat" };
    const isMeeting = (c) => {
      const tp = (c && c.threadProperties) || {};
      return /@thread\.(v2|skype)$/.test(String(c.id || "")) && (/meeting/i.test(String(tp.productThreadType || "")) || Boolean(tp.meeting));
    };
    const tagsOf = (html) => {
      const names = [];
      const re = /<([A-Za-z][A-Za-z0-9:_-]{0,40})\b/g;
      let m;
      while ((m = re.exec(String(html || ""))) && names.length < 400) names.push(m[1].toLowerCase());
      return { root: names[0] || "", tags: [...new Set(names)].slice(0, 25) };
    };
    const out = [];
    const convs = ((list.json && list.json.conversations) || []).filter(isMeeting).slice(0, Math.max(1, Math.min(5, Number(chats) || 3)));
    for (const c of convs) {
      const r = await chatsvc.get({ path: `/v1/users/ME/conversations/${enc(c.id)}/messages`, query: { view: "msnp24Equivalent", pageSize: Math.max(10, Math.min(200, Number(per) || 60)) } });
      const msgs = ((r.ok && r.json && r.json.messages) || []).map((m) => ({
        id: String(m.id || ""),
        type: String(m.messagetype || ""),
        ...tagsOf(m.content),
        props: Object.keys(m.properties || {}).slice(0, 25),
      }));
      const tp = c.threadProperties || {};
      out.push({ chat: String(c.id), threadKeys: Object.keys(tp).slice(0, 40), meetingKeys: (() => { try { return Object.keys(JSON.parse(tp.meeting || "{}")).slice(0, 40); } catch { return []; } })(), messages: msgs });
    }
    const shown = Array.from(document.querySelectorAll(RECAP_CARD)).map((card) => card.closest("[data-mid]")?.getAttribute("data-mid") || "");
    return { ok: true, chats: out, page_recap_mids: shown.filter(Boolean).slice(0, 20), page_title_is_meeting: /meeting|réunion/i.test(document.title) };
  };

  // --- Présence, note de statut et recherche de personnes (middletier) ---
  // Le service de présence et la recherche de personnes acceptent le bearer middletier que
  // Teams pose lui-même (vérifié en direct). Requêtes fixes ici ; le moteur ne donne que des
  // valeurs (identifiants, texte de la note, requête) et ne reçoit que des données métier.
  const teamsPeople = (() => {
    const PRESENCE = "https://presence.teams.microsoft.com/v1";
    const MRI = /^8:[A-Za-z0-9:._-]{3,120}$/;
    const call = async (method, url, body) => {
      const bearer = apiCapture.mtBearer();
      if (!bearer) return { ok: false, sent: false, error: "aucun jeton Teams observé pour l'instant" };
      try {
        const res = await fetch(url, {
          method,
          credentials: "omit",
          headers: { Authorization: bearer, "Content-Type": "application/json", Accept: "application/json" },
          body: body == null ? undefined : JSON.stringify(body),
        });
        let json = null;
        try {
          const t = await res.text();
          json = t ? JSON.parse(t) : null;
        } catch {}
        return { ok: res.ok, sent: true, status: res.status, json };
      } catch (err) {
        return { ok: false, sent: method === "GET" ? false : true, unknown: method !== "GET", error: String((err && err.message) || err) };
      }
    };
    // La note est stockée en HTML (« <p>…</p><p>&nbsp;</p> ») : lue en texte, comme la page
    // l'affiche, avec le même extracteur que les messages ; écrite en un paragraphe, comme Teams.
    const noteText = (html) => {
      try {
        return String(messageParts(chatMessage.parseHtml(String(html || ""))).text || "").replace(/\s+/g, " ").trim();
      } catch {
        return "";
      }
    };
    const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    // Valeurs du service de présence, telles quelles (le moteur les traduit).
    const fields = (p) => {
      p = p || {};
      const note = p.note || {};
      const forced = p.forcedAvailability || {};
      return {
        availability: String(p.availability || ""),
        activity: String(p.activity || ""),
        ooo: Boolean(p.calendarData && p.calendarData.isOutOfOffice),
        note: { message: noteText(note.message), expiry: String(note.expiry || "") },
        // Statut choisi par l'utilisateur (« forcé ») et son échéance ; vide : Teams décide.
        forced: { availability: String(forced.availability || ""), expiry: String(forced.expiry || "") },
      };
    };
    const me = async () => {
      const r = await call("GET", `${PRESENCE}/me/presence`);
      return r.ok && r.json ? { ok: true, ...fields(r.json) } : { ok: false, status: r.status || 0, error: r.error || `présence refusée (HTTP ${r.status})` };
    };
    const of = async ({ mris } = {}) => {
      const want = Array.from(new Set((mris || []).filter((m) => MRI.test(String(m))))).slice(0, 100);
      if (!want.length) return { ok: true, people: {} };
      const r = await call("POST", `${PRESENCE}/presence/getpresence/`, want.map((mri) => ({ mri })));
      if (!r.ok || !Array.isArray(r.json)) return { ok: false, status: r.status || 0, error: r.error || `présence refusée (HTTP ${r.status})` };
      const people = {};
      for (const it of r.json) if (it && it.mri && it.presence) people[it.mri] = fields(it.presence);
      return { ok: true, people };
    };
    // Note de statut : écrite, puis relue. L'échéance donnée est gardée telle quelle.
    const note = async ({ message, expiry } = {}) => {
      const text = String(message || "").replace(/\s+/g, " ").trim().slice(0, 280);
      if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(String(expiry || ""))) return { ok: false, attempted: false, error: "échéance de la note invalide" };
      const w = await call("PUT", `${PRESENCE}/me/publishnote`, { message: text ? `<p>${esc(text)}</p>` : "", expiry: String(expiry) });
      if (!w.sent) return { ok: false, attempted: false, error: w.error };
      if (!w.ok && !w.unknown) return { ok: false, attempted: true, error: `note refusée (HTTP ${w.status})` };
      for (const wait of [0, 700, 1500]) {
        if (wait) await sleep(wait);
        const r = await me();
        if (r.ok && r.note.message === text) return { ok: true, message: r.note.message, expiry: r.note.expiry };
      }
      return { ok: false, attempted: true, uncertain: true, error: "note non confirmée par le service de présence" };
    };
    // Statut choisi (Disponible, Occupé…), comme le menu de Teams : `PUT me/forceavailability/`
    // avec { availability, activity: "OffWork" pour Hors ligne, desiredExpirationTime } ; sans
    // corps, le statut est réinitialisé (Teams décide à nouveau). Écrit une fois, puis relu.
    const AVAILABILITY = ["Available", "Busy", "DoNotDisturb", "BeRightBack", "Away", "Offline"];
    const writeForce = async (body, proven) => {
      const w = await call("PUT", `${PRESENCE}/me/forceavailability/`, body);
      if (!w.sent) return { ok: false, attempted: false, error: w.error };
      if (!w.ok && !w.unknown) return { ok: false, attempted: true, error: `statut refusé (HTTP ${w.status})` };
      for (const wait of [0, 700, 1500]) {
        if (wait) await sleep(wait);
        const r = await me();
        if (r.ok && proven(r)) return r;
      }
      return { ok: false, attempted: true, uncertain: true, error: "statut non confirmé par le service de présence" };
    };
    const force = async ({ availability, expiry } = {}) => {
      const a = String(availability || "");
      if (!AVAILABILITY.includes(a)) return { ok: false, attempted: false, error: "statut inconnu" };
      const until = expiry == null || expiry === "" ? "" : String(expiry);
      if (until && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(until)) return { ok: false, attempted: false, error: "échéance du statut invalide" };
      const body = { availability: a, ...(a === "Offline" ? { activity: "OffWork" } : {}), ...(until ? { desiredExpirationTime: until } : {}) };
      // Preuve : le service garde CE statut comme choisi (l'activité du moment, une réunion par
      // exemple, peut s'afficher par-dessus), et la même échéance à la minute près.
      const sameExpiry = (got) => !until || Math.abs(Date.parse(got) - Date.parse(until)) < 60000;
      return writeForce(body, (r) => r.forced.availability === a && sameExpiry(r.forced.expiry));
    };
    const reset = async () => writeForce(undefined, (r) => !r.forced.availability);
    // Personnes que Teams propose pour une saisie (comme « Nouvelle conversation »).
    const search = async ({ query, limit = 8 } = {}) => {
      const q = String(query || "").replace(/\s+/g, " ").trim().slice(0, 100);
      const base = apiCapture.mtBase();
      if (!q) return { ok: true, people: [] };
      if (!base) return { ok: false, error: "middletier inconnu pour l'instant" };
      const r = await call("POST", `${base}beta/users/searchV2?includeDLs=false&includeBots=false&enableGuest=true&source=newChat&skypeTeamsInfo=true`, q);
      const list = r.ok && r.json && Array.isArray(r.json.value) ? r.json.value : null;
      if (!list) return { ok: false, status: r.status || 0, error: r.error || `recherche refusée (HTTP ${r.status})` };
      const people = list
        .map((u) => ({ name: String((u && u.displayName) || "").trim(), mri: String((u && u.mri) || ""), email: String((u && (u.email || u.mail)) || "") }))
        .filter((u) => u.name)
        .slice(0, Math.max(1, Math.min(25, Number(limit) || 8)));
      return { ok: true, people };
    };
    const run = { me, of, note, search, force, reset };
    const WRITES = ["note", "force", "reset"];
    return async (args) => {
      const kind = String((args && args.kind) || "");
      if (!run[kind]) return { ok: false, attempted: false, error: "opération inconnue" };
      try {
        return await run[kind](args || {});
      } catch (err) {
        const write = WRITES.includes(kind);
        return { ok: false, attempted: write, uncertain: write, error: String((err && err.message) || err) };
      }
    };
  })();

  // --- Mentions (@quelqu'un) ---
  // Teams n'ouvre ses suggestions de mention que sur une vraie frappe : les événements
  // fabriqués par un script sont ignorés. Trame tape « @Nom » par l'application
  // (teams_type_trusted, réservé à cette page), choisit la seule suggestion de ce nom,
  // et vérifie que l'éditeur contient bien une mention de plus.
  const MENTION_LIST = LM.mention_list;
  const typeTrusted = (text) => window.__TAURI_INTERNALS__.invoke("teams_type_trusted", { text });
  // Une personne mentionnée = un élément « readonly-mention », qui contient un élément
  // « mention » par mot du nom (prénom, nom), chacun avec l'identifiant Teams (mri).
  const mentionsIn = (box) => {
    try {
      const ed = cke(box);
      let n = 0;
      for (const step of ed.model.createRangeIn(ed.model.document.getRoot())) {
        if (step.type === "elementStart" && step.item.name === "readonly-mention") n++;
      }
      return n;
    } catch {
      return -1;
    }
  };
  // Le texte se termine-t-il par une espace ? Teams en ajoute une après une mention.
  const endsWithSpace = (box) => {
    try {
      const ed = cke(box);
      let last = "";
      for (const step of ed.model.createRangeIn(ed.model.document.getRoot())) {
        if (typeof step.item.data === "string") last = step.item.data;
        else if (step.type === "elementEnd" && step.item.name === "readonly-mention") last = "";
      }
      return /[\s ]$/.test(last);
    } catch {
      return false;
    }
  };
  // « Salut @Ana Lopez, tu vois avec @Marc ? » -> morceaux de texte et mentions, dans l'ordre.
  const splitMentions = (text, names) => {
    const out = [];
    let rest = text;
    while (rest) {
      let best = null;
      for (const n of names) {
        const i = rest.toLowerCase().indexOf("@" + n.toLowerCase());
        if (i >= 0 && (!best || i < best.i)) best = { i, n };
      }
      if (!best) {
        out.push({ text: rest });
        break;
      }
      if (best.i) out.push({ text: rest.slice(0, best.i) });
      out.push({ mention: best.n });
      rest = rest.slice(best.i + 1 + best.n.length);
    }
    return out;
  };
  const closePopup = () =>
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
  // Une mention : null si elle est en place, sinon la raison.
  const addMention = async (box, who) => {
    const before = mentionsIn(box);
    if (before < 0) return "éditeur de Teams illisible";
    caretAtEnd(box);
    try {
      await typeTrusted("@" + who);
    } catch (e) {
      return `frappe impossible (${(e && e.message) || e})`;
    }
    const n = norm(who);
    const matches = () =>
      Array.from(document.querySelectorAll(`${MENTION_LIST} [role="option"]`))
        .filter(visible)
        .filter((o) => {
          const l = norm(label(o));
          return l === n || l.startsWith(n + " ");
        });
    if (!(await waitFor(() => matches().length > 0, 5000))) {
      // Liste de suggestions affichée sans ce nom : la personne n'y est pas. Pas de liste
      // du tout : Teams l'a renommée ou ne l'ouvre plus.
      seen("mention_list", Array.from(document.querySelectorAll(MENTION_LIST)).some(visible));
      closePopup();
      return `« ${who} » absent des suggestions de Teams (pas dans cette conversation ?)`;
    }
    seen("mention_list", true);
    await sleep(400); // la liste se met à jour au fil de la frappe
    const found = matches();
    if (found.length !== 1) {
      closePopup();
      return `${found.length} personnes nommées « ${who} » dans les suggestions`;
    }
    found[0].click();
    if (await waitFor(() => mentionsIn(box) > before, 2500)) return null;
    closePopup();
    return `mention de « ${who} » non créée par Teams`;
  };
  const typeWithMentions = async ({ name, text, send, quote, mentions }) => {
    if (!isOpen(name)) return { ok: false, error: "autre conversation ouverte" };
    let box = editor();
    if (!box) return { ok: false, error: "zone de saisie introuvable" };
    if (box.innerText.trim()) return notEmpty(box);
    const fail = (error) => {
      clear(box);
      return { ok: false, error };
    };
    if (quote) {
      const why = await quoteMessage(quote, box);
      if (why) return fail(why);
      if (!isOpen(name)) return fail("conversation changée pendant la citation");
      box = editor() || box;
    }
    const parts = splitMentions(text, mentions);
    const wanted = parts.filter((p) => p.mention).length;
    if (!wanted) return fail("mention absente du texte");
    // Le message cité peut lui-même contenir des mentions : on compte à partir d'ici.
    const base = mentionsIn(box);
    // Un morceau avec du code tapé brut (mise en forme refusée) garde ses marques à l'écran.
    let rawCode = false;
    for (const part of parts) {
      if (late()) return fail("délai dépassé pendant la saisie");
      if (!isOpen(name)) return fail("conversation changée pendant la saisie");
      if (part.mention) {
        const why = await addMention(box, part.mention);
        if (why) return fail(why);
        continue;
      }
      // Teams laisse une espace après la mention : pas de double espace.
      const chunk = endsWithSpace(box) ? part.text.replace(/^[  ]/, "") : part.text;
      if (!chunk) continue;
      caretAtEnd(box);
      const how = await insert(box, chunk);
      if (!how) return fail("texte non inséré après une mention");
      if (hasCode(chunk) && how !== "code") rawCode = true;
    }
    // Un essai de saisie raté vide la zone : toutes les mentions doivent y être encore.
    if (mentionsIn(box) !== base + wanted) return fail("mentions perdues pendant la saisie");
    if (!send) return { ok: true };
    if (!isOpen(name)) return fail("conversation changée avant l'envoi");
    if (late()) return fail("délai dépassé avant l'envoi");
    // Une fois envoyée, la mention s'affiche sans « @ » : on cherche le texte sans.
    const shownText = mentions.reduce((t, m) => t.split("@" + m).join(m), rawCode ? text : shownOf(text));
    const key = flat(shownText).slice(0, 40);
    const before = lastMessages(3).filter((t) => t.includes(key)).length;
    await waitFor(sendReady, 1500);
    if (!sendReady()) return fail("Envoyer reste inactif");
    sendButton().click();
    const shown = await waitFor(() => lastMessages(3).filter((t) => t.includes(key)).length > before, 6000);
    if (shown) return { ok: true };
    if (box.innerText.trim() || modelText(box)) return fail("envoi refusé par Teams (mentions)");
    return { ok: false, uncertain: true, error: "message non visible dans la conversation, vérifie dans Teams (mentions)" };
  };

  // --- Un message précis du fil : réagir, répondre ---
  // Même texte que read (sans cartes ni boutons) : le message est retrouvé par son début.
  const bodyOf = (el) => partsOf(el).text;
  const msgId = (el) => {
    const c = el.querySelector('[id^="content-"]');
    if (c) return c.id.slice("content-".length);
    return el.getAttribute("data-mid") || el.querySelector("[data-mid]")?.getAttribute("data-mid") || "";
  };
  // Les réactions en un clic de la barre de survol de Teams (data-tid message-actions-<clé>),
  // avec leurs libellés (anglais, français) pour les pastilles posées sous les messages :
  // « 1 réaction J’aime. », « 2 réactions Rigole ».
  const REACTION_NAMES = {
    like: ["like", "j'aime", "j’aime", "jaime"],
    heart: ["heart", "coeur", "cœur"],
    laugh: ["laugh", "rigole", "rire"],
    surprised: ["surprised", "surpris"],
  };
  // Mots du libellé, ponctuation retirée : « J’aime. » donne « j’aime ».
  const words = (text) => ` ${norm(text).replace(/[^\p{L}\p{N}'’]+/gu, " ").trim()} `;
  const reactionOf = (text) => {
    const w = words(text);
    for (const [key, names] of Object.entries(REACTION_NAMES)) if (names.some((x) => w.includes(` ${x} `))) return key;
    return null;
  };
  // Réactions que l'utilisateur a déjà mises sur ce message : pastilles enfoncées
  // (aria-pressed), ou dont le libellé dit « vous » / « you ».
  const myReactions = (el) => {
    const out = new Set();
    const pills = el.querySelectorAll('[data-tid="diverse-reaction-pill-button"], button, [role="button"]');
    for (const b of pills) {
      const l = label(b) || b.getAttribute("title") || "";
      const key = reactionOf(l);
      if (!key || !/\d/.test(l + b.innerText)) continue;
      if (b.getAttribute("aria-pressed") === "true" || /\b(vous|you)\b/i.test(l)) out.add(key);
    }
    return Array.from(out);
  };
  // Les messages dans l'ordre, l'auteur reporté sur les messages groupés (comme read).
  const thread = () => {
    let sender = "";
    return Array.from(document.querySelectorAll(MSGS)).map((el) => {
      const who = el.querySelector('[data-tid="message-author-name"]')?.innerText?.trim();
      if (who) sender = who;
      return { el, sender, text: bodyOf(el), id: msgId(el) };
    });
  };
  const sameText = (a, b) => norm(a).slice(0, 80) === norm(b).slice(0, 80);
  // Le message choisi par l'utilisateur, vérifié par son auteur et son texte : jamais un autre.
  const findMessage = ({ id, sender, text }) => {
    const all = thread().filter((m) => m.text);
    const ok = (m) => sameText(m.text, text) && (!sender || !m.sender || norm(m.sender) === norm(sender));
    if (id) {
      const m = all.find((x) => x.id === id);
      if (m) return ok(m) ? m : null;
    }
    for (let i = all.length - 1; i >= 0; i--) if (ok(all[i])) return all[i];
    return null;
  };
  const press = (el) => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, button: 0, isPrimary: true }));
    }
  };
  const fire = (node, types) => {
    for (const type of types) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      node.dispatchEvent(new Ctor(type, { bubbles: type.endsWith("over") || type.endsWith("out") || type === "mousemove", view: window }));
    }
  };
  // Une barre d'actions ouverte reste là tant que la souris n'a pas « quitté » son message :
  // on quitte tous les messages avant d'en survoler un autre.
  const unhover = () => {
    for (const b of document.querySelectorAll('[data-tid="chat-pane-message"]')) fire(b, ["pointerout", "pointerleave", "mouseout", "mouseleave"]);
  };
  // Teams n'affiche la barre d'actions d'un message qu'au survol.
  const hover = (el) => {
    unhover();
    const target = el.querySelector('[data-tid="chat-pane-message"]') || el;
    for (const node of [el, target]) fire(node, ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]);
  };
  const ACTIONABLE = 'button, [role="button"], [role="menuitem"]';
  const actions = () => Array.from(document.querySelectorAll(ACTIONABLE)).filter(visible);
  // Bouton de la barre d'actions (pas une pastille de réaction déjà posée, qui porte un compteur).
  const findAction = (match) => actions().find((b) => {
    const l = label(b) || b.getAttribute("title") || "";
    return l && !/\d/.test(l) && match(l);
  });
  // La barre d'actions de Teams est dessinée hors du message, dans un calque à part : son
  // id commence par celui du message (« <id>-popover-surface »). Jamais la barre d'un autre.
  const barFor = (el) => {
    const mid = msgId(el);
    if (!mid) return null;
    return Array.from(document.querySelectorAll('[data-tid="message-actions-container"]'))
      .find((b) => visible(b) && (b.id || "").startsWith(`${mid}-`)) || null;
  };
  // Un bouton de la barre de ce message : par son data-tid, sinon par son libellé.
  const barAction = async (el, tid, match) => {
    let bar = null;
    if (!(await waitFor(() => (bar = barFor(el)), 1500))) return null;
    return bar.querySelector(`[data-tid="${tid}"]`) ||
      Array.from(bar.querySelectorAll(ACTIONABLE)).find((b) => {
        const l = label(b) || b.getAttribute("title") || "";
        return l && !/\d/.test(l) && match(l);
      }) || null;
  };
  // Le défileur du fil de messages (Teams ne dessine que les messages proches de l'écran).
  const msgScroller = () => {
    for (let el = document.querySelector(MSGS); el && el !== document.body; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
    }
    return null;
  };
  // Un message plus ancien que ce que Teams a dessiné : on remonte le fil jusqu'à lui,
  // comme la lecture de l'historique. Trois remontées sans rien de nouveau : il n'y est pas.
  const findOlder = async (m) => {
    const box = msgScroller();
    if (!box) return null;
    const end = Date.now() + 15000;
    for (let stalls = 0; Date.now() < end && !late(); ) {
      const height = box.scrollHeight;
      const count = document.querySelectorAll(MSGS).length;
      box.scrollTop = Math.min(200, height);
      await sleep(50);
      box.scrollTop = 0;
      const grew = await waitFor(() => Boolean(findMessage(m)) || box.scrollHeight !== height ||
        document.querySelectorAll(MSGS).length !== count, 1500);
      const found = findMessage(m);
      if (found) return found;
      if (grew) stalls = 0;
      else if (++stalls >= 3) break;
    }
    return null;
  };
  // Après un geste sur un ancien message, le fil revient en bas : c'est là que Teams montre
  // le message envoyé, et là que l'envoi est vérifié.
  const toBottom = () => {
    const box = msgScroller();
    if (box) box.scrollTop = box.scrollHeight;
  };
  const lookup = async (m) => {
    const found = findMessage(m) || (await findOlder(m));
    if (!found) return null;
    found.el.scrollIntoView({ block: "nearest" });
    hover(found.el);
    await sleep(250);
    return found;
  };
  const QUOTE_SEL = '[data-tid="quoted-reply-card"], [data-tid*="quote" i], [data-tid*="reply" i], blockquote, [class*="quote" i]';
  const composeArea = (box) =>
    box.closest('[data-tid="message-compose"], [data-tid*="compose" i], form') || box.parentElement?.parentElement || box;
  // La citation (« quoted-reply-card ») est dessinée dans la zone de saisie elle-même.
  const quoted = (box, text) => {
    const key = norm(text).slice(0, 24);
    const cards = [...box.querySelectorAll(QUOTE_SEL), ...composeArea(box).querySelectorAll(QUOTE_SEL)];
    return cards.some((q) => norm(q.innerText).includes(key));
  };
  // Retire une citation laissée dans la zone de saisie (bouton « Supprimer la référence »).
  const unquote = (box) => {
    for (const root of [box, composeArea(box)]) {
      const close = root.querySelector('[data-tid="close-quoted-reply"]');
      if (close) return void close.click();
    }
  };
  // « Répondre avec une citation », dans la barre d'actions de ce message.
  const quoteMessage = async (target, box) => {
    const found = await lookup(target);
    if (!found) return "message cité introuvable ou différent de celui choisi";
    const isReply = (l) => /^(reply|repondre|quote|citer)\b/.test(norm(l));
    let btn = await barAction(found.el, "message-actions-quoted-reply", isReply);
    if (!btn) {
      // Sur tes propres messages, Teams met « Modifier » dans la barre et range « Répondre
      // avec une citation » dans « Autres options » de cette même barre. Ce menu contient
      // aussi « Supprimer » : on n'y prend que l'entrée de citation, par son data-tid.
      const more = await barAction(found.el, "message-actions-more", () => false);
      if (more) {
        more.click();
        const item = () =>
          Array.from(document.querySelectorAll('[data-tid="message-actions-quoted-reply"]')).find(visible) || null;
        if (await waitFor(() => Boolean(item()), 1500)) btn = item();
        if (!btn) document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
    }
    if (!btn) return "action « Répondre » introuvable sur ce message";
    btn.click();
    const shown = await waitFor(() => quoted(box, target.text), 2500);
    unhover();
    toBottom();
    if (!shown) return "citation du message non visible dans la zone de saisie";
    return null;
  };

  // --- Supprimer un de ses propres messages ---
  // Ce que Teams montre à la place d'un message supprimé (« Ce message a été supprimé. Annuler »).
  const DELETED_RE = /^(ce message a ete supprime|this message has been deleted)\b/;
  const isDeleted = (el) => DELETED_RE.test(norm(flat(el?.innerText || "")));
  const byId = (mid) => Array.from(document.querySelectorAll(MSGS)).find((el) => msgId(el) === mid) || null;
  const escape = () =>
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
  // Teams ne propose « Modifier » que sur tes propres messages : c'est la preuve, lue dans
  // la barre de CE message, qu'il est à toi (« Supprimer » existe aussi pour un modérateur).
  const isEdit = (l) => /^(edit|modifier)\b/.test(norm(l));
  // « Supprimer ce message » (data-tid message-actions-delete) dans le menu « … » du message.
  const isDelete = (l) => /^(delete|supprimer)( (this|ce) message)?$/.test(norm(l).replace(/[.…]+$/, ""));
  const deleteEntry = () =>
    Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] button')).find(
      (b) => visible(b) && (b.getAttribute("data-tid") === "message-actions-delete" || isDelete(label(b)))
    ) || null;
  // La confirmation de Teams, quand il en affiche une : son bouton « Supprimer ».
  const confirmDelete = () => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter(visible);
    for (const d of dialogs) {
      const b = Array.from(d.querySelectorAll("button")).find((x) => visible(x) && isDelete(label(x)));
      if (b) return b;
    }
    return null;
  };

  // Son propre statut. Le bouton du profil (avatar en haut à droite) le dit dans son
  // libellé (« Votre profil, statut Ne pas déranger ») et sur son badge (« do not
  // disturb ») : le lire n'ouvre aucun menu. Le changer passe par son menu, entrée
  // « Modifier l'état », puis le choix ; le moteur vérifie ensuite ce que Teams affiche.
  const ME = LM.me;
  const ME_MENU = LM.me_menu;
  const STATUS_ENTRY = LM.status_entry;
  const STATUS_TIDS = {
    available: "me_control_presence_availability_available",
    busy: "me_control_presence_availability_busy",
    dnd: "me_control_presence_availability_do_not_disturb",
    brb: "me_control_presence_availability_be_right_back",
    away: "me_control_presence_availability_appear_away",
    offline: "me_control_presence_availability_appear_offline",
    reset: "set-availability-reset-status",
  };
  // Panneau « Durée » du menu de statut : deux listes (statut, « Rétablir le statut
  // après ») dans l'ordre du menu de Teams, « Terminé » et « Précédent ». Les libellés,
  // sans accents ni casse, confirment chaque choix (français et anglais).
  const DURATION_ENTRY = LM.duration_entry;
  const AVAIL_STATUS = "set-availability-choose-availability-dropdown";
  const AVAIL_AFTER = "set-availability-clear-availability-after-dropdown";
  const AVAIL_DONE = LM.duration_panel;
  const AVAIL_BACK = '[data-tid="me-control-set-availability-back-button"]';
  const STATUS_ORDER = ["available", "busy", "dnd", "brb", "away", "offline"];
  const STATUS_WORDS = {
    available: /^(disponible|available)/,
    busy: /^(occupe|busy)/,
    dnd: /^(ne pas deranger|do not disturb)/,
    brb: /^(de retour bientot|be right back)/,
    away: /^(apparaitre absent|appear away|absent|away)/,
    offline: /^(apparaitre hors ligne|appear offline|hors ligne|offline)/,
  };
  const DURATION_ORDER = ["30m", "1h", "2h", "today", "week", "custom"];
  const DURATION_WORDS = {
    "30m": /^30 min/,
    "1h": /^1 (heure|hour)/,
    "2h": /^2 (heures|hours)/,
    today: /^(aujourd'hui|aujourd’hui|today)/,
    week: /^(cette semaine|this week)/,
    custom: /^(personnalise|custom)/,
  };
  // « Personnalisé » : un champ de date en lecture seule qui ouvre un calendrier (jours
  // nommés « 26, novembre, 2026 »), et une liste native des heures par demi-heure dont
  // chaque valeur est l'instant visé en millisecondes, recalculée pour le jour choisi.
  const AVAIL_DATE = LM.expiry_date;
  const AVAIL_TIME = LM.expiry_time;
  const MONTHS = [
    ["janvier", "january"], ["fevrier", "february"], ["mars", "march"], ["avril", "april"],
    ["mai", "may"], ["juin", "june"], ["juillet", "july"], ["aout", "august"],
    ["septembre", "september"], ["octobre", "october"], ["novembre", "november"], ["decembre", "december"],
  ];
  const monthOf = (word) => MONTHS.findIndex((names) => names.includes(norm(word)));
  const NOTE = '[data-tid="me-control-status-note-container"]';
  const NOTE_EDIT = LM.note_edit;
  const NOTE_CLEAR = '[data-tid="me-control-menu-status-message-clear-button"]';
  const NOTE_PANEL = '[data-tid="me-control-set-status-message"]';
  const NOTE_DONE = '[data-tid="me-control-set-status-message-update-status-message-button"]';
  const NOTE_BACK = '[data-tid="me-control-set-status-message-back-button"]';
  const firstVisible = (sel) => Array.from(document.querySelectorAll(sel)).find(visible) || null;
  const myLabels = () => {
    const out = [];
    const trigger = document.querySelector(ME);
    const badge = document.querySelector('[data-tid="me-control-avatar-presence"]');
    for (const el of [trigger, badge]) {
      const t = (el?.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      if (t) out.push(t);
    }
    return out;
  };
  const meMenuOpen = () => visible(document.querySelector(ME_MENU));
  const openMeMenu = async () => {
    if (meMenuOpen()) return true;
    const trigger = document.querySelector(ME);
    if (!trigger) return false;
    trigger.click();
    return seen("me_menu", await waitFor(meMenuOpen, 3000));
  };
  // Échap ferme le sous-menu puis le menu ; en dernier recours, le bouton du profil
  // le referme. Jamais de menu laissé ouvert dans la fenêtre Teams de Trame.
  const closeMeMenu = async () => {
    for (let i = 0; i < 3 && meMenuOpen(); i++) {
      (document.activeElement || document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })
      );
      await waitFor(() => !meMenuOpen(), 600);
    }
    if (meMenuOpen()) {
      document.querySelector(ME)?.click();
      await waitFor(() => !meMenuOpen(), 800);
    }
    return !meMenuOpen();
  };
  const noteText = () => flat(document.querySelector(NOTE)?.innerText || "");
  const readNote = async () => {
    if (!(await openMeMenu())) return null;
    await waitFor(() => document.querySelector(NOTE) || firstVisible(NOTE_EDIT), 1500);
    return noteText();
  };

  // Une ligne de la liste annoncée non lue (« Non lu », « Unread » en tête de son libellé).
  const UNREAD_LABEL = /^(non lus?|unread)\b/;
  // Contrôle des repères (voir LANDMARKS), en lecture seule : rien n'est cliqué ni tapé, aucun
  // menu ouvert. Seul geste : le survol du dernier message, pour que Teams montre sa barre
  // d'actions, retiré aussitôt, et seulement quand aucune autre opération ne tourne.
  // Chaque repère : true trouvé, false absent, null pas vérifiable maintenant.
  const probe = async () => {
    const has = (key) => Boolean(document.querySelector(LM[key]));
    // Ni liste ni bouton du profil : Teams pas encore affiché ou pas connecté.
    if (!rail() && !document.querySelector(ME)) return { ready: false, results: {}, marks };
    // La recherche remplace la liste un moment : rien à conclure pendant une opération.
    if (!rail() && running) return { ready: false, busy: running, results: {}, marks };
    const results = {};
    const when = (scope, test) => {
      for (const [key, w] of LANDMARKS) if (w === scope) results[key] = test(key);
    };
    when("page", has);
    const box = editor();
    const chat = Boolean(titleName() || box);
    when("chat", (key) => {
      if (!chat) return null;
      // Le titre de la fenêtre nomme la conversation ouverte : toutes les opérations s'y fient.
      if (key === "title") return Boolean(titleName());
      if (key === "editor_model") return box ? Boolean(cke(box)) : null;
      if (key === "attach") return box ? Boolean(pickerButton(composeRoot(box))) : null;
      return has(key);
    });
    // Des messages affichés : une heure de message hors de la liste des conversations.
    const thread = chat && Array.from(document.querySelectorAll("time")).some((t) => !rail()?.contains(t));
    when("thread", (key) => (thread ? has(key) : null));
    when("hover", () => null);
    const last = Array.from(document.querySelectorAll(MSGS)).reverse().find((el) => msgId(el));
    if (thread && last && !running) {
      hover(last);
      let bar = null;
      await waitFor(() => (bar = barFor(last)), 1500);
      // Une opération lancée entre-temps survole son propre message : rien à conclure, et
      // surtout ne pas lui retirer sa barre.
      if (running) when("hover", () => null);
      else {
        when("hover", (key) => (key === "action_bar" ? Boolean(bar) : bar ? Boolean(bar.querySelector(LM[key])) : null));
        unhover();
      }
    }
    const unreadRows = items().filter((el) => UNREAD_LABEL.test(norm(label(el)).replace(KIND, "")));
    when("unread", () => (unreadRows.length ? unreadRows.some((el) => el.querySelector(UNREAD)) : null));
    when("menu", () => null);
    return { ready: true, busy: running, results, marks };
  };

  // Cartes « La réunion est terminée » d'une conversation de réunion.
  const RECAP_CARD = '[data-testid="meeting-recap-chiclet"]';
  const TRANSCRIPT_WORD = /^(transcript|transcription|transkript|trascrizione)$/i;
  const recapInfo = (card) => {
    const top = card.querySelector('[data-testid="meeting-recap-chiclet-top-container"]') || card;
    const texts = Array.from(top.querySelectorAll(".fui-Text")).map((s) => flat(s.innerText)).filter(Boolean);
    const artifacts = Array.from(card.querySelectorAll("button")).map((b) => flat(b.innerText || b.getAttribute("aria-label")));
    return {
      mid: card.closest("[data-mid]")?.getAttribute("data-mid") || "",
      title: texts[0] || "",
      when: texts[1] || "",
      transcript: artifacts.some((t) => TRANSCRIPT_WORD.test(t)),
    };
  };
  const transcriptTab = () =>
    Array.from(document.querySelectorAll('[role="tab"]')).find(
      (t) => t.getAttribute("data-tid") === "Transcript" || TRANSCRIPT_WORD.test(flat(t.innerText).replace(/^(\S+)\1$/, "$1")),
    ) || null;
  const recapFrame = () => document.querySelector('iframe[name="RecapxPlatIframe"], [data-testid="recap xplat iframe"] iframe');
  // Date de l'occurrence affichée en tête du récapitulatif (« mardi 24 novembre 2026 11:00 – 11:20 »).
  const recapWhen = () =>
    Array.from(document.querySelectorAll('button, [role="combobox"]'))
      .map((b) => flat(b.innerText))
      .find((t) => /\b20\d\d\b.*\d{1,2}:\d{2}/.test(t) && t.length < 80) || "";
  // Demande à l'iframe de la transcription, répétée jusqu'à son accusé (elle peut
  // encore charger). Seule une réponse de cette iframe, servie par SharePoint, compte.
  const askFrame = (mode, budget) =>
    new Promise((resolve) => {
      const frame = recapFrame();
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      let acked = false;
      const onMsg = (e) => {
        let host = "";
        try {
          host = new URL(e.origin).hostname;
        } catch {}
        if (!frame || e.source !== frame.contentWindow || !/(^|\.)sharepoint\.com$/i.test(host)) return;
        const d = e.data;
        if (!d || d.nonce !== nonce) return;
        if (d.trame === "trame-transcript-ack") acked = true;
        if (d.trame === "trame-transcript-result") {
          const { trame, nonce: _n, ...rest } = d;
          done(rest);
        }
      };
      const done = (res) => {
        window.removeEventListener("message", onMsg);
        clearInterval(timer);
        clearTimeout(stop);
        resolve(res);
      };
      const stop = setTimeout(() => done({ ok: false, reason: acked ? "timeout" : "frame", error: acked ? "transcription trop longue à relire" : "l'iframe de la transcription ne répond pas" }), budget);
      window.addEventListener("message", onMsg);
      const post = () => {
        if (acked) return;
        try {
          // La demande ne contient rien de privé ; la réponse, elle, n'est acceptée que de cette iframe.
          frame?.contentWindow?.postMessage({ trame: "trame-transcript", nonce, mode, budget_ms: budget - 2000 }, "*");
        } catch {}
      };
      const timer = setInterval(post, 1500);
      post();
    });

  // Dernier auto-test de signature (statut seulement), rafraîchi au plus toutes les 60 s par
  // `diagnose` : rejoue signée une sonde GET sûre pour vérifier que la signature en page marche.
  let lastSignTest = null;
  const ops = {
    ping: () => ({ title: document.title, ready: Boolean(rail()) }),
    probe,
    title: () => document.title,
    // Lecture sur le service de chat de Teams, dans la page (voir `chatsvc`). Le moteur ne
    // donne qu'un chemin permis et des paramètres permis ; il ne reçoit que le corps métier.
    chatsvc: ({ path, query }) => chatsvc.get({ path, query }),
    // Un fil lu sur le service de chat, sans ouvrir la conversation : même forme que `read`.
    chatread: (args) => chatThread(args || {}),
    // La liste des conversations sur le service de chat (complète, puis ce qui a changé).
    chatlist: (args) => chatList(args || {}),
    // Présence (la mienne, celle des autres), note de statut, recherche de personnes.
    teamspeople: (args) => teamsPeople(args || {}),
    // Un geste sur le service de chat (lu, réaction, suppression, envoi), vérifié puis prouvé.
    chatgesture: (args) => chatGestures(args || {}),
    chatdm: (args) => chatDm(args || {}),
    meetingshapes: (args) => meetingShapes(args || {}),
    // Appel authentifié DEPUIS la page : fetch same-origin ou vers un service Teams que la
    // page interroge déjà, avec SES propres credentials. Ne renvoie que le corps métier parsé
    // et borné — jamais d'en-tête de réponse (hors type), jamais d'auth.
    // Signature (`sign`, défaut true) : on rejoue DANS la page l'en-tête d'auth que Teams a
    // lui-même posé pour cet hôte (voir `creds`). Le jeton reste dans la page : le moteur ne
    // peut ni fournir ni lire un credential ; il ne reçoit que des données métier. Si aucun
    // credential n'a encore été observé pour l'hôte, l'appel part en cookies seuls (et pourra
    // échouer en 401 → repli DOM côté moteur).
    // cookies : false pour Graph, qui refuse un appel avec cookies (CORS « * ») ; le jeton signe seul.
    webfetch: async ({ url, method = "GET", body = null, headers = null, json = true, sign = true, cookies = true }) => {
      let u;
      try {
        u = new URL(String(url || ""), location.origin);
      } catch {
        return { ok: false, error: "url invalide" };
      }
      if (u.protocol !== "https:") return { ok: false, error: "https requis" };
      if (!API_HOSTS.test(u.hostname)) return { ok: false, error: `hôte non autorisé : ${u.hostname}` };
      const init = { method: String(method || "GET").toUpperCase(), credentials: cookies ? "include" : "omit", headers: {} };
      if (headers && typeof headers === "object")
        for (const [k, v] of Object.entries(headers)) {
          // Seuls des en-têtes métier : tout en-tête d'auth venant du moteur est ignoré.
          if (!AUTH_HEADER.test(String(k))) init.headers[String(k)] = String(v);
        }
      // Resigne avec l'auth que Teams a posée pour CET endpoint (bonne audience), repli hôte.
      // Jamais fournie par le moteur.
      if (sign) {
        const c = apiCapture.credsFor(u.toString());
        if (c && c.authorization) init.headers["Authorization"] = c.authorization;
        if (c && c.xSkypetoken) init.headers["X-Skypetoken"] = c.xSkypetoken;
      }
      if (body != null && init.method !== "GET" && init.method !== "HEAD") {
        init.body = typeof body === "string" ? body : JSON.stringify(body);
        if (!Object.keys(init.headers).some((k) => k.toLowerCase() === "content-type"))
          init.headers["Content-Type"] = "application/json";
      }
      let res;
      try {
        res = await fetch(u.toString(), init);
      } catch (e) {
        return { ok: false, error: `échec réseau : ${String((e && e.message) || e)}` };
      }
      const ct = (res.headers.get("content-type") || "").split(";")[0];
      const out = { ok: res.ok, status: res.status, contentType: ct };
      let text = "";
      try {
        text = await res.text();
      } catch {}
      const LIMIT = 2_000_000;
      const clipped = text.length > LIMIT ? text.slice(0, LIMIT) : text;
      if (json && /json/i.test(ct)) {
        try {
          out.json = JSON.parse(clipped);
        } catch {
          out.text = clipped;
        }
      } else {
        out.text = clipped;
      }
      return out;
    },
    // Lien de téléchargement d'un fichier joint (vidéo à lire dans Trame, fichier à
    // enregistrer) : le lien de partage SharePoint / OneDrive est résolu par Graph, comme
    // Teams le fait lui-même pour l'aperçu (POST /shares/{id}/driveItem/preview), signé
    // dans la page. Graph rend une adresse de téléchargement pré-signée par SharePoint,
    // propre à ce fichier et valable environ une heure : c'est elle seule qui sort de la
    // page (jamais le jeton Graph), et elle n'est jamais journalisée.
    // Graph n'est signable qu'une fois que Teams l'a lui-même appelé dans cette page (il le
    // fait en chargeant l'aperçu d'une vidéo). Sans auth : `no_auth`, ou, avec show, la vidéo
    // de la conversation ouverte est amenée à l'écran le temps que Teams charge son aperçu.
    filelink: async ({ url, show = false }) => {
      let u;
      try {
        u = new URL(String(url || ""));
      } catch {
        return { ok: false, error: "lien illisible" };
      }
      if (u.protocol !== "https:" || !FILE_HOSTS.test(u.hostname)) return { ok: false, error: "lien hors SharePoint / OneDrive" };
      const share = "u!" + btoa(unescape(encodeURIComponent(u.toString()))).replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
      const api = `https://graph.microsoft.com/v1.0/shares/${share}/driveItem`;
      if (!apiCapture.credsFor(api)) {
        if (!show) return { ok: false, reason: "no_auth", error: "Teams n'a pas encore ouvert de fichier dans cette session" };
        // Le jeton Graph n'est pas propre au fichier : à défaut du fichier voulu (le service de
        // chat donne parfois son adresse directe, la page son lien de partage), n'importe quel
        // fichier de la conversation fait charger un aperçu par Teams.
        const cards = Array.from(document.querySelectorAll('[data-testid="file-attachment"], [data-tid="file-attachment-grid"] [role="group"]'));
        const mentions = (el) => ["title", "aria-label"].some((k) => (el.getAttribute(k) || "").includes(u.toString()));
        const card = cards.find(mentions) || cards[cards.length - 1];
        if (!card) return { ok: false, reason: "no_auth", error: "aucun fichier affiché dans la conversation" };
        card.scrollIntoView({ block: "center" });
        for (let i = 0; i < 40 && !apiCapture.credsFor(api); i++) await sleep(250);
        if (!apiCapture.credsFor(api)) return { ok: false, reason: "no_auth", error: "Teams n'a pas chargé l'aperçu du fichier" };
      }
      const r = await ops.webfetch({ url: api, method: "GET", sign: true, json: true, cookies: false });
      if (!r || !r.ok) {
        const status = (r && r.status) || 0;
        if (status === 401 && !show) return { ok: false, reason: "no_auth", error: "autorisation Graph expirée" };
        return { ok: false, status, error: status === 401 || status === 403 ? "accès au fichier refusé" : status === 404 ? "fichier introuvable" : (r && r.error) || `Graph ${status}` };
      }
      const item = r.json || {};
      const link = String(item["@microsoft.graph.downloadUrl"] || "");
      let dl;
      try {
        dl = new URL(link);
      } catch {
        return { ok: false, error: "pas de lien de téléchargement" };
      }
      if (dl.protocol !== "https:" || !FILE_HOSTS.test(dl.hostname)) return { ok: false, error: "lien de téléchargement inattendu" };
      return { ok: true, name: String(item.name || ""), size: Number(item.size) || 0, mime: String((item.file && item.file.mimeType) || ""), url: dl.toString() };
    },
    // deep : Teams ne dessine que le début de la liste. On la fait défiler jusqu'en bas
    // pour charger la suite, en cumulant ce qui passe, puis on revient où elle était.
    list: async ({ deep } = {}) => {
      const box = deep ? railScroller() : null;
      if (!box) return railItems();
      const seen = new Map();
      const add = () => railItems().forEach((it) => seen.has(it.id || it.label) || seen.set(it.id || it.label, it));
      const top = box.scrollTop;
      const end = Date.now() + 12000;
      add();
      for (let still = 0; still < 3 && Date.now() < end && !late(); ) {
        const before = `${seen.size}/${box.scrollHeight}/${box.scrollTop}`;
        box.scrollTop += Math.max(200, box.clientHeight * 0.8);
        await sleep(300);
        add();
        still = before === `${seen.size}/${box.scrollHeight}/${box.scrollTop}` ? still + 1 : 0;
      }
      box.scrollTop = top;
      return Array.from(seen.values());
    },
    open: async ({ name }) => {
      if (isOpen(name)) return { ok: true, title: document.title };
      const item = findItem(name);
      if (!item) return { ok: false, title: document.title, error: `« ${name} » absente de la liste (${items().length} éléments)` };
      item.scrollIntoView({ block: "nearest" });
      // Un simple click() ne suffit pas toujours : Teams écoute parfois les événements
      // pointeur sur l'élément intérieur. On essaie l'un puis l'autre.
      const inner = item.querySelector('[role="button"], a[href], [tabindex="0"], [data-tid]') || item;
      const press = (el) => {
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
          el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, button: 0, isPrimary: true }));
        }
      };
      for (const act of [() => item.click(), () => press(inner), () => press(item)]) {
        act();
        if (await waitFor(() => isOpen(name), 1800)) return { ok: true, title: document.title };
      }
      return {
        ok: false,
        title: document.title,
        error: `clic sans effet sur « ${label(item).split(" ").slice(0, 4).join(" ")} », Teams affiche « ${titleName() || document.title} »`,
      };
    },
    // Nouvelle conversation privée : déjà dans la liste, on l'ouvre ; sinon « Nouvelle
    // conversation », le nom dans le champ « À », la seule personne de ce nom proposée.
    // Réussi seulement si le titre de Teams affiche ce nom : jamais de conversation devinée.
    newchat: async ({ name }) => {
      if (isOpen(name)) return { ok: true, title: document.title };
      if (findItem(name)) return ops.open({ name });
      const button = Array.from(document.querySelectorAll(NEW_CHAT)).find(visible);
      if (!button) return { ok: false, title: document.title, error: "bouton « Nouvelle conversation » introuvable dans Teams" };
      // La conversation affichée avant : rouverte si on n'aboutit pas, pour ne pas laisser
      // Teams sur un brouillon « Nouveau message » vide.
      const before = titleName();
      button.click();
      // Jamais le champ de recherche du haut, qui est lui aussi une liste déroulante.
      const field = () => Array.from(document.querySelectorAll(TO_FIELD)).find((el) => visible(el) && !el.matches(SEARCH_INPUT));
      const giveUp = async (error) => {
        const el = field();
        el?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        if (before && !isOpen(before) && findItem(before)) await ops.open({ name: before });
        return { ok: false, title: document.title, error };
      };
      if (!seen("people_picker", await waitFor(() => field(), 4000))) return giveUp("champ « À » introuvable");
      // Teams place lui-même le focus à l'ouverture de « Nouveau message » (parfois dans la
      // zone de saisie, un instant après) : le champ « À » doit l'avoir au moment de taper,
      // sinon le nom partirait ailleurs. Jamais de frappe hors de ce champ.
      await sleep(300);
      const focused = await waitFor(() => {
        const el = field();
        if (el && document.activeElement !== el) el.focus();
        return Boolean(el) && document.activeElement === el;
      }, 2000);
      if (!focused) return giveUp(`le champ « À » ne prend pas le focus (focus sur ${describe(document.activeElement)})`);
      // Teams ne propose des personnes que sur une vraie frappe (comme pour les mentions) :
      // l'application tape le nom. Sans elle, le setter natif du champ React, en repli.
      try {
        await typeTrusted(name);
      } catch {
        const el = field();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, name);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      // Relu à chaque fois : Teams peut remplacer le champ pendant la frappe.
      if (!(await waitFor(() => norm(field()?.value) === norm(name), 4000))) {
        const el = field();
        const got = el ? `${(el.value || "").length} caractère(s) sur ${name.length}` : "champ disparu";
        return giveUp(`nom non saisi dans le champ « À » (${got}, focus sur ${describe(document.activeElement)})`);
      }
      const input = field();
      const cancel = () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      const n = norm(name);
      // Les suggestions de CE champ (sa liste, aria-controls), jamais celles de la recherche.
      const options = () => {
        const own = document.getElementById(input.getAttribute("aria-controls") || "");
        return own ? Array.from(own.querySelectorAll('[role="option"]')) : Array.from(document.querySelectorAll(LM.people_list));
      };
      // Une suggestion se lit « Nom, Service » (« Nom (Vous), Service » pour soi-même) :
      // le nom est ce qui précède la virgule.
      const matches = () =>
        options()
          .filter(visible)
          .filter((o) => {
            const l = norm(label(o));
            const who = l.split(",")[0].replace(/\s*\((vous|you|moi)\)\s*$/, "").trim();
            return who === n || l === n || l.startsWith(n + " ");
          });
      seen("people_list", await waitFor(() => options().some(visible), 6000));
      await waitFor(() => matches().length > 0, 2000);
      const found = matches();
      if (found.length !== 1) {
        return giveUp(found.length ? `${found.length} personnes nommées « ${name} » dans Teams` : `« ${name} » introuvable dans Teams`);
      }
      found[0].click();
      if (await waitFor(() => isOpen(name), 6000)) return { ok: true, title: document.title };
      cancel();
      return { ok: false, title: document.title, error: `Teams affiche « ${titleName() || document.title} »` };
    },
    // Recherche native de Teams (tout l'historique) : la requête dans le champ du haut,
    // l'onglet Messages, les cartes lues, puis retour à Conversation, où Teams rouvre la
    // conversation affichée avant. Rien n'est saisi ailleurs que dans le champ de recherche.
    search: async ({ query, limit = 25 }) => {
      const input = Array.from(document.querySelectorAll(SEARCH_INPUT)).find(visible);
      if (!input) return { ok: false, error: "champ de recherche de Teams introuvable" };
      const back = async () => {
        const chat = Array.from(document.querySelectorAll(CHAT_APP)).find(visible);
        if (chat && !rail()) {
          chat.click();
          await waitFor(() => rail(), 8000);
        }
      };
      try {
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, query);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(300);
        const form = input.closest("form");
        if (form?.requestSubmit) form.requestSubmit();
        else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        const tab = () => document.querySelector('[data-tid="messages-tab"]');
        if (!seen("search_tab", await waitFor(tab, 10000))) return { ok: false, error: "page de résultats de Teams non affichée" };
        tab().click();
        await waitFor(() => tab()?.getAttribute("aria-selected") === "true", 3000);
        // Les cartes arrivent par lots : la première, puis on attend qu'il n'en arrive plus.
        // Sans aucun résultat, Teams n'affiche aucune carte : on s'arrête au délai.
        // Une page que Chromium croit cachée ne dessine pas ses résultats : ne pas le
        // confondre avec « aucun résultat » (la fenêtre de Trame est garée hors écran, visible).
        if (!(await waitFor(() => searchCards().length > 0, 10000)) && document.visibilityState !== "visible") {
          return { ok: false, error: "la page Teams est en arrière-plan, Teams n'affiche pas ses résultats" };
        }
        let count = -1;
        for (let still = 0, end = Date.now() + 10000; still < 3 && Date.now() < end && !late(); ) {
          await sleep(500);
          const n = searchCards().length;
          still = n === count ? still + 1 : 0;
          count = n;
        }
        // Teams dessine parfois deux fois la même carte.
        const seen = new Set();
        const results = searchCards()
          .map(readCard)
          .filter((r) => {
            const key = `${r.conversation}|${r.sender}|${r.at}|${r.text}`;
            if (!r.text || seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, limit);
        return { ok: true, results };
      } finally {
        await back();
      }
    },
    // Marquer comme lu, sans ouvrir la conversation : menu contextuel de la ligne,
    // entrée « Marquer comme lu ». Cette entrée bascule lu / non lu : on ne clique que
    // si la ligne est non lue ET que l'entrée dit bien « lu », sinon on referme le menu.
    markread: async ({ name }) => {
      const item = findItem(name);
      if (!item || item.querySelector('[role="treeitem"]')) return { ok: false, error: `« ${name} » absente de la liste` };
      const unread = () => Boolean(item.isConnected && item.querySelector(UNREAD));
      if (!unread()) return { ok: true, already: true };
      const r = item.getBoundingClientRect();
      item.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, view: window, button: 2, clientX: r.x + 20, clientY: r.y + 10 })
      );
      const entry = () => document.querySelector(`[role="menu"] ${READ_ENTRY}`);
      const close = () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      if (!seen("read_entry", await waitFor(entry, 2000))) {
        close();
        return { ok: false, error: "entrée « Marquer comme lu » introuvable" };
      }
      const text = label(entry());
      if (!/^(marquer comme lu|mark as read)$/i.test(text)) {
        close();
        return { ok: false, error: `entrée inattendue « ${text} »` };
      }
      entry().click();
      if (await waitFor(() => !unread(), 3000)) return { ok: true };
      return { ok: false, error: "toujours non lue après le clic" };
    },
    // Favori Teams : « Déplacer vers la section › Favoris » pour l'ajouter, « Supprimer de la
    // section » pour le retirer, depuis le menu contextuel de la ligne. Réussi seulement si
    // la ligne est ensuite (ou n'est plus) dans le dossier Favoris.
    favorite: async ({ name, favorite }) => {
      const want = Boolean(favorite);
      const row = () => {
        const el = findItem(name);
        return el && !el.querySelector('[role="treeitem"]') ? el : null;
      };
      if (!row()) return { ok: false, error: `« ${name} » absente de la liste` };
      if (inFavorites(row()) === want) return { ok: true, already: true };
      const close = () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      const fail = (error) => {
        close();
        close();
        return { ok: false, error };
      };
      const item = row();
      item.scrollIntoView({ block: "nearest" });
      const r = item.getBoundingClientRect();
      item.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, view: window, button: 2, clientX: r.x + 20, clientY: r.y + 10 })
      );
      const inMenu = (sel) => Array.from(document.querySelectorAll(`[role="menu"] :is(${sel})`)).find(visible) || null;
      if (want) {
        if (!seen("fav_move", await waitFor(() => inMenu(LM.fav_move), 2000))) return fail("entrée « Déplacer vers la section » introuvable");
        const folder = norm(favFolderName());
        if (!folder) return fail("section Favoris absente de la liste Teams");
        const move = inMenu(LM.fav_move);
        const section = () => Array.from(document.querySelectorAll(`[role="menu"] :is(${LM.fav_section})`)).find((el) => norm(label(el)) === folder) || null;
        // Le sous-menu s'ouvre au survol ou au clic, selon la version de Teams.
        for (const act of [
          () => move.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, view: window })),
          () => move.click(),
          () => move.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", keyCode: 39, bubbles: true })),
        ]) {
          if (section()) break;
          act();
          await waitFor(section, 1200);
        }
        if (!seen("fav_section", section())) return fail(`entrée « ${favFolderName()} » introuvable dans « Déplacer vers la section »`);
        section().click();
      } else {
        if (!seen("fav_remove", await waitFor(() => inMenu(LM.fav_remove), 2000))) return fail("entrée « Supprimer de la section » introuvable");
        inMenu(LM.fav_remove).click();
      }
      if (await waitFor(() => Boolean(row()) && inFavorites(row()) === want, 4000)) return { ok: true };
      return { ok: false, error: want ? "toujours hors des Favoris après le clic" : "toujours dans les Favoris après le clic" };
    },
    // Teams ne dessine que les derniers messages, et retire du DOM ceux qui sortent de
    // l'écran. Pour remonter plus loin, on fait défiler le fil vers le haut en cumulant
    // ce qui passe, jusqu'à `last` messages ou le début de la conversation, puis on
    // revient en bas. `top` : le début de la conversation a été atteint. Avec `since`
    // (epoch ms), on remonte jusqu'au premier message plus ancien que cette date et l'on
    // ne garde que les plus récents : un message sans date lisible est conservé.
    read: async ({ last = 30, since = null }) => {
      const snap = () =>
        Array.from(document.querySelectorAll(MSGS)).map((el) => {
          const { text: body, links, cards, quote, mentions } = partsOf(el);
          const time = el.querySelector("time");
          const at = time?.innerText?.trim() || time?.getAttribute("datetime") || "";
          const ts = Date.parse(time?.getAttribute("datetime") || "");
          const files = filesOf(el);
          const names = new Set(files.map((f) => f.name));
          // Le nom d'un fichier joint fait aussi partie du texte : il est déjà dans sa puce.
          const text = body
            .split("\n")
            .filter((line) => !names.has(line.trim()))
            .join("\n")
            .replace(/\s+\n/g, "\n")
            .trim();
          const images = imagesOf(el).length;
          const id = el.querySelector('[id^="content-"]')?.id || el.getAttribute("data-mid") || el.id || "";
          return {
            key: id || `${time?.getAttribute("datetime") || at}|${text.slice(0, 80)}|${files.map((f) => f.name).join("|")}`,
            who: el.querySelector('[data-tid="message-author-name"]')?.innerText?.trim() || "",
            text,
            at,
            mid: msgId(el),
            status: statusOf(el),
            reactions: myReactions(el),
            files,
            images,
            links,
            cards,
            quote,
            mentions,
            edited: Boolean(el.querySelector('[data-tid*="edited" i]')),
            ts: Number.isNaN(ts) ? null : ts,
          };
        })
        // Teams intercale des éléments vides (avatar seul) : sans texte, fichier ni image,
        // ils se ressembleraient tous et fausseraient la fusion.
        .filter((m) => m.text || m.files.length || m.images || m.cards.length);
      const box = (() => {
        for (let el = document.querySelector(MSGS); el && el !== document.body; el = el.parentElement) {
          if (el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
        }
        return null;
      })();
      // Plus ancien message daté déjà lu : au-delà de `since`, inutile de remonter.
      const pastSince = (acc) => since != null && acc.some((m) => m.ts != null && m.ts < since);
      const { acc, top } = await climb(box, snap, (acc) => acc.length >= last || pastSince(acc), late);
      // L'auteur n'est affiché qu'en tête d'une suite de messages : on le reporte.
      let sender = "";
      const out = [];
      for (const m of acc) {
        if (m.who) sender = m.who;
        if (since != null && m.ts != null && m.ts < since) continue;
        out.push({ sender, text: m.text, at: m.at, id: m.mid, status: m.status, reactions: m.reactions, files: m.files, key: m.key, images: m.images, links: m.links, cards: m.cards, quote: m.quote, mentions: m.mentions, edited: m.edited });
      }
      const shown = out.slice(-last);
      await thumbnails(shown);
      return { messages: shown.map(({ key, ...m }) => m), top, meeting: meetingInfo() };
    },
    type: async ({ name, text, send, quote, mentions, files }) => {
      if (mentions && mentions.length) {
        if (Array.isArray(files) && files.length) return { ok: false, error: "pièce jointe et mention dans le même message non prises en charge" };
        return typeWithMentions({ name, text, send, quote, mentions });
      }
      if (!isOpen(name)) return { ok: false, error: "autre conversation ouverte" };
      let box = editor();
      if (!box) return { ok: false, error: "zone de saisie introuvable" };
      if (box.innerText.trim()) return notEmpty(box);
      const withFiles = Array.isArray(files) && files.length > 0;
      if (withFiles && !send) return { ok: false, error: "pièce jointe sans envoi refusée" };
      if (withFiles && removeButtons(composeRoot(box)).length) {
        return { ok: false, error: "une pièce jointe attend déjà dans la zone de saisie de Teams" };
      }
      const fail = async (error) => {
        if (quote) unquote(box);
        clear(box);
        if (withFiles) await dropLateAttachments(box);
        return { ok: false, error };
      };
      if (quote) {
        const why = await quoteMessage(quote, box);
        if (why) return fail(why);
        if (!isOpen(name)) return fail("conversation changée pendant la citation");
        box = editor() || box;
      }
      let joined = "";
      if (withFiles) {
        const got = await attach(box, files);
        if (!got) return fail("Teams n'a pas pris la pièce jointe (menu Joindre, champ fichier, dépôt et collage essayés)");
        if (got.error) return fail(`pièce jointe : ${got.error}`);
        joined = `, pièce jointe : ${got.how}`;
        if (!isOpen(name)) return fail("conversation changée pendant l'ajout de la pièce jointe");
        box = editor() || box;
      }
      const how = text ? await insert(box, text) : "aucun texte";
      if (!how) return fail(`texte non inséré (focus : ${document.hasFocus() ? "oui" : "non"})`);
      if (!send) return { ok: true };
      if (!isOpen(name)) return fail("conversation changée avant l'envoi");
      if (late()) return fail("délai dépassé avant l'envoi");
      const key = text ? flat(how === "code" ? shownOf(text) : text).slice(0, 40) : "";
      const before = lastMessages(3).filter((t) => t.includes(key)).length;
      // Avec des fichiers : preuve = messages apparus après le clic (ils n'étaient pas dans le
      // fil avant) qui montrent le texte et chaque fichier, lus comme la lecture les lit.
      const fresh = withFiles ? newMessages() : null;
      const names = withFiles ? files.map((f) => f.name) : [];
      const proof = () => {
        const els = fresh();
        const textShown = !key || els.some((el) => flat(el.innerText).includes(key));
        return { textShown: textShown && els.length > 0, missing: messageFiles.missing(names, els) };
      };
      // Teams active Envoyer une fois le texte pris en compte : lui laisser le temps.
      await waitFor(sendReady, 1500);
      const btn = sendButton();
      const via = sendReady() ? "bouton" : "Entrée";
      if (via === "bouton") btn.click();
      else box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      const trace = `saisie : ${how}${joined}, envoi : ${via}`;
      // Envoyé seulement si le message apparaît dans la conversation : une zone de saisie
      // vidée ne prouve rien (page gelée, éditeur réinitialisé).
      const shown = withFiles
        ? await waitFor(() => {
            const p = proof();
            return p.textShown && !p.missing.length;
          }, 15000)
        : await waitFor(() => lastMessages(3).filter((t) => t.includes(key)).length > before, 6000);
      if (shown) return { ok: true };
      if (withFiles) {
        // Le message est là : ses fichiers doivent l'être aussi, sinon pas de « envoyé ».
        const p = proof();
        if (p.textShown) {
          return { ok: false, uncertain: true, error: `message visible, pièce jointe non visible (${p.missing.join(", ")}) : vérifie dans Teams (${trace})` };
        }
      }
      if (box.innerText.trim() || modelText(box)) return fail(`envoi refusé par Teams (${trace})`);
      return { ok: false, uncertain: true, error: `message non visible dans la conversation, vérifie dans Teams (${trace})` };
    },
    react: async ({ name, message, reaction, remove }) => {
      if (!isOpen(name)) return { ok: false, error: "autre conversation ouverte" };
      if (!REACTION_NAMES[reaction]) return { ok: false, error: "réaction inconnue" };
      const off = remove === true;
      const found = await lookup(message);
      if (!found) return { ok: false, error: "message introuvable ou différent de celui choisi" };
      // Le bouton de Teams bascule : on ne clique que si la réaction n'est pas déjà dans l'état voulu.
      if (myReactions(found.el).includes(reaction) !== off) return { ok: true, already: true };
      const btn = await barAction(found.el, `message-actions-${reaction}`, (l) => reactionOf(l) === reaction);
      if (!btn) return { ok: false, error: "bouton de réaction introuvable sur ce message" };
      if (!isOpen(name)) return { ok: false, error: "conversation changée avant la réaction" };
      if (late()) return { ok: false, error: "délai dépassé avant la réaction" };
      press(btn);
      unhover();
      // Posée (ou retirée) seulement si Teams l'affiche (ou ne l'affiche plus) sous le message.
      const shown = await waitFor(() => {
        const again = findMessage(message);
        return Boolean(again && myReactions(again.el).includes(reaction) !== off);
      }, 5000);
      toBottom();
      if (shown) return { ok: true };
      return { ok: false, uncertain: true, error: off ? "réaction toujours visible sous le message, vérifie dans Teams" : "réaction non visible sous le message, vérifie dans Teams" };
    },
    // Réaction 🤖 sur le dernier message de la conversation (best-effort).
    react: async ({ name }) => {
      if (!isOpen(name)) return { ok: false, error: "autre conversation ouverte" };
      const msgs = document.querySelectorAll(MSGS);
      const last = msgs[msgs.length - 1];
      if (!last) return { ok: false, error: "aucun message" };
      last.scrollIntoView({ block: "nearest" });
      await sleep(100);
      const rect = last.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const hoverOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
      for (const type of ["pointerenter", "pointerover", "pointermove", "mouseenter", "mouseover", "mousemove"]) {
        const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        last.dispatchEvent(new Ctor(type, { ...hoverOpts, isPrimary: true }));
      }
      const moreBtn = await waitFor(() => {
        for (const sel of [
          'button[data-tid="reactions-add-emoji"]',
          'button[data-tid="message-actions-reaction-more"]',
          'button[aria-label*="Plus de" i][aria-label*="action" i]',
          'button[aria-label*="more" i][aria-label*="reaction" i]',
          'button[aria-label*="reaction" i]',
          'button[aria-label*="emoji" i]:not([data-tid*="send"])',
        ]) {
          const btn = document.querySelector(sel);
          if (btn && visible(btn)) return btn;
        }
        for (const tb of document.querySelectorAll('[role="toolbar"], [data-tid*="message-action"], [data-tid*="hover-menu"]')) {
          if (!visible(tb)) continue;
          const btns = Array.from(tb.querySelectorAll("button")).filter(visible);
          const hit = btns.find((b) => /emoji|réaction|reaction|smiley/i.test(b.getAttribute("aria-label") || ""));
          if (hit) return hit;
        }
        return null;
      }, 3000);
      if (!moreBtn) return { ok: false, error: "bouton de réaction introuvable" };
      moreBtn.click();
      await sleep(200);
      const search = await waitFor(() => {
        for (const sel of [
          'input[data-tid="emoji-search"]',
          'input[aria-label*="emoji" i]',
          'input[aria-label*="Rechercher" i]',
          'input[aria-label*="Search" i]',
          'input[placeholder*="emoji" i]',
          'input[type="search"]',
          '[role="dialog"] input, [role="menu"] input',
        ]) {
          for (const el of document.querySelectorAll(sel)) if (visible(el)) return el;
        }
        return null;
      }, 3000);
      if (!search) return { ok: false, error: "recherche d'emoji introuvable" };
      search.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
                  || Object.getOwnPropertyDescriptor(HTMLElement.prototype, "value")?.set;
      if (setter) setter.call(search, "robot");
      else search.value = "robot";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      search.dispatchEvent(new Event("change", { bubbles: true }));
      const robot = await waitFor(() => {
        for (const sel of [
          '[role="gridcell"] button',
          '[data-tid*="emoji"] button',
          '[role="option"]',
          '[role="listbox"] button',
          'button[aria-label*="robot" i]',
          'button[title*="robot" i]',
        ]) {
          const hit = Array.from(document.querySelectorAll(sel)).find(visible);
          if (hit) return hit;
        }
        return null;
      }, 3000);
      if (!robot) return { ok: false, error: "emoji robot introuvable" };
      robot.click();
      return { ok: true };
    },
    // Supprime un de TES messages : retrouvé par son id, son auteur, son texte et son heure,
    // « Modifier » présent dans sa barre (message à toi), puis « … » → « Supprimer » et la
    // confirmation de Teams si elle s'affiche. Fait seulement quand Teams le montre supprimé.
    delete: async ({ name, message }) => {
      if (!isOpen(name)) return { ok: false, error: "autre conversation ouverte" };
      const found = await lookup(message);
      if (!found || !found.id) return { ok: false, error: "message introuvable ou différent de celui choisi : rien n'a été supprimé" };
      if (isDeleted(found.el)) return { ok: false, error: "message déjà supprimé" };
      const at = flat(found.el.querySelector("time")?.innerText || "");
      if (message.at && at && norm(at) !== norm(message.at)) {
        unhover();
        toBottom();
        return { ok: false, error: "heure du message différente de celle choisie : rien n'a été supprimé" };
      }
      const fail = (error) => {
        escape();
        unhover();
        toBottom();
        return { ok: false, error };
      };
      const edit = await barAction(found.el, "message-actions-edit", isEdit);
      if (!edit) return fail("ce message n'est pas à toi (pas de « Modifier » dans Teams) : rien n'a été supprimé");
      const more = await barAction(found.el, "message-actions-more", () => false);
      if (!more) return fail("menu « Autres options » introuvable sur ce message");
      more.click();
      let entry = null;
      if (!seen("delete_entry", await waitFor(() => (entry = deleteEntry()), 1500))) return fail("« Supprimer » introuvable dans le menu du message");
      // Rien n'a bougé entre-temps : même conversation, même message sous la souris.
      if (!isOpen(name)) return fail("conversation changée avant la suppression");
      const again = findMessage(message);
      if (!again || again.id !== found.id) return fail("message changé avant la suppression");
      if (late()) return fail("délai dépassé avant la suppression");
      press(entry);
      const mid = found.id;
      const done = () => isDeleted(byId(mid));
      // Teams demande parfois confirmation : on clique son « Supprimer », pour ce seul message.
      await waitFor(() => done() || Boolean(confirmDelete()), 2500);
      const ok = confirmDelete();
      if (ok && !done()) press(ok);
      const shown = await waitFor(done, 6000);
      unhover();
      toBottom();
      return shown ? { ok: true } : { ok: false, uncertain: true, error: "message non affiché comme supprimé, vérifie dans Teams" };
    },
    // Modifie un de TES messages en texte simple : retrouvé comme pour supprimer, « Modifier »
    // dans sa barre (message à toi), puis le texte remplacé dans l'éditeur que Teams ouvre et
    // validé. Fait seulement quand Teams montre le nouveau texte à la place de l'ancien.
    edit: async ({ name, message, text }) => {
      const want = String(text || "").trim();
      if (!want) return { ok: false, error: "message vide : rien n'a été modifié" };
      if (!isOpen(name)) return { ok: false, error: "autre conversation ouverte" };
      const found = await lookup(message);
      if (!found || !found.id) return { ok: false, error: "message introuvable ou différent de celui choisi : rien n'a été modifié" };
      if (isDeleted(found.el)) return { ok: false, error: "message supprimé : rien n'a été modifié" };
      const fail = (error) => {
        escape();
        unhover();
        toBottom();
        return { ok: false, error };
      };
      if (found.el.querySelector(QUOTE_SEL) || found.el.querySelector('[itemtype*="Mention" i], [data-tid*="mention" i]'))
        return fail("message avec citation ou mention : modifie-le dans Teams");
      const btn = await barAction(found.el, "message-actions-edit", isEdit);
      if (!btn) return fail("ce message n'est pas à toi (pas de « Modifier » dans Teams) : rien n'a été modifié");
      if (!isOpen(name)) return fail("conversation changée avant la modification");
      if (late()) return fail("délai dépassé avant la modification");
      const mid = found.id;
      press(btn);
      // L'éditeur de modification s'ouvre dans le message lui-même.
      const box = () => {
        const el = byId(mid);
        return (el && Array.from(el.querySelectorAll('[contenteditable="true"]')).find(visible)) || null;
      };
      let ed = null;
      if (!(await waitFor(() => (ed = box()), 3000))) return fail("éditeur de modification introuvable : rien n'a été modifié");
      clear(ed);
      const how = await insert(ed, want);
      const same = (a) => norm(flat(a)).replace(/\s*(modifie|edited)$/, "") === norm(flat(want));
      if (!how || !same(ed.innerText)) {
        escape(); // annule la modification dans Teams : l'ancien texte reste
        return fail("texte non saisi dans l'éditeur de Teams : rien n'a été modifié");
      }
      const done = Array.from(byId(mid)?.querySelectorAll(ACTIONABLE) || []).find(
        (b) => visible(b) && /^(done|termine|enregistrer|save)\b/.test(norm(label(b) || b.getAttribute("title") || ""))
      );
      if (done) press(done);
      else ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
      const shown = await waitFor(() => {
        const el = byId(mid);
        return Boolean(el && !box() && same(bodyOf(el)));
      }, 6000);
      unhover();
      toBottom();
      return shown ? { ok: true } : { ok: false, uncertain: true, error: "nouveau texte non affiché dans Teams, vérifie avant de recommencer" };
    },
    // Sa photo de profil, celle du bouton du profil (en haut à droite) : redessinée en
    // 96 px. Sans photo, Teams met des initiales sans <img> : rien à renvoyer.
    myphoto: async () => {
      const trigger = document.querySelector(ME);
      if (!trigger) return { ok: false, error: "bouton du profil introuvable dans Teams" };
      const img = trigger.querySelector("img");
      if (!img || !(await waitFor(() => img.complete && img.naturalWidth > 0, 3000))) return { ok: true, photo: null };
      const draw = (source) => {
        const c = document.createElement("canvas");
        c.width = c.height = 96;
        c.getContext("2d").drawImage(source, 0, 0, 96, 96);
        return c.toDataURL("image/jpeg", 0.85);
      };
      try {
        return { ok: true, photo: draw(img) };
      } catch {
        // Image d'un autre domaine (canvas « tainted ») : la relire dans la page, avec sa session.
        try {
          const res = await fetch(img.currentSrc || img.src, { credentials: "include" });
          if (!res.ok) return { ok: true, photo: null };
          return { ok: true, photo: draw(await createImageBitmap(await res.blob())) };
        } catch {
          return { ok: true, photo: null };
        }
      }
    },
    mystatus: async ({ message } = {}) => {
      if (!document.querySelector(ME)) return { ok: false, error: "bouton du profil introuvable dans Teams" };
      if (!message) return { ok: true, labels: myLabels() };
      try {
        const note = await readNote();
        if (note === null) return { ok: false, error: "menu du profil non ouvert", labels: myLabels() };
        return { ok: true, labels: myLabels(), message: note };
      } finally {
        await closeMeMenu();
      }
    },
    // Un statut du menu de Teams. Rien n'est saisi : deux clics (« Modifier l'état », le
    // choix), puis on attend que le bouton du profil change ; le moteur compare.
    // Un statut pour une durée : « Modifier l'état », « Durée », puis dans ce panneau la
    // liste « Statut » et la liste « Rétablir le statut après », chacune vérifiée par son
    // libellé avant « Terminé ». Au moindre doute, « Précédent » : rien n'est changé.
    // « custom » : jusqu'à date (AAAA-MM-JJ) et time (HH:MM, heure locale), saisis puis
    // relus dans le panneau. dry : essai à blanc, tout est rempli et vérifié, puis
    // « Précédent » au lieu de « Terminé ».
    setstatusfor: async ({ choice, duration, date, time, dry }) => {
      const index = STATUS_ORDER.indexOf(choice);
      const d = DURATION_ORDER.indexOf(duration);
      if (index < 0 || d < 0) return { ok: false, error: "statut ou durée inconnus" };
      let day = null;
      let at = null;
      if (duration === "custom") {
        const [y, m, dd] = String(date || "").split("-").map(Number);
        const [hh, mm] = String(time || "").split(":").map(Number);
        at = new Date(y, m - 1, dd, hh, mm);
        if (Number.isNaN(at.getTime()) || at.getDate() !== dd || at.getHours() !== hh || at.getMinutes() !== mm)
          return { ok: false, error: "date ou heure de fin invalide" };
        if (at.getTime() <= Date.now()) return { ok: false, error: "heure de fin déjà passée" };
        day = new Date(y, m - 1, dd);
      }
      if (!document.querySelector(ME)) return { ok: false, error: "bouton du profil introuvable dans Teams" };
      const before = myLabels().join("|");
      const back = async (error) => {
        firstVisible(AVAIL_BACK)?.click();
        await sleep(300);
        return { ok: false, error };
      };
      // Choisit l'option n° i d'une liste du panneau, si son libellé est bien celui attendu.
      const pick = async (combo, i, expected) => {
        const options = () => Array.from(document.querySelectorAll('[role="option"]')).filter(visible);
        // Teams redessine le panneau après un choix : on attend que la liste précédente
        // soit refermée et que celle-ci soit là.
        await waitFor(() => !options().length && visible(document.getElementById(combo)), 3000);
        const box = document.getElementById(combo);
        if (!seen("duration_lists", box && visible(box))) return `liste « ${combo} » introuvable`;
        box.click();
        if (!(await waitFor(() => options().length > i, 2000))) return "choix absents de la liste de Teams";
        // La liste s'ouvre en glissant : un clic pendant l'animation referme tout le menu
        // (constaté quand la fenêtre de Teams n'a pas le focus).
        await sleep(400);
        const opt = options()[i];
        if (!expected.test(norm(label(opt)))) {
          box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
          return `choix inattendu « ${label(opt)} »`;
        }
        opt.click();
        if (!(await waitFor(() => expected.test(norm(label(document.getElementById(combo)))), 2000))) return "choix non pris en compte par Teams";
        return null;
      };
      // Le jour dans le calendrier (mois suivant / précédent jusqu'au bon), puis l'heure
      // dans la liste : l'option dont la valeur est exactement l'instant voulu. Les deux
      // sont relus dans le panneau ; sinon, la raison.
      const calendar = () =>
        Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible).find((x) => x.querySelector('[role="grid"]')) || null;
      const isDay = (b) => {
        const [n, month, year] = (b.getAttribute("aria-label") || "").split(",").map((s) => s.trim());
        return Number(n) === day.getDate() && monthOf(month) === day.getMonth() && Number(year) === day.getFullYear();
      };
      const pickDay = async () => {
        if (!seen("expiry_date", await waitFor(() => firstVisible(AVAIL_DATE), 3000))) return "champ de date introuvable";
        if (firstVisible(AVAIL_DATE).value === day.toDateString()) return null;
        firstVisible(AVAIL_DATE).click();
        if (!(await waitFor(calendar, 2000))) return "calendrier de Teams non ouvert";
        await sleep(400);
        const target = day.getFullYear() * 12 + day.getMonth();
        for (let i = 0; i < 14; i++) {
          const cal = calendar();
          if (!cal) return "calendrier de Teams refermé";
          const btn = Array.from(cal.querySelectorAll('tr:not([aria-hidden="true"]) [role="gridcell"] button')).find(isDay);
          if (btn) {
            if (btn.disabled || btn.closest('[aria-disabled="true"]')) return "jour refusé par Teams";
            btn.click();
            break;
          }
          const head = cal.querySelector('[role="grid"]').getAttribute("aria-label") || "";
          const [month, year] = norm(head).split(",")[0].split(" ");
          const shown = Number(year) * 12 + monthOf(month);
          if (Number.isNaN(shown) || monthOf(month) < 0) return "mois du calendrier illisible";
          const nav = Array.from(cal.querySelectorAll("button[title]")).find((b) =>
            (target > shown ? /suivant|next/ : /precedent|previous/).test(norm(b.title))
          );
          if (!nav || nav.getAttribute("aria-disabled") === "true") return "mois hors du calendrier de Teams";
          nav.click();
          // Le calendrier glisse vers l'autre mois : son titre change tout de suite, mais un
          // clic pendant l'animation se perd.
          await waitFor(() => (calendar()?.querySelector('[role="grid"]')?.getAttribute("aria-label") || "") !== head, 1500);
          await sleep(700);
        }
        if (!(await waitFor(() => !calendar() && firstVisible(AVAIL_DATE)?.value === day.toDateString(), 2000)))
          return "jour non pris en compte par Teams";
        return null;
      };
      const pickTime = async () => {
        const list = () => firstVisible(AVAIL_TIME);
        const shows = () => Number(list()?.value) === at.getTime();
        if (!seen("expiry_time", await waitFor(list, 2000))) return "liste des heures introuvable";
        const opt = Array.from(list().options).find((o) => Number(o.value) === at.getTime());
        if (!opt) return `heure ${time} absente de la liste de Teams`;
        if (!shows()) {
          // Liste pilotée par React : la valeur passe par le setter natif, puis « change ».
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(list(), opt.value);
          list().dispatchEvent(new Event("change", { bubbles: true }));
        }
        await sleep(300);
        if (!(await waitFor(shows, 2000))) return "heure non prise en compte par Teams";
        return null;
      };
      const expiry = async () => {
        const why = (await pickDay()) || (await pickTime());
        if (why) return why;
        // Relecture des deux après coup : changer le jour redessine la liste des heures.
        await sleep(300);
        if (firstVisible(AVAIL_DATE)?.value !== day.toDateString() || Number(firstVisible(AVAIL_TIME)?.value) !== at.getTime())
          return "date ou heure de fin changée par Teams";
        return null;
      };
      try {
        if (!(await openMeMenu())) return { ok: false, error: "menu du profil non ouvert" };
        const durationEntry = () => firstVisible(DURATION_ENTRY);
        if (!durationEntry()) {
          const sub = firstVisible(STATUS_ENTRY);
          if (!seen("status_entry", sub)) return { ok: false, error: "entrée « Modifier l'état » introuvable dans le menu du profil" };
          sub.click();
          if (!seen("duration_entry", await waitFor(durationEntry, 3000))) return { ok: false, error: "entrée « Durée » absente du menu de Teams" };
        }
        durationEntry().click();
        if (!seen("duration_panel", await waitFor(() => firstVisible(AVAIL_DONE), 3000))) return { ok: false, error: "panneau « Durée » non ouvert" };
        const why =
          (await pick(AVAIL_STATUS, index, STATUS_WORDS[choice])) ||
          (await pick(AVAIL_AFTER, d, DURATION_WORDS[duration])) ||
          (day ? await expiry() : null);
        if (why) return back(why);
        if (late()) return back("commande expirée");
        const done = firstVisible(AVAIL_DONE);
        if (!done || done.disabled || done.getAttribute("aria-disabled") === "true") return back("bouton « Terminé » inactif");
        if (dry) {
          const shown = {
            status: label(document.getElementById(AVAIL_STATUS)),
            after: label(document.getElementById(AVAIL_AFTER)),
            date: firstVisible(AVAIL_DATE)?.value || "",
            time: firstVisible(AVAIL_TIME)?.selectedOptions[0]?.text || "",
          };
          await back("essai à blanc");
          return { ok: true, dry: true, shown, back: !firstVisible(AVAIL_DONE) };
        }
        done.click();
        await waitFor(() => !firstVisible(AVAIL_DONE), 4000);
        await waitFor(() => myLabels().join("|") !== before, 4000);
        await sleep(300);
      } finally {
        await closeMeMenu();
      }
      return { ok: true, labels: myLabels() };
    },
    setstatus: async ({ choice }) => {
      const tid = STATUS_TIDS[choice];
      if (!tid) return { ok: false, error: `statut inconnu : ${choice}` };
      if (!document.querySelector(ME)) return { ok: false, error: "bouton du profil introuvable dans Teams" };
      const before = myLabels().join("|");
      try {
        if (!(await openMeMenu())) return { ok: false, error: "menu du profil non ouvert" };
        const entry = () => firstVisible(`[data-tid="${tid}"]`);
        if (!entry()) {
          const sub = firstVisible(STATUS_ENTRY);
          if (!seen("status_entry", sub)) return { ok: false, error: "entrée « Modifier l'état » introuvable dans le menu du profil" };
          sub.click();
          if (!seen("status_choice", await waitFor(entry, 3000))) return { ok: false, error: "choix de statut absents du menu de Teams" };
        }
        if (late()) return { ok: false, error: "commande expirée" };
        entry().click();
        await waitFor(() => myLabels().join("|") !== before, 4000);
        await sleep(300);
      } finally {
        await closeMeMenu();
      }
      return { ok: true, labels: myLabels() };
    },
    // Message de statut : vide, le bouton « Supprimer » ; sinon « Modifier », le texte
    // dans l'éditeur du message, vérifié, puis « Terminé ». On relit ensuite ce que
    // Teams affiche. En cas de doute avant « Terminé », retour arrière sans enregistrer.
    setnote: async ({ text }) => {
      const want = flat(text);
      try {
        if (!(await openMeMenu())) return { ok: false, error: "menu du profil non ouvert" };
        await waitFor(() => document.querySelector(NOTE) || firstVisible(NOTE_EDIT), 1500);
        if (!want) {
          const clear = firstVisible(NOTE_CLEAR);
          if (clear) {
            clear.click();
            await waitFor(() => !noteText(), 3000);
          }
        } else {
          if (noteText() === want) return { ok: true, message: want };
          const edit = firstVisible(NOTE_EDIT);
          if (!seen("note_edit", edit)) return { ok: false, error: "bouton « Définir le message de statut » introuvable" };
          edit.click();
          const box = () => firstVisible(`${NOTE_PANEL} [contenteditable="true"]`);
          if (!(await waitFor(box, 3000))) return { ok: false, error: "zone du message de statut introuvable" };
          const back = async (error) => {
            firstVisible(NOTE_BACK)?.click();
            await sleep(300);
            return { ok: false, error };
          };
          const ed = cke(box());
          if (!ed) return back("éditeur du message de statut illisible");
          ed.setData("");
          typeInModel(box(), want);
          if (modelText(box()) !== want) return back("texte non saisi dans le message de statut");
          const done = firstVisible(NOTE_DONE);
          if (!done || done.disabled || done.getAttribute("aria-disabled") === "true") return back("bouton « Terminé » inactif");
          if (late()) return back("commande expirée");
          done.click();
          await waitFor(() => !firstVisible(NOTE_PANEL), 4000);
        }
        // Teams peut refermer le menu après « Terminé » : on le rouvre pour relire.
        const note = await readNote();
        if (note === null) return { ok: false, error: "message de statut non relu" };
        return { ok: true, message: note };
      } finally {
        await closeMeMenu();
      }
    },
    // Vider la zone de saisie de la conversation ouverte, à la demande explicite de
    // l'utilisateur : texte, pièces jointes en attente, éléments collés. Réussi seulement
    // quand la zone est vraiment vide.
    clearcompose: async ({ name }) => {
      if (!isOpen(name)) return { ok: false, error: "autre conversation ouverte" };
      const box = editor();
      if (!box) return { ok: false, error: "zone de saisie introuvable" };
      const empty = () => {
        const st = composeState(box);
        return !st.text && !st.files.length && !st.objects && !box.innerText.trim();
      };
      if (empty()) return { ok: true, already: true };
      // Le brouillon gardé par Teams (image collée…) est rejeté aussi : sinon il revient.
      await discardDraft();
      const end = Date.now() + 5000;
      while (Date.now() < end && !empty()) {
        clear(box);
        dropAttachments(box);
        await sleep(400);
      }
      if (empty()) return { ok: true };
      const st = composeState(box);
      return { ok: false, error: `zone de saisie toujours occupée (${[st.text && "texte", st.files.length && "pièce jointe", st.objects && "élément collé"].filter(Boolean).join(", ") || "inconnu"})` };
    },
    // Réunions de la conversation ouverte : une carte « récapitulatif » par occurrence
    // terminée (titre, date, et si une transcription y figure).
    recaps: () => ({ title: document.title, recaps: Array.from(document.querySelectorAll(RECAP_CARD)).map(recapInfo) }),
    // Transcription d'une occurrence : « Afficher le résumé » de sa carte, onglet
    // « Transcript », puis l'iframe SharePoint relit la liste (agent de frame plus haut).
    // On revient ensuite sur l'onglet Conversation. Rien n'est écrit ni démarré.
    transcript: async ({ mid, probe }) => {
      const card = Array.from(document.querySelectorAll(RECAP_CARD)).find((c) => recapInfo(c).mid === String(mid));
      if (!card) return { ok: false, reason: "not_found", error: "carte de la réunion absente de la conversation" };
      const info = recapInfo(card);
      if (!info.transcript && !probe) return { ok: false, reason: "none", ...info };
      const view = card.querySelector('[data-testid="meeting-recap-chiclet-view-recap-button"]');
      if (!view) return { ok: false, reason: "not_found", error: "bouton « Afficher le résumé » introuvable" };
      view.click();
      try {
        if (!(await waitFor(() => transcriptTab(), 15000))) return { ok: false, reason: "none", ...info, error: "pas d'onglet Transcript dans le récapitulatif" };
        transcriptTab().click();
        if (!(await waitFor(() => recapFrame()?.contentWindow, 20000))) return { ok: false, reason: "frame", ...info, error: "iframe de la transcription absente" };
        recapFrame().scrollIntoView({ block: "start" });
        const res = await askFrame(probe ? "probe" : "collect", Math.max(5000, (deadline || Date.now() + 60000) - Date.now() - 3000));
        return { ...info, recap_when: recapWhen(), ...res };
      } finally {
        document.querySelector('[role="tab"][data-tid="tab-item-com.microsoft.chattabs.chat"]')?.click();
      }
    },
    diagnose: async () => {
      // Auto-test de signature : rejoue signée une sonde GET sûre vers un hôte REST. On ne
      // garde QUE le statut (jamais le corps) : 200 = la signature en page fonctionne, 401 =
      // non. Au plus une fois par minute, et seulement si une sonde a été observée.
      try {
        const url = apiCapture.safeProbe();
        if (url && (!lastSignTest || Date.now() - lastSignTest.at > 60000)) {
          const r = await ops.webfetch({ url, method: "GET", sign: true, json: false });
          // `source` : d'où venait le jeton rejoué (endpoint exact / hôte / aucun). Diagnostic.
          lastSignTest = { ok: Boolean(r && r.ok), status: (r && r.status) || 0, source: apiCapture.credsSource(url), at: Date.now() };
        }
      } catch (e) {
        lastSignTest = { error: String((e && e.message) || e), at: Date.now() };
      }
      // Auto-test du service de chat (statut, étape et région seulement ; jamais de corps).
      let chatTest = chatsvc.last();
      try {
        // Borné : diagnose répond en moins de 6 s même si le service de chat traîne.
        chatTest = (await Promise.race([chatsvc.selftest(), sleep(3500).then(() => null)])) || chatsvc.last();
      } catch {}
      return {
      url: location.href,
      title: document.title,
      compose: (() => {
        const e = editor();
        if (!e) return null;
        const st = composeState(e);
        return { text: st.text, files: st.files.length, objects: st.objects };
      })(),
      title_conversation: titleName(),
      rail: Boolean(rail()),
      items: items().length,
      sample: items().slice(0, 6).map((el) => label(el).split(/\s+/).slice(0, 3).join(" ")),
      own_status: myLabels(),
      presence_sample: items().slice(0, 6).map((el) => presenceOf(el).filter((t) => t.split(" ").length <= 4)),
      editor: Boolean(editor()),
      editor_info: (() => {
        const e = editor();
        return e ? { tag: e.tagName, tid: e.getAttribute("data-tid") || "", role: e.getAttribute("role") || "", filled: Boolean(e.innerText.trim()) } : null;
      })(),
      textboxes: document.querySelectorAll('[contenteditable="true"]').length,
      has_focus: document.hasFocus(),
      visibility: document.visibilityState,
      send_button: Boolean(sendButton()),
      new_chat_button: Boolean(Array.from(document.querySelectorAll(NEW_CHAT)).find(visible)),
      send_ready: sendReady(),
      file_inputs: document.querySelectorAll('input[type="file"]').length,
      compose_root: Boolean(editor() && composeRoot(editor())),
      ckeditor: Boolean(editor() && cke(editor())),
      editor_model: (() => {
        const e = editor();
        const known = e ? modelText(e) : null;
        return known === null ? "illisible" : known ? "rempli" : "vide";
      })(),
      messages: document.querySelectorAll('[data-tid="chat-pane-item"], [role="main"] [role="list"] > [role="listitem"]').length,
      // API internes repérées (structure seule : ni jeton, ni paramètre, ni contenu).
      api_capture: apiCapture.summary(),
      // Empreinte du pont effectivement chargé (posée par l'hôte à l'injection) : permet de
      // voir si une page garde encore un ancien pont après une mise à jour.
      bridge: (typeof globalThis !== "undefined" && globalThis.__trameBridge) || null,
      // Auto-test de signature (statut seulement, jamais de corps) : 200 ⇒ la page signe bien.
      sign_selftest: lastSignTest,
      // Auto-test du service de chat : { ok, status, stage, region, at } ; ni jeton ni contenu.
      chatsvc_selftest: chatTest,
      };
    },
  };

  const api = Object.freeze({
    run: async (cmd) => {
      try {
        const op = ops[cmd.op];
        if (!op) throw new Error(`opération inconnue : ${cmd.op}`);
        if (cmd.deadline_ms && Date.now() > cmd.deadline_ms) throw new Error("commande expirée");
        // Le contrôle tourne à côté des autres opérations : il ne touche pas à leur délai.
        const own = op !== probe;
        if (own) {
          deadline = cmd.deadline_ms || 0;
          running++;
        }
        try {
          reply({ id: cmd.id, ok: true, result: await op(cmd.args || {}) });
        } finally {
          if (own) running--;
        }
      } catch (e) {
        reply({ id: cmd.id, ok: false, error: String((e && e.message) || e) });
      }
    },
  });
  Object.defineProperty(window, "__trame", { value: api, writable: false, configurable: false });
})();

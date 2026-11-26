(() => {
  if (window.top !== window || window.__trame) return;
  if (!/(^|\.)teams\.(microsoft|cloud\.microsoft)\.com$|^teams\.cloud\.microsoft$/.test(location.hostname)) return;
  const reply = (payload) => window.__TAURI_INTERNALS__.invoke("teams_bridge_reply", { payload });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el?.getAttribute?.("aria-label") || el?.innerText || "").replace(/\s+/g, " ").trim();
  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const rail = () => document.querySelector('[role="tree"]');
  const items = () => Array.from(rail()?.querySelectorAll('[role="treeitem"]') || []);
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
  const railItems = () =>
    items().map((el) => ({
      label: label(el),
      aria: el.getAttribute("aria-expanded") === "true" ? "expanded=true" : "",
      id: el.querySelector('[id*="19:"]')?.id || (el.id && el.id.includes("19:") ? el.id : ""),
      presence: presenceOf(el),
    }));
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
  const UNREAD = '[data-tid="unread"]';
  const READ_ENTRY = '[data-tid="change-read-status-menu-item"]';
  const sendReady = () => {
    const btn = sendButton();
    return Boolean(btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true");
  };
  const visible = (el) => Boolean(el && el.getClientRects().length);
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
  const sendButton = () =>
    document.querySelector('[data-tid="newMessageCommands-send"]') ||
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
  const insert = async (box, text) => {
    const key = flat(text).slice(0, 20);
    // Visible dans la zone ET connu de l'éditeur, quand son modèle est lisible.
    const ok = () => {
      if (!flat(box.innerText).includes(key)) return false;
      const known = modelText(box);
      return known === null || known.includes(key);
    };
    const tries = [
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
    for (const [name, run] of tries) {
      caretAtEnd(box);
      try {
        run();
      } catch {
        continue;
      }
      if (await waitFor(ok, 600)) return name;
      if (box.innerText.trim()) clear(box);
    }
    return null;
  };
  const NEW_CHAT = [
    '[data-tid="chat-list-new-chat-button"]',
    '[data-tid="new-chat-button"]',
    'button[aria-label^="New chat"]',
    'button[aria-label^="Nouvelle conversation"]',
  ].join(", ");
  const TO_FIELD = [
    '[data-tid="people-picker-input"]',
    'input[aria-label^="To"]',
    'input[aria-label^="À"]',
    'input[role="combobox"]',
  ].join(", ");
  // Recherche de Teams : champ du haut, page de résultats, bouton Conversation de la barre
  // d'applications pour en revenir (l'id est celui de l'application Conversation de Teams).
  const SEARCH_INPUT = '#ms-searchux-input, [data-tid="AUTOSUGGEST_INPUT"]';
  const CHAT_APP = [
    '[data-tid="app-bar-wrapper"] [data-tid="86fcd49b-61a2-4701-b771-54728cd291fb"]',
    '[data-tid="app-bar-wrapper"] [aria-label="Conversation"]',
    '[data-tid="app-bar-wrapper"] [aria-label="Chat"]',
  ].join(", ");
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
  const MSGS ='[data-tid="chat-pane-item"], [role="main"] [role="list"] > [role="listitem"]';
  const lastMessages = (n) => Array.from(document.querySelectorAll(MSGS)).slice(-n).map((el) => flat(el.innerText));
  let deadline = 0;
  const late = () => deadline && Date.now() > deadline;

  // --- Un message précis du fil : réagir, répondre ---
  const bodyOf = (el) =>
    (el.querySelector('[data-tid="chat-pane-message"]')?.innerText || el.querySelector('[id^="content-"]')?.innerText || "")
      .replace(REACTIONS, "")
      .replace(/\s+\n/g, "\n")
      .trim();
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
  const lookup = async (m) => {
    const found = findMessage(m);
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
    const btn = await barAction(found.el, "message-actions-quoted-reply", isReply);
    if (!btn) return "action « Répondre » introuvable sur ce message";
    press(btn);
    unhover();
    if (!(await waitFor(() => quoted(box, target.text), 2500))) return "citation du message non visible dans la zone de saisie";
    return null;
  };

  const ops = {
    ping: () => ({ title: document.title, ready: Boolean(rail()) }),
    title: () => document.title,
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
      button.click();
      const field = () => Array.from(document.querySelectorAll(TO_FIELD)).find(visible);
      if (!(await waitFor(() => field(), 4000))) return { ok: false, title: document.title, error: "champ « À » introuvable" };
      const input = field();
      const cancel = () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      input.focus();
      // Champ React : la valeur passe par le setter natif, sinon Teams ne la voit pas.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const n = norm(name);
      const matches = () =>
        Array.from(document.querySelectorAll('[role="listbox"] [role="option"]'))
          .filter(visible)
          .filter((o) => {
            const l = norm(label(o));
            return l === n || l.startsWith(n + " ");
          });
      await waitFor(() => matches().length > 0, 6000);
      const found = matches();
      if (found.length !== 1) {
        cancel();
        const error = found.length ? `${found.length} personnes nommées « ${name} » dans Teams` : `« ${name} » introuvable dans Teams`;
        return { ok: false, title: document.title, error };
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
        if (!(await waitFor(tab, 10000))) return { ok: false, error: "page de résultats de Teams non affichée" };
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
      if (!(await waitFor(entry, 2000))) {
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
    // Teams ne dessine que les derniers messages, et retire du DOM ceux qui sortent de
    // l'écran. Pour remonter plus loin, on fait défiler le fil vers le haut en cumulant
    // ce qui passe, jusqu'à `last` messages ou le début de la conversation, puis on
    // revient en bas. `top` : le début de la conversation a été atteint.
    read: async ({ last = 30 }) => {
      const snap = () =>
        Array.from(document.querySelectorAll(MSGS)).map((el) => {
          const body =
            el.querySelector('[data-tid="chat-pane-message"]')?.innerText ||
            el.querySelector('[id^="content-"]')?.innerText ||
            "";
          const time = el.querySelector("time");
          const at = time?.innerText?.trim() || time?.getAttribute("datetime") || "";
          const text = body.replace(REACTIONS, "").replace(/\s+\n/g, "\n").trim();
          const id = el.querySelector('[id^="content-"]')?.id || el.getAttribute("data-mid") || el.id || "";
          return {
            key: id || `${time?.getAttribute("datetime") || at}|${text.slice(0, 80)}`,
            who: el.querySelector('[data-tid="message-author-name"]')?.innerText?.trim() || "",
            text,
            at,
            mid: msgId(el),
            reactions: myReactions(el),
          };
        })
        // Teams intercale des éléments vides (avatar seul) : sans texte ni identifiant,
        // ils se ressembleraient tous et fausseraient la fusion.
        .filter((m) => m.text);
      // Fusion d'une vue plus haute dans ce qui est déjà lu : ce qui précède le premier
      // message connu est plus ancien. Vrai quand des messages ont été ajoutés.
      let acc = snap();
      const merge = () => {
        const known = new Set(acc.map((m) => m.key));
        const view = snap();
        const cut = view.findIndex((m) => known.has(m.key));
        const older = (cut < 0 ? view : view.slice(0, cut)).filter((m) => !known.has(m.key));
        if (older.length) acc = [...older, ...acc];
        return older.length > 0;
      };
      const box = (() => {
        for (let el = document.querySelector(MSGS); el && el !== document.body; el = el.parentElement) {
          if (el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
        }
        return null;
      })();
      let top = !box && acc.length < last;
      if (box && acc.length < last) {
        // Teams charge la suite quand on arrive en haut : on redescend un peu avant d'y
        // remonter, pour qu'il voie un défilement même si l'on y est déjà. Trois essais
        // sans rien de nouveau : c'est le début de la conversation. Une limite de temps
        // atteinte, elle, ne dit rien du début (top reste faux).
        const end = Date.now() + 20000;
        for (let stalls = 0; acc.length < last && Date.now() < end && !late(); ) {
          const height = box.scrollHeight;
          box.scrollTop = Math.min(200, height);
          await sleep(50);
          box.scrollTop = 0;
          if (await waitFor(() => merge() || box.scrollHeight !== height, 1500)) stalls = 0;
          else if (++stalls >= 3) {
            top = true;
            break;
          }
        }
        box.scrollTop = box.scrollHeight;
      }
      // L'auteur n'est affiché qu'en tête d'une suite de messages : on le reporte.
      let sender = "";
      const out = [];
      for (const m of acc) {
        if (m.who) sender = m.who;
        out.push({ sender, text: m.text, at: m.at, id: m.mid, reactions: m.reactions });
      }
      return { messages: out.slice(-last), top };
    },
    type: async ({ name, text, send, quote }) => {
      if (!isOpen(name)) return { ok: false, error: "autre conversation ouverte" };
      let box = editor();
      if (!box) return { ok: false, error: "zone de saisie introuvable" };
      if (box.innerText.trim()) return { ok: false, error: "zone de saisie non vide" };
      const fail = (error) => {
        if (quote) unquote(box);
        clear(box);
        return { ok: false, error };
      };
      if (quote) {
        const why = await quoteMessage(quote, box);
        if (why) return fail(why);
        if (!isOpen(name)) return fail("conversation changée pendant la citation");
        box = editor() || box;
      }
      const how = await insert(box, text);
      if (!how) return fail(`texte non inséré (focus : ${document.hasFocus() ? "oui" : "non"})`);
      if (!send) return { ok: true };
      if (!isOpen(name)) return fail("conversation changée avant l'envoi");
      if (late()) return fail("délai dépassé avant l'envoi");
      const key = flat(text).slice(0, 40);
      const before = lastMessages(3).filter((t) => t.includes(key)).length;
      // Teams active Envoyer une fois le texte pris en compte : lui laisser le temps.
      await waitFor(sendReady, 1500);
      const btn = sendButton();
      const via = sendReady() ? "bouton" : "Entrée";
      if (via === "bouton") btn.click();
      else box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      const trace = `saisie : ${how}, envoi : ${via}`;
      // Envoyé seulement si le message apparaît dans la conversation : une zone de saisie
      // vidée ne prouve rien (page gelée, éditeur réinitialisé).
      const shown = await waitFor(() => lastMessages(3).filter((t) => t.includes(key)).length > before, 6000);
      if (shown) return { ok: true };
      if (box.innerText.trim() || modelText(box)) return fail(`envoi refusé par Teams (${trace})`);
      return { ok: false, uncertain: true, error: `message non visible dans la conversation, vérifie dans Teams (${trace})` };
    },
    react: async ({ name, message, reaction }) => {
      if (!isOpen(name)) return { ok: false, error: "autre conversation ouverte" };
      if (!REACTION_NAMES[reaction]) return { ok: false, error: "réaction inconnue" };
      const found = await lookup(message);
      if (!found) return { ok: false, error: "message introuvable ou différent de celui choisi" };
      // Déjà là : cliquer à nouveau l'enlèverait.
      if (myReactions(found.el).includes(reaction)) return { ok: true, already: true };
      const btn = await barAction(found.el, `message-actions-${reaction}`, (l) => reactionOf(l) === reaction);
      if (!btn) return { ok: false, error: "bouton de réaction introuvable sur ce message" };
      if (!isOpen(name)) return { ok: false, error: "conversation changée avant la réaction" };
      if (late()) return { ok: false, error: "délai dépassé avant la réaction" };
      press(btn);
      unhover();
      // Posée seulement si Teams l'affiche sous le message.
      const shown = await waitFor(() => {
        const again = findMessage(message);
        return Boolean(again && myReactions(again.el).includes(reaction));
      }, 5000);
      return shown ? { ok: true } : { ok: false, uncertain: true, error: "réaction non visible sous le message, vérifie dans Teams" };
    },
    diagnose: () => ({
      url: location.href,
      title: document.title,
      title_conversation: titleName(),
      rail: Boolean(rail()),
      items: items().length,
      sample: items().slice(0, 6).map((el) => label(el).split(/\s+/).slice(0, 3).join(" ")),
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
      ckeditor: Boolean(editor() && cke(editor())),
      editor_model: (() => {
        const e = editor();
        const known = e ? modelText(e) : null;
        return known === null ? "illisible" : known ? "rempli" : "vide";
      })(),
      messages: document.querySelectorAll('[data-tid="chat-pane-item"], [role="main"] [role="list"] > [role="listitem"]').length,
    }),
  };

  const api = Object.freeze({
    run: async (cmd) => {
      try {
        const op = ops[cmd.op];
        if (!op) throw new Error(`opération inconnue : ${cmd.op}`);
        if (cmd.deadline_ms && Date.now() > cmd.deadline_ms) throw new Error("commande expirée");
        deadline = cmd.deadline_ms || 0;
        reply({ id: cmd.id, ok: true, result: await op(cmd.args || {}) });
      } catch (e) {
        reply({ id: cmd.id, ok: false, error: String((e && e.message) || e) });
      }
    },
  });
  Object.defineProperty(window, "__trame", { value: api, writable: false, configurable: false });
})();

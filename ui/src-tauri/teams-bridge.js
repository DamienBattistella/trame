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
  const removeButtons = (root) =>
    Array.from(root?.querySelectorAll("button[aria-label]") || []).filter((b) => REMOVE.test(b.getAttribute("aria-label") || ""));
  const uploading = (root) => Boolean(root?.querySelector('[role="progressbar"]'));
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
      [
        "champ fichier",
        () => {
          const input = fileInput(composeRoot(box));
          if (!input) throw new Error("pas de champ fichier");
          input.files = transfer().files;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
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
        run();
      } catch {
        continue;
      }
      if (await waitFor(listed, 5000)) {
        // Teams téléverse le fichier (OneDrive) avant de permettre l'envoi : on attend la
        // fin, en gardant de quoi envoyer et confirmer avant que le moteur abandonne.
        const end = Math.max(Date.now() + 1000, (deadline || Date.now() + 60000) - 20000);
        while (Date.now() < end && (uploading(composeRoot(box)) || !sendReady())) await sleep(300);
        if (uploading(composeRoot(box))) return { how, error: "téléversement toujours en cours" };
        return { how };
      }
    }
    return null;
  };
  const dropAttachments = (box) => removeButtons(composeRoot(box)).forEach((b) => b.click());
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

  // --- Pièces jointes reçues (lecture seule) ---
  // Fichier : une carte de « file-attachment-grid », nommée par son aria-label ; son titre
  // porte « nom + lien » (SharePoint / OneDrive). Trame n'en lit que le nom et le lien.
  const filesOf = (el) =>
    Array.from(el.querySelectorAll('[data-tid="file-attachment-grid"] [role="group"][aria-label]')).map((card) => {
      const title = card.querySelector('[data-testid="content-card-custom-title"]')?.getAttribute("aria-label") || "";
      const url = (title.match(/https:\/\/\S+/) || [""])[0];
      return { name: card.getAttribute("aria-label").trim(), url };
    });
  // Image : celles du corps du message (les émojis n'ont pas de data-gallery-src).
  const imagesOf = (el) =>
    Array.from(el.querySelectorAll('[data-tid="chat-pane-message"] img')).filter(
      (img) => img.getAttribute("data-gallery-src") || img.getAttribute("data-orig-src")
    );
  const THUMBS = { max: 8, width: 1024, budget: 3_000_000 };
  // Miniature JPEG d'une image déjà affichée par Teams (adresse blob: de la page) ;
  // null si elle n'est pas chargée ou pas lisible.
  const thumbnail = async (img) => {
    try {
      if (!img.complete || !img.naturalWidth) return null;
      const src = img.currentSrc || img.src;
      if (!src.startsWith("blob:") && new URL(src).origin !== location.origin) return null;
      const bitmap = await createImageBitmap(await (await fetch(src)).blob());
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
  // Après la lecture, seuls les messages encore affichés ont leurs images dans la page :
  // les plus récents d'abord, dans la limite du nombre et du poids. Les autres restent
  // « image » sans aperçu (à voir dans Teams).
  const thumbnails = async (messages) => {
    const byId = new Map();
    for (const el of document.querySelectorAll(MSGS)) {
      const id = el.querySelector('[id^="content-"]')?.id || el.getAttribute("data-mid") || el.id;
      if (id) byId.set(id, el);
    }
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

  // --- Mentions (@quelqu'un) ---
  // Teams n'ouvre ses suggestions de mention que sur une vraie frappe : les événements
  // fabriqués par un script sont ignorés. Trame tape « @Nom » par l'application
  // (teams_type_trusted, réservé à cette page), choisit la seule suggestion de ce nom,
  // et vérifie que l'éditeur contient bien une mention de plus.
  const MENTION_LIST = '[data-tid="AutocompletePopup-Mentions"]';
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
      closePopup();
      return `« ${who} » absent des suggestions de Teams (pas dans cette conversation ?)`;
    }
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
    if (box.innerText.trim()) return { ok: false, error: "zone de saisie non vide" };
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
      if (!(await insert(box, chunk))) return fail("texte non inséré après une mention");
    }
    // Un essai de saisie raté vide la zone : toutes les mentions doivent y être encore.
    if (mentionsIn(box) !== base + wanted) return fail("mentions perdues pendant la saisie");
    if (!send) return { ok: true };
    if (!isOpen(name)) return fail("conversation changée avant l'envoi");
    if (late()) return fail("délai dépassé avant l'envoi");
    // Une fois envoyée, la mention s'affiche sans « @ » : on cherche le texte sans.
    const shownText = mentions.reduce((t, m) => t.split("@" + m).join(m), text);
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
    if (!shown) return "citation du message non visible dans la zone de saisie";
    return null;
  };

  // Son propre statut. Le bouton du profil (avatar en haut à droite) le dit dans son
  // libellé (« Votre profil, statut Ne pas déranger ») et sur son badge (« do not
  // disturb ») : le lire n'ouvre aucun menu. Le changer passe par son menu, entrée
  // « Modifier l'état », puis le choix ; le moteur vérifie ensuite ce que Teams affiche.
  const ME = '[data-tid="me-control-avatar-trigger"]';
  const ME_MENU = '[data-tid="me-control-menu-dialog"]';
  const STATUS_ENTRY = '[data-tid="set-presence-status-menu-item"]';
  const STATUS_TIDS = {
    available: "me_control_presence_availability_available",
    busy: "me_control_presence_availability_busy",
    dnd: "me_control_presence_availability_do_not_disturb",
    brb: "me_control_presence_availability_be_right_back",
    away: "me_control_presence_availability_appear_away",
    offline: "me_control_presence_availability_appear_offline",
    reset: "set-availability-reset-status",
  };
  const NOTE = '[data-tid="me-control-status-note-container"]';
  const NOTE_EDIT =
    '[data-tid="me-control-menu-status-message-edit-button"], [data-tid="me-control-set-status-message-button"], [data-tid="me-control-menu-set-status-message"]';
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
    return waitFor(meMenuOpen, 3000);
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
          const files = filesOf(el);
          const names = new Set(files.map((f) => f.name));
          // Le nom d'un fichier joint fait aussi partie du texte : il est déjà dans sa puce.
          const text = body
            .replace(REACTIONS, "")
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
            reactions: myReactions(el),
            files,
            images,
          };
        })
        // Teams intercale des éléments vides (avatar seul) : sans texte, fichier ni image,
        // ils se ressembleraient tous et fausseraient la fusion.
        .filter((m) => m.text || m.files.length || m.images);
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
        out.push({ sender, text: m.text, at: m.at, id: m.mid, reactions: m.reactions, files: m.files, key: m.key, images: m.images });
      }
      const shown = out.slice(-last);
      await thumbnails(shown);
      return { messages: shown.map(({ key, ...m }) => m), top };
    },
    type: async ({ name, text, send, quote, mentions, files }) => {
      if (mentions && mentions.length) {
        if (Array.isArray(files) && files.length) return { ok: false, error: "pièce jointe et mention dans le même message non prises en charge" };
        return typeWithMentions({ name, text, send, quote, mentions });
      }
      if (!isOpen(name)) return { ok: false, error: "autre conversation ouverte" };
      let box = editor();
      if (!box) return { ok: false, error: "zone de saisie introuvable" };
      if (box.innerText.trim()) return { ok: false, error: "zone de saisie non vide" };
      const withFiles = Array.isArray(files) && files.length > 0;
      if (withFiles && !send) return { ok: false, error: "pièce jointe sans envoi refusée" };
      if (withFiles && removeButtons(composeRoot(box)).length) {
        return { ok: false, error: "une pièce jointe attend déjà dans la zone de saisie de Teams" };
      }
      const fail = (error) => {
        if (quote) unquote(box);
        clear(box);
        if (withFiles) dropAttachments(box);
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
        if (!got) return fail("Teams n'a pas pris la pièce jointe (champ fichier, dépôt et collage essayés)");
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
      // Un message sans texte se reconnaît au nom de son premier fichier.
      const key = text ? flat(text).slice(0, 40) : flat(files[0].name);
      const before = lastMessages(3).filter((t) => t.includes(key)).length;
      // Teams active Envoyer une fois le texte pris en compte : lui laisser le temps.
      await waitFor(sendReady, 1500);
      const btn = sendButton();
      const via = sendReady() ? "bouton" : "Entrée";
      if (via === "bouton") btn.click();
      else box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      const trace = `saisie : ${how}${joined}, envoi : ${via}`;
      // Envoyé seulement si le message apparaît dans la conversation : une zone de saisie
      // vidée ne prouve rien (page gelée, éditeur réinitialisé).
      const shown = await waitFor(() => lastMessages(3).filter((t) => t.includes(key)).length > before, withFiles ? 15000 : 6000);
      if (shown && withFiles) {
        // Le message est là : ses fichiers doivent l'être aussi, sinon pas de « envoyé ».
        const seen = norm(lastMessages(3).join(" "));
        const missing = files.filter((f) => !seen.includes(norm(f.name))).map((f) => f.name);
        if (missing.length) {
          return { ok: false, uncertain: true, error: `message visible, pièce jointe non visible (${missing.join(", ")}) : vérifie dans Teams (${trace})` };
        }
      }
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
          if (!sub) return { ok: false, error: "entrée « Modifier l'état » introuvable dans le menu du profil" };
          sub.click();
          if (!(await waitFor(entry, 3000))) return { ok: false, error: "choix de statut absents du menu de Teams" };
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
          if (!edit) return { ok: false, error: "bouton « Définir le message de statut » introuvable" };
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
    diagnose: () => ({
      url: location.href,
      title: document.title,
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

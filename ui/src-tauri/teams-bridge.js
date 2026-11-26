(() => {
  if (window.top !== window || window.__trame) return;
  if (!/(^|\.)teams\.(microsoft|cloud\.microsoft)\.com$|^teams\.cloud\.microsoft$/.test(location.hostname)) return;
  const reply = (payload) => window.__TAURI_INTERNALS__.invoke("teams_bridge_reply", { payload });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el?.getAttribute?.("aria-label") || el?.innerText || "").replace(/\s+/g, " ").trim();
  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const rail = () => document.querySelector('[role="tree"]');
  const items = () => Array.from(rail()?.querySelectorAll('[role="treeitem"]') || []);
  const railItems = () =>
    items().map((el) => ({
      label: label(el),
      aria: el.getAttribute("aria-expanded") === "true" ? "expanded=true" : "",
      id: el.querySelector('[id*="19:"]')?.id || (el.id && el.id.includes("19:") ? el.id : ""),
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
  const MSGS = '[data-tid="chat-pane-item"], [role="main"] [role="list"] > [role="listitem"]';
  const lastMessages = (n) => Array.from(document.querySelectorAll(MSGS)).slice(-n).map((el) => flat(el.innerText));
  let deadline = 0;
  const late = () => deadline && Date.now() > deadline;

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
        out.push({ sender, text: m.text, at: m.at });
      }
      return { messages: out.slice(-last), top };
    },
    type: async ({ name, text, send }) => {
      if (!isOpen(name)) return { ok: false, error: "autre conversation ouverte" };
      const box = editor();
      if (!box) return { ok: false, error: "zone de saisie introuvable" };
      if (box.innerText.trim()) return { ok: false, error: "zone de saisie non vide" };
      const fail = (error) => {
        clear(box);
        return { ok: false, error };
      };
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
    diagnose: () => ({
      url: location.href,
      title: document.title,
      title_conversation: titleName(),
      rail: Boolean(rail()),
      items: items().length,
      sample: items().slice(0, 6).map((el) => label(el).split(/\s+/).slice(0, 3).join(" ")),
      editor: Boolean(editor()),
      editor_info: (() => {
        const e = editor();
        return e ? { tag: e.tagName, tid: e.getAttribute("data-tid") || "", role: e.getAttribute("role") || "", filled: Boolean(e.innerText.trim()) } : null;
      })(),
      textboxes: document.querySelectorAll('[contenteditable="true"]').length,
      has_focus: document.hasFocus(),
      visibility: document.visibilityState,
      send_button: Boolean(sendButton()),
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

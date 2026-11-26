(() => {
  if (window.top !== window || window.__trame) return;
  const reply = (payload) => window.__TAURI_INTERNALS__.invoke("teams_bridge_reply", { payload });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const label = (el) => (el?.getAttribute?.("aria-label") || el?.innerText || "").replace(/\s+/g, " ").trim();
  const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const rail = () => document.querySelector('[role="tree"]');
  const items = () => Array.from(rail()?.querySelectorAll('[role="treeitem"]') || []);
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
      const l = norm(label(el)).replace(KIND, "");
      return l === n || l.startsWith(n + " ");
    });
    return exact.sort((a, b) => label(a).length - label(b).length)[0] || null;
  };
  const editor = () =>
    document.querySelector('[data-tid="ckeditor"] [contenteditable="true"]') ||
    document.querySelector('[role="textbox"][contenteditable="true"]');
  const sendButton = () =>
    document.querySelector('[data-tid="newMessageCommands-send"]') ||
    document.querySelector('button[aria-label^="Send"], button[aria-label^="Envoyer"]');
  const waitFor = async (check, ms) => {
    for (let t = 0; t < ms; t += 150) {
      if (check()) return true;
      await sleep(150);
    }
    return check();
  };

  const ops = {
    ping: () => ({ title: document.title, ready: Boolean(rail()) }),
    title: () => document.title,
    list: () =>
      items().map((el) => ({
        label: label(el),
        aria: el.getAttribute("aria-expanded") === "true" ? "expanded=true" : "",
        id: el.querySelector('[id*="19:"]')?.id || (el.id && el.id.includes("19:") ? el.id : ""),
      })),
    open: async ({ name }) => {
      if (isOpen(name)) return { ok: true, title: document.title };
      const item = findItem(name);
      if (!item) return { ok: false, title: document.title, error: "conversation absente de la liste" };
      item.scrollIntoView({ block: "nearest" });
      item.click();
      const ok = await waitFor(() => isOpen(name), 4000);
      return { ok, title: document.title };
    },
    read: ({ last = 30 }) => {
      const nodes = Array.from(
        document.querySelectorAll('[data-tid="chat-pane-item"], [role="main"] [role="list"] > [role="listitem"]')
      );
      let sender = "";
      const out = [];
      for (const el of nodes.slice(-last)) {
        const who = el.querySelector('[data-tid="message-author-name"]')?.innerText?.trim();
        if (who) sender = who;
        const body =
          el.querySelector('[data-tid="chat-pane-message"]')?.innerText ||
          el.querySelector('[id^="content-"]')?.innerText ||
          "";
        const time = el.querySelector("time");
        const text = body.replace(/\s+\n/g, "\n").trim();
        if (text) out.push({ sender, text, at: time?.innerText?.trim() || time?.getAttribute("datetime") || "" });
      }
      return out;
    },
    type: async ({ name, text, send }) => {
      if (!isOpen(name)) return { ok: false, error: "autre conversation ouverte" };
      const box = editor();
      if (!box) return { ok: false, error: "zone de saisie introuvable" };
      if (box.innerText.trim()) return { ok: false, error: "zone de saisie non vide" };
      box.focus();
      document.execCommand("insertText", false, text);
      await sleep(150);
      if (!box.innerText.includes(text.slice(0, 20))) return { ok: false, error: "texte non inséré" };
      if (!send) return { ok: true };
      if (!isOpen(name)) return { ok: false, error: "conversation changée avant l'envoi" };
      const btn = sendButton();
      if (btn) btn.click();
      else box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      const sent = await waitFor(() => !box.innerText.trim(), 3000);
      return { ok: sent, error: sent ? undefined : "envoi non confirmé" };
    },
    diagnose: () => ({
      url: location.href,
      title: document.title,
      title_conversation: titleName(),
      rail: Boolean(rail()),
      items: items().length,
      sample: items().slice(0, 6).map(label),
      editor: Boolean(editor()),
      send_button: Boolean(sendButton()),
      messages: document.querySelectorAll('[data-tid="chat-pane-item"], [role="main"] [role="list"] > [role="listitem"]').length,
    }),
  };

  window.__trame = {
    run: async (cmd) => {
      try {
        const op = ops[cmd.op];
        if (!op) throw new Error(`opération inconnue : ${cmd.op}`);
        reply({ id: cmd.id, ok: true, result: await op(cmd.args || {}) });
      } catch (e) {
        reply({ id: cmd.id, ok: false, error: String((e && e.message) || e) });
      }
    },
  };
})();

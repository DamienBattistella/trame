// Relevé d'un fragment de Teams web pour test_teams_landmarks.py : structure seule.
//
// À coller dans la console de Teams web (teams.cloud.microsoft), une conversation ouverte,
// après avoir défini LANDMARKS (la table de ui/src-tauri/teams-bridge.js) :
//   copy(await recordTeamsFixture(LANDMARKS))
// puis coller le résultat dans page.html. Seul geste : le survol du dernier message, pour
// relever sa barre d'actions, retiré aussitôt. Aucun clic.
//
// Ce qui est gardé : les éléments trouvés par les sélecteurs et leurs ancêtres, avec
// data-tid, role, contenteditable, type et un id anonymisé. Aucun texte, aucun nom :
// les libellés (aria-label) ne sont gardés que pour les mots d'interface que le pont
// cherche (« Envoyer », « Joindre »…) ; une ligne non lue de la liste devient « Non lu ».
async function recordTeamsFixture(landmarks, { perSelector = 3 } = {}) {
  const keep = new Set();
  const add = (el) => {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) keep.add(e);
  };
  const take = (sel, root = document) => {
    if (!sel) return;
    for (const one of sel.split(/,\s*(?![^\[]*\])/)) {
      try {
        Array.from(root.querySelectorAll(one)).slice(0, perSelector).forEach(add);
      } catch {
        /* sélecteur propre au pont */
      }
    }
  };
  const rail = document.querySelector('[role="tree"]');
  for (const [, when, sel] of landmarks) if (when !== "hover" && when !== "menu") take(sel);
  // Des heures de message (hors liste) : le contrôle s'en sert pour savoir qu'un fil est affiché.
  Array.from(document.querySelectorAll("time")).filter((t) => !rail?.contains(t)).slice(0, perSelector).forEach(add);
  // Les lignes non lues de la liste.
  const unread = new Set(Array.from(rail?.querySelectorAll('[role="treeitem"]') || []).filter((el) => el.querySelector('[data-tid="unread"]')));
  unread.forEach(add);
  // La zone de saisie et son éditeur : la chaîne qui mène au bouton Envoyer.
  const editor = document.querySelector('[data-tid="ckeditor"]');
  if (editor) add(editor);
  // Survol du dernier message : sa barre d'actions.
  const items = Array.from(document.querySelectorAll('[data-tid="chat-pane-item"]')).filter((el) => el.querySelector('[id^="content-"]'));
  const last = items[items.length - 1];
  const fire = (n, types) => {
    for (const t of types) {
      const C = t.startsWith("pointer") ? PointerEvent : MouseEvent;
      n.dispatchEvent(new C(t, { bubbles: t.endsWith("over") || t.endsWith("out") || t === "mousemove", view: window }));
    }
  };
  if (last) {
    add(last);
    const target = last.querySelector('[data-tid="chat-pane-message"]') || last;
    for (const n of [last, target]) fire(n, ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"]);
    await new Promise((r) => setTimeout(r, 800));
    const bar = Array.from(document.querySelectorAll('[data-tid="message-actions-container"]')).find((b) => b.getClientRects().length);
    if (bar) {
      add(bar);
      bar.querySelectorAll("[data-tid]").forEach(add);
    }
  }
  // Identifiants : conversations et messages remplacés par des numéros stables.
  const ids = new Map();
  const token = (raw) => {
    if (!ids.has(raw)) ids.set(raw, String(ids.size + 1).padStart(4, "0"));
    return ids.get(raw);
  };
  // Identifiants Microsoft (GUID) : seul celui de l'application Conversation, public, reste.
  const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const PUBLIC = "86fcd49b-61a2-4701-b771-54728cd291fb";
  const clean = (v) =>
    v
      .replace(GUID, (g) => (g.toLowerCase() === PUBLIC ? g : `guid-${token(g)}`))
      .replace(/19:[^\s]+/g, (m) => `19:fixture-${token(m)}@thread.v2`)
      .replace(/\d{6,}/g, (d) => token(d));
  const cleanId = (id) => {
    const out = clean(id);
    return /^[\w:@.-]+$/.test(out) && out.length < 80 ? out : null;
  };
  const LABELS = /^(send|envoyer|joindre|attach|conversation|chat|new chat|nouvelle conversation|to|à)\b/i;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const out = [];
  const walk = (el, depth) => {
    if (!keep.has(el)) return;
    const tag = el.tagName.toLowerCase();
    const attrs = [];
    for (const name of ["data-tid", "data-testid", "role", "contenteditable", "type"]) {
      const v = el.getAttribute(name);
      if (v !== null) attrs.push(`${name}="${esc(name.startsWith("data-") ? clean(v) : v)}"`);
    }
    if (el.id) {
      const id = cleanId(el.id);
      if (id) attrs.push(`id="${esc(id)}"`);
    }
    const aria = el.getAttribute("aria-label") || "";
    if (unread.has(el)) attrs.push('aria-label="Non lu"');
    else if (LABELS.test(aria)) attrs.push(`aria-label="${esc(aria.match(LABELS)[0])}"`);
    const pad = "  ".repeat(depth);
    const kids = Array.from(el.children).filter((c) => keep.has(c));
    if (!kids.length) return void out.push(`${pad}<${tag}${attrs.length ? " " + attrs.join(" ") : ""}></${tag}>`);
    out.push(`${pad}<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>`);
    kids.forEach((c) => walk(c, depth + 1));
    out.push(`${pad}</${tag}>`);
  };
  walk(document.body, 0);
  if (last) for (const b of document.querySelectorAll('[data-tid="chat-pane-message"]')) fire(b, ["pointerout", "pointerleave", "mouseout", "mouseleave"]);
  return out.join("\n") + "\n";
}

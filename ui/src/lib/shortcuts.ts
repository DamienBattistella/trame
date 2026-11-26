// Raccourcis clavier globaux : les règles communes à tous les écouteurs de la fenêtre.

/** Vrai si la frappe vise un champ de saisie : les raccourcis à une touche s'y taisent. */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

/** Vrai si une fenêtre, un tiroir ou un menu est ouvert : il garde le clavier pour lui. */
export function overlayOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]'));
}

/** Ctrl+K (ou Cmd+K) : aller à une conversation. */
export const isSwitcherKey = (e: KeyboardEvent) =>
  (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K");

/** Alt+F : épingler (ou retirer) la conversation dans les favoris. */
export const isFavoriteKey = (e: KeyboardEvent) =>
  e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "f" || e.key === "F" || e.code === "KeyF");

/** Ctrl+/ (pavé numérique ou Maj+: en AZERTY), ou ? hors d'un champ : l'aide des raccourcis. */
export const isHelpKey = (e: KeyboardEvent) =>
  ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "/" || e.code === "Slash" || e.code === "NumpadDivide")) ||
  (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e));

// Ctrl+K depuis un autre onglet : l'onglet Discussions s'ouvre, puis la palette.
let switcherPending = false;
export function requestSwitcher() {
  switcherPending = true;
}
export function takeSwitcherRequest(): boolean {
  const pending = switcherPending;
  switcherPending = false;
  return pending;
}

export type ShortcutGroup = { title: string; items: { keys: string[][]; label: string }[] };

/** Tout ce que l'aide affiche : une touche par case, plusieurs combinaisons séparées par « ou ». */
export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "Navigation",
    items: [
      { keys: [["Ctrl", "K"]], label: "Aller à une conversation" },
      { keys: [["Alt", "↓"], ["Alt", "↑"]], label: "Conversation non lue ou à relire suivante / précédente" },
      { keys: [["Alt", "Maj", "↓"], ["Alt", "Maj", "↑"]], label: "Conversation suivante / précédente dans la liste" },
      { keys: [["↓"], ["↑"]], label: "Parcourir la liste (une fois dedans)" },
      { keys: [["Échap"]], label: "Revenir de la discussion à la liste" },
    ],
  },
  {
    title: "Favoris",
    items: [
      { keys: [["Alt", "F"]], label: "Épingler ou retirer la conversation des favoris" },
      { keys: [["Ctrl", "Maj", "↑"], ["Ctrl", "Maj", "↓"]], label: "Monter / descendre le favori (dans la liste)" },
    ],
  },
  {
    title: "Zone de réponse",
    items: [
      { keys: [["Entrée"]], label: "Envoyer" },
      { keys: [["Maj", "Entrée"]], label: "Aller à la ligne" },
      { keys: [["Tab"]], label: "Utiliser la réponse proposée" },
      { keys: [["@"]], label: "Mentionner quelqu'un" },
      { keys: [["Ctrl", "V"]], label: "Joindre une capture copiée" },
      { keys: [["Échap"]], label: "Fermer la mention, la citation ou la proposition" },
    ],
  },
  {
    title: "Général",
    items: [
      { keys: [["Ctrl", "/"], ["?"]], label: "Afficher cette aide" },
      { keys: [["Alt", "D"]], label: "Thème clair / sombre" },
    ],
  },
];

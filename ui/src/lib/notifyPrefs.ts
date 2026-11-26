/** Quand et comment Trame affiche une notification Windows pour un message reçu. */

export type NotifyScope = "all" | "direct" | "mentions";

export interface NotifyPrefs {
  /** all : tout ; direct : conversations privées, mentions et conversations suivies ;
   *  mentions : seulement quand on te mentionne. */
  scope: NotifyScope;
  /** Heures calmes : aucune notification entre `from` et `to` (« HH:MM », peut passer minuit). */
  quiet: { on: boolean; from: string; to: string };
}

export const DEFAULT_PREFS: NotifyPrefs = { scope: "all", quiet: { on: false, from: "19:00", to: "08:00" } };

/** Ce que la notification a besoin de savoir d'un message reçu. */
export interface NoticeLike {
  threadId: string;
  conversation: string;
  from: string;
  text: string;
  surface: "dm" | "group" | "channel";
  mentioned?: boolean;
  followed?: boolean;
}

export interface Toast {
  title: string;
  body: string;
}

const minutes = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : null;
};

/** Dans les heures calmes ? Une plage qui passe minuit (19:00 → 08:00) est prise en compte. */
export function inQuietHours(prefs: NotifyPrefs, now: Date): boolean {
  if (!prefs.quiet.on) return false;
  const from = minutes(prefs.quiet.from);
  const to = minutes(prefs.quiet.to);
  if (from === null || to === null || from === to) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return from < to ? t >= from && t < to : t >= from || t < to;
}

export function wanted(n: NoticeLike, prefs: NotifyPrefs): boolean {
  if (prefs.scope === "mentions") return Boolean(n.mentioned);
  if (prefs.scope === "direct") return n.surface === "dm" || Boolean(n.mentioned) || Boolean(n.followed);
  return true;
}

/**
 * Les notifications à afficher pour les messages arrivés d'un coup : filtrées par les
 * réglages, et regroupées (plusieurs messages d'une conversation : une seule notification ;
 * plus de trois conversations : un seul résumé). `hideText` : texte masqué (présentation).
 */
export function toasts(fresh: NoticeLike[], prefs: NotifyPrefs, now: Date, hideText = false): Toast[] {
  if (inQuietHours(prefs, now)) return [];
  const kept = fresh.filter((n) => wanted(n, prefs));
  if (!kept.length) return [];
  const byThread = new Map<string, NoticeLike[]>();
  for (const n of kept) byThread.set(n.threadId, [...(byThread.get(n.threadId) ?? []), n]);
  if (byThread.size > 3) {
    return [{ title: `${kept.length} nouveaux messages`, body: `Dans ${byThread.size} conversations : ${[...byThread.values()].map((l) => l[0].conversation).slice(0, 3).join(", ")}…` }];
  }
  return [...byThread.values()].map((list) => {
    const last = list[list.length - 1];
    const title = last.conversation && last.conversation !== last.from ? `${last.from} · ${last.conversation}` : last.from;
    const text = hideText ? "Nouveau message" : last.text;
    return list.length > 1 ? { title, body: `${list.length} nouveaux messages · ${hideText ? "" : text}`.replace(/ · $/, "") } : { title, body: text };
  });
}

const KEY = "trame.notifications.prefs";

export function loadPrefs(): NotifyPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw) return DEFAULT_PREFS;
    const scope: NotifyScope = ["all", "direct", "mentions"].includes(raw.scope) ? raw.scope : "all";
    return { scope, quiet: { ...DEFAULT_PREFS.quiet, ...(raw.quiet ?? {}), on: Boolean(raw.quiet?.on) } };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: NotifyPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* stockage indisponible : le réglage vaut pour la session */
  }
}

import type { NotificationSound } from "@/types";

type TauriGlobal = {
  core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event?: { listen: (name: string, cb: () => void) => Promise<() => void> };
};

function tauri(): TauriGlobal | null {
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

export const isDesktop = () => tauri() !== null;

/** Version de l'application installée (celle de la release), null hors application. */
export async function appVersion(): Promise<string | null> {
  try {
    const v = await tauri()?.core?.invoke("plugin:app|version");
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Version publiée plus récente que celle installée ; `notes` = changelog (JSON) de latest.json. */
export type UpdateInfo = { version: string; notes: string | null };

/** Mises à jour : version disponible (null si à jour) ; erreur explicite sinon. */
export async function checkUpdate(): Promise<{ ok: true; update: UpdateInfo | null } | { ok: false; error: string }> {
  const t = tauri();
  if (!t?.core) return { ok: false, error: "Disponible dans l'application installée." };
  try {
    const u = (await t.core.invoke("check_update")) as UpdateInfo | null;
    return { ok: true, update: u?.version ? { version: u.version, notes: u.notes ?? null } : null };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Mise à jour disponible, partagée entre la LED de l'en-tête et Réglages › Mises à jour.
let available: UpdateInfo | null = null;
const updateListeners = new Set<() => void>();

export function setAvailableUpdate(update: UpdateInfo | null): void {
  if (available?.version === update?.version) return;
  available = update;
  updateListeners.forEach((l) => l());
}
export const getAvailableUpdate = () => available;
export function subscribeAvailableUpdate(cb: () => void): () => void {
  updateListeners.add(cb);
  return () => updateListeners.delete(cb);
}

/** Fréquence de recherche des mises à jour (minutes, 0 : au lancement seulement), appliquée sans redémarrer. */
export async function setUpdateCheckMinutes(minutes: number): Promise<void> {
  try {
    await tauri()?.core?.invoke("set_update_check_minutes", { minutes });
  } catch {
    // Hors application, ou application plus ancienne : la boucle garde sa fréquence.
  }
}

/** Télécharge, installe et redémarre Trame. Ne revient qu'en cas d'échec. */
export async function installUpdate(): Promise<string | null> {
  try {
    await tauri()?.core?.invoke("install_update");
    return null;
  } catch (e) {
    return String(e);
  }
}

/** Teams intégré (expérimental) : fenêtre Teams web de Trame. */
export async function teamsWebOpen(visible: boolean): Promise<string | null> {
  try {
    await tauri()?.core?.invoke("teams_web_open", { visible });
    return null;
  } catch (e) {
    return String(e);
  }
}
export async function teamsWebHide(): Promise<void> {
  try {
    await tauri()?.core?.invoke("teams_web_hide");
  } catch {
    /* fenêtre absente */
  }
}
export async function teamsWebClose(): Promise<void> {
  try {
    await tauri()?.core?.invoke("teams_web_close");
  } catch {
    /* fenêtre absente */
  }
}
export async function teamsWebEval(script: string): Promise<boolean> {
  try {
    await tauri()?.core?.invoke("teams_web_eval", { script });
    return true;
  } catch {
    return false;
  }
}

/** Relance le moteur embarqué (application de bureau uniquement). */
export async function restartBackend(): Promise<boolean> {
  try {
    await tauri()?.core?.invoke("restart_backend");
    return true;
  } catch {
    return false;
  }
}

export async function autostartEnabled(): Promise<boolean> {
  try {
    return Boolean(await tauri()?.core?.invoke("plugin:autostart|is_enabled"));
  } catch {
    return false;
  }
}

/** true si le réglage a été appliqué (ou hors Tauri, où il est sans effet). */
export async function setAutostart(on: boolean): Promise<boolean> {
  const t = tauri();
  if (!t?.core) return true;
  try {
    await t.core.invoke(on ? "plugin:autostart|enable" : "plugin:autostart|disable");
    return true;
  } catch {
    return false;
  }
}

/** Écoute un événement émis par l'application de bureau ; sans effet dans un navigateur. */
export function onDesktopEvent<T = unknown>(name: string, cb: (payload: T) => void): () => void {
  let unlisten: (() => void) | undefined;
  let gone = false;
  const ev = tauri()?.event as { listen: (n: string, f: (e: { payload: T }) => void) => Promise<() => void> } | undefined;
  ev?.listen(name, (e) => cb(e.payload)).then((u) => (gone ? u() : (unlisten = u)));
  return () => {
    gone = true;
    unlisten?.();
  };
}

export function onTrayTogglePause(cb: () => void): () => void {
  let unlisten: (() => void) | undefined;
  tauri()?.event?.listen("tray-toggle-pause", cb).then((u) => (unlisten = u));
  return () => unlisten?.();
}

/** Ouvre un lien dans le navigateur du système (plugin shell de Tauri), sinon dans un nouvel onglet. */
export async function openExternal(url: string): Promise<void> {
  const t = tauri();
  if (t?.core) {
    try {
      await t.core.invoke("plugin:shell|open", { path: url });
      return;
    } catch {
      /* permission shell:allow-open absente : repli navigateur */
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

const NOTIFY_KEY = "trame.notifications";

/** Notifications Windows à l'arrivée d'un message : activées sauf choix contraire. */
export function notificationsEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setNotificationsEnabled(on: boolean): void {
  try {
    localStorage.setItem(NOTIFY_KEY, on ? "on" : "off");
  } catch {
    /* stockage indisponible : le réglage vaut pour la session */
  }
}

/** Affiche une notification Windows, muette ou avec un son du système. Sans effet hors de l'application installée. */
export async function notify(title: string, body: string, sound: NotificationSound = "off"): Promise<boolean> {
  try {
    const t = tauri();
    if (!t?.core) return false;
    await t.core.invoke("notify", { title, body, sound: sound === "off" ? null : sound });
    return true;
  } catch {
    return false;
  }
}

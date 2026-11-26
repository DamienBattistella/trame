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

/** Mises à jour : version disponible (null si à jour) ; erreur explicite sinon. */
export async function checkUpdate(): Promise<{ ok: true; version: string | null } | { ok: false; error: string }> {
  const t = tauri();
  if (!t?.core) return { ok: false, error: "Disponible dans l'application installée." };
  try {
    const v = await t.core.invoke("check_update");
    return { ok: true, version: typeof v === "string" ? v : null };
  } catch (e) {
    return { ok: false, error: String(e) };
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

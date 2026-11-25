type TauriGlobal = {
  core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event?: { listen: (name: string, cb: () => void) => Promise<() => void> };
};

function tauri(): TauriGlobal | null {
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

export const isDesktop = () => tauri() !== null;

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

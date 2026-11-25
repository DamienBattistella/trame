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

export async function setAutostart(on: boolean): Promise<void> {
  try {
    await tauri()?.core?.invoke(on ? "plugin:autostart|enable" : "plugin:autostart|disable");
  } catch {
    /* hors Tauri : sans effet */
  }
}

export function onTrayTogglePause(cb: () => void): () => void {
  let unlisten: (() => void) | undefined;
  tauri()?.event?.listen("tray-toggle-pause", cb).then((u) => (unlisten = u));
  return () => unlisten?.();
}

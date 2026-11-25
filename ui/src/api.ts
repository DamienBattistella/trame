import { useEffect, useRef, useState } from "react";
import { Brain, DraftItem, LogItem, Mode, Settings, SettingsPatch, Surface, WatchEntity } from "@/types";
import { mockConversations, mockDrafts, mockLogs } from "@/mockData";

const HTTP = "http://127.0.0.1:8731";
const WS = "ws://127.0.0.1:8731/ws";
const SOUL_MAX_BYTES = 64 * 1024;

export interface TrameState {
  paused: boolean;
  screenSharing: boolean;
  brain: Brain;
  selftestOk: boolean;
  onboarded: boolean;
  watchlist: WatchEntity[];
  drafts: DraftItem[];
  logs: LogItem[];
}

export type Result<T = {}> = ({ ok: true; error?: undefined } & T) | { ok: false; error: string };

export interface WatchlistEntry {
  threadId: string;
  watch: boolean;
  mode: Mode;
}

// --- mapping backend (snake_case / aliases) -> UI (camelCase) ---
function mapWatch(w: any): WatchEntity {
  return {
    threadId: w.thread_id,
    displayName: w.display_name,
    surface: w.surface as Surface,
    watch: w.watch,
    mode: w.mode,
    namedPeople: w.named_people ?? [],
  };
}
function mapDraft(d: any): DraftItem {
  return {
    id: d.id,
    threadId: d.thread_id,
    from: d.from,
    surface: d.surface as Surface,
    incoming: d.incoming,
    proposal: d.proposal,
    receivedAt: d.received_at,
    mode: d.mode,
    usedGithub: d.used_github ?? undefined,
  };
}
function mapState(s: any): TrameState {
  return {
    paused: s.paused,
    screenSharing: s.screen_sharing,
    brain: s.brain,
    selftestOk: s.selftest_ok,
    onboarded: Boolean(s.onboarded),
    watchlist: (s.watchlist ?? []).map(mapWatch),
    drafts: (s.drafts ?? []).map(mapDraft),
    logs: (s.logs ?? []) as LogItem[],
  };
}
function mapSettings(s: any): Settings {
  const g = s?.github ?? {};
  const f = s?.safety ?? {};
  return {
    onboarded: Boolean(s?.onboarded),
    brain: s?.brain === "copilot" ? "copilot" : "claude",
    github: { enabled: Boolean(g.enabled), allRepos: Boolean(g.all_repos) },
    safety: {
      autoPauseOnScreenShare: Boolean(f.auto_pause_on_screen_share),
      selftestGate: Boolean(f.selftest_gate),
      countdownSeconds: Number(f.countdown_seconds ?? 5),
      neverAutoSendIfMessageContains: Array.isArray(f.never_auto_send_if_message_contains)
        ? f.never_auto_send_if_message_contains
        : [],
    },
  };
}
function settingsPatchToWire(p: SettingsPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.onboarded !== undefined) out.onboarded = p.onboarded;
  if (p.brain !== undefined) out.brain = p.brain;
  if (p.github) {
    const g: Record<string, unknown> = {};
    if (p.github.enabled !== undefined) g.enabled = p.github.enabled;
    if (p.github.allRepos !== undefined) g.all_repos = p.github.allRepos;
    out.github = g;
  }
  if (p.safety) {
    const f: Record<string, unknown> = {};
    if (p.safety.autoPauseOnScreenShare !== undefined) f.auto_pause_on_screen_share = p.safety.autoPauseOnScreenShare;
    if (p.safety.selftestGate !== undefined) f.selftest_gate = p.safety.selftestGate;
    if (p.safety.countdownSeconds !== undefined) f.countdown_seconds = p.safety.countdownSeconds;
    if (p.safety.neverAutoSendIfMessageContains !== undefined)
      f.never_auto_send_if_message_contains = p.safety.neverAutoSendIfMessageContains;
    out.safety = f;
  }
  return out;
}
export function mergeSettings(s: Settings, p: SettingsPatch): Settings {
  return {
    ...s,
    ...(p.onboarded !== undefined && { onboarded: p.onboarded }),
    ...(p.brain !== undefined && { brain: p.brain }),
    github: { ...s.github, ...p.github },
    safety: { ...s.safety, ...p.safety },
  };
}

function mockState(): TrameState {
  return {
    paused: false,
    screenSharing: false,
    brain: "claude",
    selftestOk: true,
    onboarded: false,
    watchlist: mockConversations.map((c) => ({ ...c })),
    drafts: mockDrafts.map((d) => ({ ...d })),
    logs: mockLogs.map((l) => ({ ...l })),
  };
}

// Réglages du mode démo : vivent le temps de la session.
let localSettings: Settings = {
  onboarded: false,
  brain: "claude",
  github: { enabled: true, allRepos: true },
  safety: {
    autoPauseOnScreenShare: true,
    selftestGate: true,
    countdownSeconds: 5,
    neverAutoSendIfMessageContains: ["RH", "confidentiel", "salaire"],
  },
};

async function request<T = {}>(method: string, path: string, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(HTTP + path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* corps vide ou non JSON */
    }
    if (!res.ok || data?.ok === false) {
      const error = typeof data?.error === "string" && data.error ? data.error : `Le moteur Trame a répondu ${res.status}.`;
      return { ok: false, error };
    }
    return { ...(data ?? {}), ok: true } as Result<T>;
  } catch {
    return { ok: false, error: "Le moteur Trame est injoignable." };
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Live state via WebSocket, with mock fallback when the backend is offline. */
export function useTrame() {
  const [state, setState] = useState<TrameState>(mockState);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const connectedRef = useRef(false);
  connectedRef.current = connected;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(WS);
      } catch {
        retry = setTimeout(connect, 2000);
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => !closed && setConnected(true);
      ws.onmessage = (e) => {
        if (closed) return;
        try {
          setState(mapState(JSON.parse(e.data)));
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setConnected(false);
        retry = setTimeout(connect, 2000); // reconnect if the backend restarts
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  /** Hors backend : succès simulé après un court délai, comme une vraie requête. */
  const demo = async <T,>(ms: number, data: T): Promise<Result<T>> => {
    await wait(ms);
    return { ok: true, ...data } as Result<T>;
  };

  const patchWatch = (entries: WatchlistEntry[]) => {
    const byId = new Map(entries.map((e) => [e.threadId, e]));
    setState((s) => ({
      ...s,
      watchlist: s.watchlist.map((w) => {
        const e = byId.get(w.threadId);
        return e ? { ...w, watch: e.watch, mode: e.mode } : w;
      }),
    }));
  };
  const snapshot = (ids: string[]): WatchlistEntry[] => {
    const set = new Set(ids);
    return stateRef.current.watchlist
      .filter((w) => set.has(w.threadId))
      .map(({ threadId, watch, mode }) => ({ threadId, watch, mode }));
  };
  /** Mise à jour optimiste de la watchlist, annulée si le moteur refuse. */
  const applyWatch = async (next: WatchlistEntry[], send: () => Promise<Result>): Promise<Result> => {
    const prev = snapshot(next.map((e) => e.threadId));
    patchWatch(next);
    if (!connectedRef.current) return { ok: true };
    const res = await send();
    if (!res.ok) patchWatch(prev);
    return res;
  };

  const setPaused = (p: boolean) => {
    setState((s) => ({ ...s, paused: p }));
    if (connectedRef.current) request("POST", "/api/pause", { paused: p });
  };

  /** Le retrait de la carte est fait par l'UI après l'animation « Envoyé » (removeDraft). */
  const sendDraft = (id: string, text: string): Promise<Result> =>
    connectedRef.current ? request("POST", `/api/drafts/${id}/send`, { text }) : demo(700, {});
  /** Ouvre la conversation dans Teams et tape le texte, sans envoyer. */
  const composeDraft = (id: string, text: string): Promise<Result> =>
    connectedRef.current ? request("POST", `/api/drafts/${id}/compose`, { text }) : demo(900, {});
  const removeDraft = (id: string) =>
    setState((s) => ({ ...s, drafts: s.drafts.filter((d) => d.id !== id) }));
  const dismissDraft = (id: string) => {
    removeDraft(id);
    if (connectedRef.current) request("POST", `/api/drafts/${id}/dismiss`);
  };
  const catchUp = (): Promise<Result<{ queued: number }>> =>
    connectedRef.current ? request<{ queued: number }>("POST", "/api/catchup") : demo(1200, { queued: 0 });

  const getSettings = async (): Promise<Result<{ settings: Settings }>> => {
    if (!connectedRef.current) return { ok: true, settings: localSettings };
    const res = await request<{ settings: unknown }>("GET", "/api/settings");
    return res.ok ? { ok: true, settings: mapSettings(res.settings) } : res;
  };
  const updateSettings = async (patch: SettingsPatch): Promise<Result<{ settings: Settings }>> => {
    if (patch.brain) setState((s) => ({ ...s, brain: patch.brain! }));
    if (!connectedRef.current) {
      await wait(350);
      localSettings = mergeSettings(localSettings, patch);
      return { ok: true, settings: localSettings };
    }
    const res = await request<{ settings: unknown }>("PUT", "/api/settings", settingsPatchToWire(patch));
    if (!res.ok) return res;
    const settings = mapSettings(res.settings);
    setState((s) => ({ ...s, brain: settings.brain, onboarded: settings.onboarded }));
    return { ok: true, settings };
  };

  const saveWatchlist = (entries: WatchlistEntry[]): Promise<Result<{ count: number }>> =>
    connectedRef.current
      ? request<{ count: number }>(
          "PUT",
          "/api/watchlist",
          entries.map((e) => ({ thread_id: e.threadId, watch: e.watch, mode: e.mode }))
        )
      : demo(500, { count: entries.length });

  const uploadSoul = async (filename: string, content: string): Promise<Result> => {
    if (!/\.(md|txt)$/i.test(filename)) return { ok: false, error: "Seuls les fichiers .md ou .txt sont acceptés." };
    if (new Blob([content]).size > SOUL_MAX_BYTES) return { ok: false, error: "Le fichier dépasse 64 Ko." };
    return connectedRef.current ? request("POST", "/api/soul", { filename, content }) : demo(500, {});
  };

  const toggleWatch = (threadId: string) => {
    const cur = stateRef.current.watchlist.find((w) => w.threadId === threadId);
    if (!cur) return Promise.resolve<Result>({ ok: true });
    const watch = !cur.watch;
    return applyWatch([{ threadId, watch, mode: cur.mode }], () =>
      request("POST", `/api/watch/${threadId}`, { watch })
    );
  };
  const setWatchMany = (threadIds: string[], watch: boolean) => {
    const next = snapshot(threadIds).map((e) => ({ ...e, watch }));
    return applyWatch(next, () => saveWatchlist(next));
  };
  const setMode = (threadId: string, mode: Mode) => {
    const cur = stateRef.current.watchlist.find((w) => w.threadId === threadId);
    if (!cur) return Promise.resolve<Result>({ ok: true });
    return applyWatch([{ threadId, watch: cur.watch, mode }], () =>
      request("POST", `/api/mode/${threadId}`, { mode })
    );
  };

  return {
    state,
    connected,
    setPaused,
    sendDraft,
    composeDraft,
    removeDraft,
    dismissDraft,
    catchUp,
    getSettings,
    updateSettings,
    saveWatchlist,
    uploadSoul,
    toggleWatch,
    setWatchMany,
    setMode,
  };
}

export type Trame = ReturnType<typeof useTrame>;
export { SOUL_MAX_BYTES };

import { useEffect, useRef, useState } from "react";
import { DraftItem, LogItem, Surface, WatchEntity } from "@/types";
import { mockConversations, mockDrafts, mockLogs } from "@/mockData";

const HTTP = "http://127.0.0.1:8731";
const WS = "ws://127.0.0.1:8731/ws";

export interface TrameState {
  paused: boolean;
  screenSharing: boolean;
  brain: "claude" | "copilot";
  selftestOk: boolean;
  watchlist: WatchEntity[];
  drafts: DraftItem[];
  logs: LogItem[];
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
    watchlist: (s.watchlist ?? []).map(mapWatch),
    drafts: (s.drafts ?? []).map(mapDraft),
    logs: (s.logs ?? []) as LogItem[],
  };
}

function mockState(): TrameState {
  return {
    paused: false,
    screenSharing: false,
    brain: "claude",
    selftestOk: true,
    watchlist: mockConversations.map((c) => ({ ...c })),
    drafts: mockDrafts.map((d) => ({ ...d })),
    logs: mockLogs.map((l) => ({ ...l })),
  };
}

async function post(path: string, body?: unknown) {
  try {
    await fetch(HTTP + path, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    /* backend absent : on reste en optimiste local */
  }
}

/** Live state via WebSocket, with mock fallback when the backend is offline. */
export function useTrame() {
  const [state, setState] = useState<TrameState>(mockState);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

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

  // Actions: optimistic local update + fire-and-forget to the backend.
  const setPaused = (p: boolean) => {
    setState((s) => ({ ...s, paused: p }));
    post("/api/pause", { paused: p });
  };
  const sendDraft = (id: string) => {
    setState((s) => ({ ...s, drafts: s.drafts.filter((d) => d.id !== id) }));
    post(`/api/drafts/${id}/send`);
  };
  const dismissDraft = (id: string) => {
    setState((s) => ({ ...s, drafts: s.drafts.filter((d) => d.id !== id) }));
    post(`/api/drafts/${id}/dismiss`);
  };
  const toggleWatch = (threadId: string) =>
    setState((s) => {
      const next = s.watchlist.map((w) => (w.threadId === threadId ? { ...w, watch: !w.watch } : w));
      const now = next.find((w) => w.threadId === threadId);
      if (now) post(`/api/watch/${threadId}`, { watch: now.watch });
      return { ...s, watchlist: next };
    });
  const setMode = (threadId: string, mode: "draft" | "auto") => {
    setState((s) => ({
      ...s,
      watchlist: s.watchlist.map((w) => (w.threadId === threadId ? { ...w, mode } : w)),
    }));
    post(`/api/mode/${threadId}`, { mode });
  };

  return { state, connected, setPaused, sendDraft, dismissDraft, toggleWatch, setMode };
}

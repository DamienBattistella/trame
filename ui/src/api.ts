import { useEffect, useRef, useState } from "react";
import {
  Brain,
  Brief,
  DraftItem,
  Effort,
  GithubLogin,
  GithubStatus,
  ClaudeStatus,
  ThreadMessage,
  PeopleSummary,
  Person,
  LogItem,
  Mode,
  Settings,
  SettingsPatch,
  Surface,
  WatchEntity,
} from "@/types";
import { mockBrief, mockConversations, mockDrafts, mockLogs } from "@/mockData";
import { isDesktop } from "@/desktop";

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

export type Result<T = {}> = ({ ok: true; error?: undefined } & T) | { ok: false; error: string; status?: number };

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
    rank: typeof w.rank === "number" ? w.rank : null,
    lastActivity: w.last_activity ?? null,
    unread: Boolean(w.unread),
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
    senderLabel: d.sender_label ?? undefined,
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
  const b = s?.brief ?? {};
  return {
    onboarded: Boolean(s?.onboarded),
    brain: s?.brain === "copilot" ? "copilot" : "claude",
    models: {
      claudeModel: String(s?.models?.claude_model ?? "haiku"),
      claudeEffort: (s?.models?.claude_effort ?? "") as Effort,
      copilotModel: String(s?.models?.copilot_model ?? "gpt-6-luna"),
      copilotEffort: (s?.models?.copilot_effort ?? "low") as Effort,
    },
    github: { enabled: Boolean(g.enabled), allRepos: Boolean(g.all_repos) },
    safety: {
      autoPauseOnScreenShare: Boolean(f.auto_pause_on_screen_share),
      selftestGate: Boolean(f.selftest_gate),
      countdownSeconds: Number(f.countdown_seconds ?? 5),
      neverAutoSendIfMessageContains: Array.isArray(f.never_auto_send_if_message_contains)
        ? f.never_auto_send_if_message_contains
        : [],
    },
    brief: {
      enabled: b.enabled === undefined ? true : Boolean(b.enabled),
      lastMessages: Number(b.last_messages ?? 30),
    },
    telemetry: {
      enabled: Boolean(s?.telemetry?.enabled),
      endpoint: String(s?.telemetry?.endpoint ?? ""),
      includeContent: Boolean(s?.telemetry?.include_content),
    },
    mcp: { enabled: Boolean(s?.mcp?.enabled), token: String(s?.mcp?.token ?? ""), allowSend: Boolean(s?.mcp?.allow_send) },
    teamsWeb: { enabled: Boolean(s?.teams_web?.enabled) },
  };
}
function mapBrief(b: any): Brief {
  return {
    threadId: b.thread_id,
    displayName: b.display_name,
    generatedAt: b.generated_at,
    summary: b.summary ?? "",
    openPoints: b.open_points ?? [],
    topics: b.topics ?? [],
    githubEnabled: Boolean(b.github_enabled),
    github: (b.github ?? []).map((g: any) => ({
      kind: g.kind,
      repo: g.repo,
      number: g.number ?? null,
      title: g.title,
      state: g.state ?? null,
      url: g.url,
      why: g.why ?? "",
    })),
    sources: { messages: Number(b.sources?.messages ?? 0), reposSearched: Number(b.sources?.repos_searched ?? 0) },
  };
}
function mapPeople(p: any): PeopleSummary {
  return {
    loaded: Boolean(p?.loaded),
    count: Number(p?.count ?? 0),
    source: typeof p?.source === "string" ? p.source : null,
    generatedAt: typeof p?.generated_at === "string" ? p.generated_at : null,
  };
}
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
function mapPerson(p: any): Person {
  return {
    name: String(p?.name ?? ""),
    aliases: Array.isArray(p?.aliases) ? p.aliases.filter((a: unknown) => typeof a === "string") : [],
    role: text(p?.role),
    team: text(p?.team),
    relation: text(p?.relation),
    tone: text(p?.tone),
    note: text(p?.note),
  };
}
let demoPeople: PeopleSummary = { loaded: false, count: 0, source: null, generatedAt: null };
let demoPeopleList: Person[] = [];

function mapClaudeStatus(c: any): ClaudeStatus {
  return {
    installed: Boolean(c?.installed),
    loggedIn: Boolean(c?.logged_in),
    account: typeof c?.account === "string" && c.account ? c.account : null,
    plan: typeof c?.plan === "string" && c.plan ? c.plan : null,
    loginPending: Boolean(c?.login_pending),
    loginUrl: typeof c?.login_url === "string" && c.login_url ? c.login_url : null,
  };
}
// Démo : Claude installé, pas encore connecté ; la connexion aboutit après quelques secondes.
let demoClaude: ClaudeStatus = { installed: true, loggedIn: false, account: null, plan: null, loginPending: false, loginUrl: null };
let demoClaudeLoginAt = 0;

function mapGithubStatus(g: any): GithubStatus {
  return {
    installed: Boolean(g?.installed),
    loggedIn: Boolean(g?.logged_in),
    account: typeof g?.account === "string" && g.account ? g.account : null,
    scopes: Array.isArray(g?.scopes) ? g.scopes : [],
    ssoBlocked: Array.isArray(g?.sso_blocked) ? g.sso_blocked : [],
    loginPending: Boolean(g?.login_pending),
    loginResult: g?.login_result === "ok" || g?.login_result === "failed" ? g.login_result : null,
    loginError: typeof g?.login_error === "string" && g.login_error ? g.login_error : null,
  };
}
function settingsPatchToWire(p: SettingsPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.onboarded !== undefined) out.onboarded = p.onboarded;
  if (p.brain !== undefined) out.brain = p.brain;
  if (p.models) {
    const m: Record<string, unknown> = {};
    if (p.models.claudeModel !== undefined) m.claude_model = p.models.claudeModel;
    if (p.models.claudeEffort !== undefined) m.claude_effort = p.models.claudeEffort;
    if (p.models.copilotModel !== undefined) m.copilot_model = p.models.copilotModel;
    if (p.models.copilotEffort !== undefined) m.copilot_effort = p.models.copilotEffort;
    out.models = m;
  }
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
  if (p.brief) {
    const b: Record<string, unknown> = {};
    if (p.brief.enabled !== undefined) b.enabled = p.brief.enabled;
    if (p.brief.lastMessages !== undefined) b.last_messages = p.brief.lastMessages;
    out.brief = b;
  }
  if (p.telemetry) {
    const t: Record<string, unknown> = {};
    if (p.telemetry.enabled !== undefined) t.enabled = p.telemetry.enabled;
    if (p.telemetry.endpoint !== undefined) t.endpoint = p.telemetry.endpoint;
    if (p.telemetry.includeContent !== undefined) t.include_content = p.telemetry.includeContent;
    out.telemetry = t;
  }
  if (p.mcp) {
    const m: Record<string, unknown> = {};
    if (p.mcp.enabled !== undefined) m.enabled = p.mcp.enabled;
    if (p.mcp.regenerateToken) m.regenerate_token = true;
    if (p.mcp.allowSend !== undefined) m.allow_send = p.mcp.allowSend;
    out.mcp = m;
  }
  if (p.teamsWeb?.enabled !== undefined) out.teams_web = { enabled: p.teamsWeb.enabled };
  return out;
}
export function mergeSettings(s: Settings, p: SettingsPatch): Settings {
  return {
    ...s,
    ...(p.onboarded !== undefined && { onboarded: p.onboarded }),
    ...(p.brain !== undefined && { brain: p.brain }),
    models: { ...s.models, ...p.models },
    github: { ...s.github, ...p.github },
    safety: { ...s.safety, ...p.safety },
    brief: { ...s.brief, ...p.brief },
    telemetry: { ...s.telemetry, ...p.telemetry },
    teamsWeb: { enabled: p.teamsWeb?.enabled ?? s.teamsWeb.enabled },
    mcp: {
      enabled: p.mcp?.enabled ?? s.mcp.enabled,
      token: p.mcp?.enabled && !s.mcp.token ? "demo-jeton-local" : s.mcp.token,
      allowSend: p.mcp?.allowSend ?? s.mcp.allowSend,
    },
  };
}

/** État initial : exemple dans un navigateur sans moteur, vide dans l'application
 *  (jamais de fausses conversations à l'écran d'un vrai poste). */
function mockState(): TrameState {
  if (isDesktop()) {
    return { paused: false, screenSharing: false, brain: "claude", selftestOk: false, onboarded: false, watchlist: [], drafts: [], logs: [] };
  }
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
  models: { claudeModel: "haiku", claudeEffort: "", copilotModel: "gpt-6-luna", copilotEffort: "low" },
  github: { enabled: true, allRepos: true },
  safety: {
    autoPauseOnScreenShare: true,
    selftestGate: true,
    countdownSeconds: 5,
    neverAutoSendIfMessageContains: ["RH", "confidentiel", "salaire"],
  },
  brief: { enabled: true, lastMessages: 30 },
  telemetry: { enabled: false, endpoint: "", includeContent: false },
  mcp: { enabled: false, token: "", allowSend: false },
  teamsWeb: { enabled: false },
};
const localBriefs = new Map<string, Brief>();

// GitHub du mode démo : non connecté au départ, connecté ~6 s après le début de la connexion.
const DEMO_GITHUB_ACCOUNT = "Wifsimster";
const DEMO_LOGIN_MS = 6000;
let localGithub: GithubStatus = {
  installed: true,
  loggedIn: false,
  account: null,
  scopes: [],
  ssoBlocked: [],
  loginPending: false,
};
let localLoginStartedAt = 0;
function demoGithubStatus(): GithubStatus {
  if (localGithub.loginPending && Date.now() - localLoginStartedAt >= DEMO_LOGIN_MS) {
    localGithub = {
      ...localGithub,
      loggedIn: true,
      loginPending: false,
      account: DEMO_GITHUB_ACCOUNT,
      scopes: ["repo", "read:org"],
    };
  }
  return localGithub;
}

export type BriefPrefs = Settings["brief"] & { github: boolean };
const prefsOf = (s: Settings): BriefPrefs => ({ ...s.brief, github: s.github.enabled });

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
      return { ok: false, error, status: res.status };
    }
    return { ...(data ?? {}), ok: true } as Result<T>;
  } catch {
    return { ok: false, error: "Le moteur Trame est injoignable." };
  }
}

const OFFLINE = "Le moteur Trame est injoignable : rien n'a été fait. Réessaie dans un instant.";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Live state via WebSocket, with mock fallback when the backend is offline. */
export function useTrame() {
  const [state, setState] = useState<TrameState>(mockState);
  const [connected, setConnected] = useState(false);
  const [everConnected, setEverConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const connectedRef = useRef(false);
  connectedRef.current = connected;
  // Démo (données d'exemple, actions simulées) : seulement dans un navigateur qui n'a
  // jamais vu le moteur. Dans l'application, ou après une coupure, une action hors
  // ligne échoue franchement : jamais de faux « Envoyé ».
  const demoMode = !isDesktop() && !everConnected;
  const demoRef = useRef(demoMode);
  demoRef.current = demoMode;
  const stateRef = useRef(state);
  stateRef.current = state;
  // Copie des réglages du brief, utile aux points d'entrée hors de l'onglet Réglages.
  const [briefPrefs, setBriefPrefs] = useState<BriefPrefs>(prefsOf(localSettings));
  // Dernier état connu de la connexion GitHub (null tant qu'il n'a pas été vérifié).
  const [githubStatus, setGithubStatus] = useState<GithubStatus | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastFrame = "";

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
      ws.onopen = () => {
        if (closed) return;
        setConnected(true);
        setEverConnected(true);
      };
      ws.onmessage = (e) => {
        if (closed) return;
        // Trame identique à la précédente (keep-alive) : aucun re-rendu.
        if (e.data === lastFrame) return;
        lastFrame = e.data;
        try {
          setState(mapState(JSON.parse(e.data)));
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        lastFrame = "";
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

  /** Hors backend : succès simulé en démo, échec explicite sinon. */
  const demo = async <T,>(ms: number, data: T): Promise<Result<T>> => {
    if (!demoRef.current) return { ok: false, error: OFFLINE };
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
    if (!connectedRef.current && !demoRef.current) return { ok: false, error: OFFLINE };
    patchWatch(next);
    if (!connectedRef.current) return { ok: true };
    const res = await send();
    if (!res.ok) patchWatch(prev);
    return res;
  };

  /** Optimiste, mais annulé si le moteur ne confirme pas : la pause doit être réelle. */
  const setPaused = async (p: boolean): Promise<Result> => {
    if (!connectedRef.current && !demoRef.current) return { ok: false, error: OFFLINE };
    setState((s) => ({ ...s, paused: p }));
    if (!connectedRef.current) return { ok: true };
    const res = await request("POST", "/api/pause", { paused: p });
    if (!res.ok) setState((s) => ({ ...s, paused: !p }));
    return res;
  };

  /** Le retrait de la carte est fait par l'UI après l'animation « Envoyé » (removeDraft). */
  const sendDraft = (id: string, text: string): Promise<Result> =>
    connectedRef.current ? request("POST", `/api/drafts/${encodeURIComponent(id)}/send`, { text }) : demo(700, {});
  /** Ouvre la conversation dans Teams et tape le texte, sans envoyer. */
  const composeDraft = (id: string, text: string): Promise<Result> =>
    connectedRef.current ? request("POST", `/api/drafts/${encodeURIComponent(id)}/compose`, { text }) : demo(900, {});
  const removeDraft = (id: string) =>
    setState((s) => ({ ...s, drafts: s.drafts.filter((d) => d.id !== id) }));
  const dismissDraft = async (id: string): Promise<Result> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      removeDraft(id);
      return { ok: true };
    }
    const res = await request("POST", `/api/drafts/${encodeURIComponent(id)}/dismiss`);
    if (res.ok) {
      removeDraft(id);
      return res;
    }
    if (res.status === 404) {
      removeDraft(id);
      return { ok: true };
    }
    return res;
  };
  const catchUp = (): Promise<Result<{ queued: number }>> =>
    connectedRef.current ? request<{ queued: number }>("POST", "/api/catchup") : demo(1200, { queued: 0 });

  const getSettings = async (): Promise<Result<{ settings: Settings }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      setBriefPrefs(prefsOf(localSettings));
      return { ok: true, settings: localSettings };
    }
    const res = await request<{ settings: unknown }>("GET", "/api/settings");
    if (!res.ok) return res;
    const settings = mapSettings(res.settings);
    setBriefPrefs(prefsOf(settings));
    return { ok: true, settings };
  };
  useEffect(() => {
    getSettings();
  }, [connected]);
  const updateSettings = async (patch: SettingsPatch): Promise<Result<{ settings: Settings }>> => {
    if (!connectedRef.current && !demoRef.current) return { ok: false, error: OFFLINE };
    if (patch.brain) setState((s) => ({ ...s, brain: patch.brain! }));
    if (!connectedRef.current) {
      await wait(350);
      localSettings = mergeSettings(localSettings, patch);
      setBriefPrefs(prefsOf(localSettings));
      return { ok: true, settings: localSettings };
    }
    const res = await request<{ settings: unknown }>("PUT", "/api/settings", settingsPatchToWire(patch));
    if (!res.ok) return res;
    const settings = mapSettings(res.settings);
    setState((s) => ({ ...s, brain: settings.brain, onboarded: settings.onboarded }));
    setBriefPrefs(prefsOf(settings));
    return { ok: true, settings };
  };

  /** Échoue si une conversation n'est plus connue de Teams : rien n'est « suivi » en silence. */
  const saveWatchlist = async (entries: WatchlistEntry[]): Promise<Result<{ count: number }>> => {
    if (!connectedRef.current) return demo(500, { count: entries.length });
    const res = await request<{ count: number; missing?: string[] }>(
      "PUT",
      "/api/watchlist",
      entries.map((e) => ({ thread_id: e.threadId, watch: e.watch, mode: e.mode }))
    );
    if (!res.ok) return res;
    const missing = res.missing?.length ?? 0;
    if (missing > 0) {
      return {
        ok: false,
        error: `${missing} conversation${missing > 1 ? "s" : ""} introuvable${missing > 1 ? "s" : ""} dans Teams. Recharge la liste et réessaie.`,
      };
    }
    return { ok: true, count: res.count };
  };

  /** Entourage (ENTOURAGE.json exporté d'Orbite) : qui est qui, pour adapter les réponses. */
  const getPeople = async (): Promise<Result<{ people: PeopleSummary }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      return { ok: true, people: { ...demoPeople } };
    }
    const res = await request<{ people: any }>("GET", "/api/people");
    if (!res.ok) return res;
    return { ok: true, people: mapPeople(res.people) };
  };
  /** L'entourage personne par personne, pour l'annuaire des réglages. */
  const listPeople = async (): Promise<Result<{ list: Person[] }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      return { ok: true, list: [...demoPeopleList] };
    }
    const res = await request<{ people: any[] }>("GET", "/api/people/list");
    if (!res.ok) return res;
    return { ok: true, list: (res.people ?? []).map(mapPerson).filter((p) => p.name) };
  };
  const uploadPeople = async (filename: string, content: string): Promise<Result<{ people: PeopleSummary }>> => {
    if (!/\.json$/i.test(filename)) return { ok: false, error: "Le fichier doit être un .json exporté d'Orbite." };
    if (new Blob([content]).size > 512 * 1024) return { ok: false, error: "Le fichier dépasse 512 Ko." };
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(400);
      try {
        demoPeopleList = (JSON.parse(content)?.people ?? []).map(mapPerson).filter((p: Person) => p.name);
        demoPeople = { loaded: true, count: demoPeopleList.length, source: "Orbite", generatedAt: new Date().toISOString() };
      } catch {
        return { ok: false, error: "Fichier illisible : JSON invalide." };
      }
      return { ok: true, people: { ...demoPeople } };
    }
    const res = await request<{ people: any }>("POST", "/api/people", { filename, content });
    return res.ok ? { ok: true, people: mapPeople(res.people) } : res;
  };
  const removePeople = async (): Promise<Result> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      demoPeople = { loaded: false, count: 0, source: null, generatedAt: null };
      demoPeopleList = [];
      return { ok: true };
    }
    return request("DELETE", "/api/people");
  };

  /** Modèle de SOUL.md pré-rempli avec ce que Teams sait déjà (nom, groupes, messages récents). */
  const getSoulTemplate = async (): Promise<Result<{ content: string }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(500);
      return {
        ok: true,
        content:
          "# SOUL — Toi\n\n## Qui je suis\n- Nom : Toi\n- Rôle : <ton poste, ton équipe>\n- Sujets du moment : Équipe Interop, Projet FHIR Passerelle\n\n## Ton et style\n- Direct et cordial, sans formules toutes faites.\n\n## Tu ou vous\n- Je tutoie mon équipe ; je vouvoie les clients.\n\n## Longueur\n- Une à trois phrases.\n\n## Ce que Trame doit refuser\n- Jamais d'engagement de date à ma place.\n\n## Exemples de messages écrits par moi\n> Je regarde ça ce soir et je te dis.\n",
      };
    }
    return request<{ content: string }>("GET", "/api/soul/template");
  };

  /** SOUL.md déposé précédemment (null si c'est encore celui livré par défaut). */
  const getSoul = async (): Promise<Result<{ soul: { filename: string; content: string } | null }>> => {
    if (!connectedRef.current) return { ok: true, soul: null };
    const res = await request<{ soul: { custom: boolean; filename: string; content: string } }>("GET", "/api/soul");
    if (!res.ok) return res;
    return { ok: true, soul: res.soul.custom ? { filename: res.soul.filename, content: res.soul.content } : null };
  };

  /** Réponse type rédigée avec ce persona (rien n'est enregistré). */
  const previewSoul = async (content: string): Promise<Result<{ incoming: string; reply: string }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(1800);
      return {
        ok: true,
        incoming: "Salut, tu peux jeter un œil à la PR #214 avant demain ? Je bloque sur le mapping OBX.",
        reply: "Oui, je regarde ce soir. Pour OBX, vérifie d'abord le type en OBX-2 : c'est souvent là que ça coince.",
      };
    }
    return request<{ incoming: string; reply: string }>("POST", "/api/soul/preview", { content });
  };

  /** Mode manuel : historique d'une conversation, réponse tapée à la main, proposition, ouverture dans Teams. */
  const threadMessages = async (threadId: string, fresh = false): Promise<Result<{ messages: ThreadMessage[] }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(700);
      const conv = stateRef.current.watchlist.find((w) => w.threadId === threadId);
      const who = conv?.displayName ?? "Quelqu'un";
      return {
        ok: true,
        messages: [
          { sender: who, text: "Salut, tu as vu le ticket sur le mapping OBX ?", at: "09:12", mine: false },
          { sender: "Toi", text: "Oui, je regarde ce matin.", at: "09:14", mine: true },
          { sender: who, text: "Top. Tu peux relire la PR #214 avant ce soir ?", at: "10:02", mine: false },
        ],
      };
    }
    return request<{ messages: ThreadMessage[] }>(
      "GET",
      `/api/threads/${encodeURIComponent(threadId)}/messages${fresh ? "?fresh=true" : ""}`
    );
  };
  const sendInThread = async (threadId: string, text: string): Promise<Result> => {
    if (!connectedRef.current) return demo(800, {});
    return request("POST", `/api/threads/${encodeURIComponent(threadId)}/send`, { text });
  };
  const suggestInThread = async (threadId: string): Promise<Result<{ text: string }>> => {
    if (!connectedRef.current) return demo(1500, { text: "Oui, je la relis cet après-midi et je te fais un retour avant 17 h." });
    return request<{ text: string }>("POST", `/api/threads/${encodeURIComponent(threadId)}/suggest`);
  };
  const showInTeams = async (threadId: string): Promise<Result> => {
    if (!connectedRef.current) return demo(400, {});
    return request("POST", `/api/threads/${encodeURIComponent(threadId)}/show`);
  };

  /** Journal, fin du backend.log et dernières traces OpenTelemetry, en un seul texte. */
  const exportLogs = async (): Promise<Result<{ filename: string; text: string }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      const lines = stateRef.current.logs.map((l) => `${l.at}  ${l.level.padEnd(5)}  ${l.text}`);
      return { ok: true, filename: "trame-journaux-demo.txt", text: ["# Trame : journaux (démo)", "", "## Journal", ...lines].join("\n") + "\n" };
    }
    return request<{ filename: string; text: string }>("GET", "/api/logs/export");
  };

  /** Teams intégré : état du pont (relais, page prête, titre). */
  const teamsWebStatus = async (): Promise<Result<{ status: { enabled: boolean; relay?: boolean; ready?: boolean; title?: string; error?: string } }>> => {
    if (!connectedRef.current) return demo(200, { status: { enabled: false } });
    return request("GET", "/api/teams-web/status");
  };

  /** Diagnostic de calibration du pilote Teams (structure seulement, pas le texte des messages). */
  const diagnoseTeams = async (threadId?: string): Promise<Result<{ report: unknown }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(800);
      return { ok: true, report: { driver: "démo", note: "Diagnostic disponible avec le moteur sur ton poste." } };
    }
    return request<{ report: unknown }>("POST", "/api/diagnostics/teams", { thread_id: threadId ?? null });
  };

  /** Zone de danger : réglages par défaut, plus rien de suivi, configuration à refaire. */
  const factoryReset = async (): Promise<Result> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(600);
      setState((s) => ({ ...s, drafts: [], logs: [], onboarded: false, watchlist: s.watchlist.map((w) => ({ ...w, watch: false, mode: "draft" })) }));
      return { ok: true };
    }
    return request("POST", "/api/reset", { confirm: "RESET" });
  };

  const uploadSoul = async (filename: string, content: string): Promise<Result> => {
    if (!/\.(md|txt)$/i.test(filename)) return { ok: false, error: "Seuls les fichiers .md ou .txt sont acceptés." };
    if (new Blob([content]).size > SOUL_MAX_BYTES) return { ok: false, error: "Le fichier dépasse 64 Ko." };
    return connectedRef.current ? request("POST", "/api/soul", { filename, content }) : demo(500, {});
  };

  /** Dernier brief en cache ; `brief: null` s'il n'y en a pas encore (404 : conversation inconnue). */
  const getBrief = async (threadId: string): Promise<Result<{ brief: Brief | null }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      return { ok: true, brief: localBriefs.get(threadId) ?? null };
    }
    const res = await request<{ brief: unknown }>("GET", `/api/threads/${encodeURIComponent(threadId)}/brief`);
    if (!res.ok) return res;
    return { ok: true, brief: res.brief ? mapBrief(res.brief) : null };
  };
  const generateBrief = async (threadId: string, lastMessages?: number): Promise<Result<{ brief: Brief }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(3600);
      const conv = stateRef.current.watchlist.find((w) => w.threadId === threadId);
      const brief = mockBrief(threadId, conv?.displayName ?? "Conversation", {
        lastMessages: lastMessages ?? localSettings.brief.lastMessages,
        github: localSettings.github.enabled,
      });
      if (!demoGithubStatus().loggedIn) {
        brief.github = [];
        brief.sources = { ...brief.sources, reposSearched: 0 };
      }
      localBriefs.set(threadId, brief);
      return { ok: true, brief };
    }
    const res = await request<{ brief: unknown }>(
      "POST",
      `/api/threads/${encodeURIComponent(threadId)}/brief`,
      lastMessages !== undefined ? { last_messages: lastMessages } : {}
    );
    return res.ok ? { ok: true, brief: mapBrief(res.brief) } : res;
  };

  const getClaudeStatus = async (): Promise<Result<{ claude: ClaudeStatus }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(250);
      if (demoClaude.loginPending && Date.now() - demoClaudeLoginAt > 4000) {
        demoClaude = { ...demoClaude, loggedIn: true, loginPending: false, loginUrl: null, account: "toi@exemple.fr", plan: "Max" };
      }
      setClaudeStatus({ ...demoClaude });
      return { ok: true, claude: { ...demoClaude } };
    }
    const res = await request<{ claude: unknown }>("GET", "/api/brain/claude/status");
    if (!res.ok) return res;
    const claude = mapClaudeStatus(res.claude);
    setClaudeStatus(claude);
    return { ok: true, claude };
  };
  useEffect(() => {
    getClaudeStatus();
  }, [connected]);
  /** Lance `claude auth login` : le navigateur s'ouvre ; loginUrl sert de lien de secours. */
  const claudeLogin = async (): Promise<Result<{ loginUrl: string | null }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(600);
      demoClaude = { ...demoClaude, loginPending: true, loginUrl: "https://claude.ai/oauth/authorize" };
      demoClaudeLoginAt = Date.now();
      return { ok: true, loginUrl: demoClaude.loginUrl };
    }
    const res = await request<{ login_url: string | null }>("POST", "/api/brain/claude/login");
    return res.ok ? { ok: true, loginUrl: res.login_url ?? null } : res;
  };
  const cancelClaudeLogin = async (): Promise<Result> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      demoClaude = { ...demoClaude, loginPending: false, loginUrl: null };
      return { ok: true };
    }
    return request("POST", "/api/brain/claude/login/cancel");
  };

  const getGithubStatus = async (): Promise<Result<{ github: GithubStatus }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(250);
      const github = { ...demoGithubStatus() };
      setGithubStatus(github);
      return { ok: true, github };
    }
    const res = await request<{ github: unknown }>("GET", "/api/github/status");
    if (!res.ok) return res;
    const github = mapGithubStatus(res.github);
    setGithubStatus(github);
    return { ok: true, github };
  };
  useEffect(() => {
    getGithubStatus();
  }, [connected]);
  /** Démarre la connexion par code (device flow) ; elle aboutit quand le code est saisi sur GitHub. */
  const githubLogin = async (): Promise<Result<GithubLogin>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(700);
      const cur = demoGithubStatus();
      if (cur.loggedIn) return { ok: false, error: "Tu es déjà connecté à GitHub.", status: 409 };
      localGithub = { ...cur, loginPending: true };
      localLoginStartedAt = Date.now();
      return { ok: true, code: "8F3A-2C1D", verificationUrl: "https://github.com/login/device" };
    }
    const res = await request<{ code: string; verification_url: string }>("POST", "/api/github/login");
    if (!res.ok) return res;
    return { ok: true, code: res.code, verificationUrl: res.verification_url || "https://github.com/login/device" };
  };
  const cancelGithubLogin = async (): Promise<Result> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(300);
      localGithub = { ...localGithub, loginPending: false };
      return { ok: true };
    }
    return request("POST", "/api/github/login/cancel");
  };

  /** Auto-test réel des repères de Teams (fenêtre, messages, zone de saisie). */
  const selftest = async (): Promise<Result<{ selftestOk: boolean }>> => {
    if (!connectedRef.current) return demo(1800, { selftestOk: true });
    const res = await request<{ selftest_ok: boolean }>("POST", "/api/selftest");
    if (!res.ok) return res;
    setState((s) => ({ ...s, selftestOk: Boolean(res.selftest_ok) }));
    return { ok: true, selftestOk: Boolean(res.selftest_ok) };
  };

  const toggleWatch = (threadId: string) => {
    const cur = stateRef.current.watchlist.find((w) => w.threadId === threadId);
    if (!cur) return Promise.resolve<Result>({ ok: true });
    const watch = !cur.watch;
    return applyWatch([{ threadId, watch, mode: cur.mode }], () =>
      request("POST", `/api/watch/${encodeURIComponent(threadId)}`, { watch })
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
      request("POST", `/api/mode/${encodeURIComponent(threadId)}`, { mode })
    );
  };

  return {
    state,
    connected,
    everConnected,
    demoMode,
    setPaused,
    sendDraft,
    composeDraft,
    removeDraft,
    dismissDraft,
    catchUp,
    getSettings,
    updateSettings,
    briefPrefs,
    getBrief,
    generateBrief,
    githubStatus,
    getGithubStatus,
    claudeStatus,
    getClaudeStatus,
    claudeLogin,
    cancelClaudeLogin,
    githubLogin,
    cancelGithubLogin,
    saveWatchlist,
    uploadSoul,
    getSoul,
    getSoulTemplate,
    factoryReset,
    threadMessages,
    sendInThread,
    suggestInThread,
    showInTeams,
    diagnoseTeams,
    teamsWebStatus,
    exportLogs,
    previewSoul,
    getPeople,
    listPeople,
    uploadPeople,
    removePeople,
    selftest,
    toggleWatch,
    setWatchMany,
    setMode,
  };
}

export type Trame = ReturnType<typeof useTrame>;
export { SOUL_MAX_BYTES };

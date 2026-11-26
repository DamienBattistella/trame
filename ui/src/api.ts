import { useEffect, useRef, useState } from "react";
import {
  Brain,
  Brief,
  BriefGithubItem,
  GithubState,
  FactCheck,
  DraftItem,
  Effort,
  GithubLogin,
  GithubStatus,
  ClaudeStatus,
  ThreadActivity,
  ThreadMessage,
  PeopleSearch,
  PeopleSummary,
  Person,
  PersonSuggestion,
  LogFilters,
  LogItem,
  LogPage,
  MessageHit,
  Mode,
  MessageRef,
  Notice,
  SearchScope,
  Reaction,
  Settings,
  SettingsPatch,
  Surface,
  WatchEntity,
  AttachmentLimits,
  PendingFile,
  Presence,
  StatusChoice, StatusDuration,
  ReflectionRun,
} from "@/types";
import { mockBrief, mockConversations, mockDrafts, mockLogs } from "@/mockData";
import { isDesktop, notificationsEnabled, notify } from "@/desktop";
import { DemoArchive, demoTeamsSearch } from "@/lib/textSearch";
import type { GithubRef } from "@/lib/linkify";
import { DEFAULT_LIMITS } from "@/lib/attachments";
import { filterLogs, isFiltered, logParams } from "@/lib/logFilters";
import { demoCorrect } from "@/lib/demoCorrect";
import { playDemoReflection, type DemoPlan } from "@/lib/demoReflection";

/** Moteur Trame local. VITE_TRAME_PORT ne sert qu'au dev, pour un moteur de test. */
export const ENGINE = `127.0.0.1:${import.meta.env.VITE_TRAME_PORT || "8731"}`;
const HTTP = `http://${ENGINE}`;
const WS = `ws://${ENGINE}/ws`;
const SOUL_MAX_BYTES = 64 * 1024;
/** Réponse du moteur à une action annulée depuis le panneau Réflexion : pas une erreur à signaler. */
export const CANCELLED = "Action annulée.";
const MAX_REFLECTIONS = 20;

export interface TrameState {
  paused: boolean;
  screenSharing: boolean;
  brain: Brain;
  selftestOk: boolean;
  onboarded: boolean;
  watchlist: WatchEntity[];
  drafts: DraftItem[];
  logs: LogItem[];
  notices: Notice[];
  /** Gestes que le pilote Teams actif sait faire : réagir, répondre à un message précis. */
  capabilities: { react: boolean; reply: boolean; mentions: boolean; ownStatus: boolean; delete: boolean };
  /** Son propre statut Teams, tel que Teams l'affiche ; null quand il ne le dit pas. */
  myPresence: Presence | null;
  /** Messages envoyés quand Teams n'était pas prêt : ils partent dès qu'il l'est. */
  outbox: QueuedSend[];
  /** Dernier contrôle des repères de la page Teams ; null tant qu'il n'a pas tourné. */
  teamsCheck: TeamsCheck | null;
}

/** Un repère de la page Teams dont dépend Trame, introuvable. how « page » : absent au
 *  contrôle ; « usage » : absent quand une opération s'en est servie (menus). */
export interface TeamsLandmark {
  key: string;
  label: string;
  features: string[];
  how: "page" | "usage";
  at: string;
}

/** Contrôle de la page Teams web : summary dit ce qui ne marchera plus, vide si rien ne manque. */
export interface TeamsCheck {
  at: string;
  ok: boolean;
  summary: string;
  missing: TeamsLandmark[];
  verified: number;
  unverified: number;
}

function mapTeamsCheck(c: any): TeamsCheck | null {
  if (!c || typeof c !== "object") return null;
  return {
    at: String(c.at ?? ""),
    ok: Boolean(c.ok),
    summary: String(c.summary ?? ""),
    missing: (c.missing ?? []).map((m: any) => ({
      key: String(m.key),
      label: String(m.label ?? m.key),
      features: Array.isArray(m.features) ? m.features.map(String) : [],
      how: m.how === "usage" ? "usage" : "page",
      at: String(m.at ?? ""),
    })),
    verified: Number(c.verified ?? 0),
    unverified: Number(c.unverified ?? 0),
  };
}

/** Un message en file d'envoi. waiting : en attente ; sending : en cours ; failed :
 *  refusé, à ton action ; uncertain : peut-être parti, à vérifier dans Teams. */
export interface QueuedSend {
  id: string;
  threadId: string;
  conversation: string;
  text: string;
  files: string[];
  queuedAt: string;
  attempts: number;
  status: "waiting" | "sending" | "failed" | "uncertain";
  reason: string;
}

function mapQueued(q: any): QueuedSend {
  return {
    id: q.id,
    threadId: q.thread_id,
    conversation: q.conversation,
    text: q.text ?? "",
    files: q.files ?? [],
    queuedAt: q.queued_at ?? "",
    attempts: Number(q.attempts ?? 0),
    status: q.status ?? "waiting",
    reason: q.reason ?? "",
  };
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
    presence: w.presence ?? null,
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
    notices: (s.notices ?? []).map((n: any) => ({
      id: n.id,
      threadId: n.thread_id,
      conversation: n.conversation,
      from: n.from,
      text: n.text,
      at: n.at,
      surface: n.surface as Surface,
    })),
    capabilities: {
      react: Boolean(s.capabilities?.react),
      reply: Boolean(s.capabilities?.reply),
      mentions: Boolean(s.capabilities?.mentions),
      ownStatus: Boolean(s.capabilities?.own_status),
      delete: Boolean(s.capabilities?.delete),
    },
    myPresence: s.my_presence ?? null,
    outbox: (s.outbox ?? []).map(mapQueued),
    teamsCheck: mapTeamsCheck(s.teams_check),
  };
}
/** Un message précis, tel que le moteur le vérifie dans Teams (auteur et texte). */
function messageRef(m: MessageRef) {
  return { id: m.id ?? null, sender: m.sender, text: m.text, at: m.at };
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
      markAutoReplies: f.mark_auto_replies === undefined ? true : Boolean(f.mark_auto_replies),
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
function mapCheck(c: any): FactCheck {
  return {
    threadId: c.thread_id,
    checkedAt: c.checked_at,
    claims: (c.claims ?? []).map((x: any) => ({ excerpt: x.excerpt, verdict: x.verdict, source: x.source ?? "", fix: x.fix ?? null })),
    sources: { messages: c.sources?.messages ?? 0, people: c.sources?.people ?? 0, github: c.sources?.github ?? 0 },
  };
}

/** Démo : relit le message contre le fil de démonstration (PR #214, « avant ce soir »). */
function demoCheck(threadId: string, who: string, text: string): FactCheck {
  const asked = `${who}, 10:02 : « Tu peux relire la PR #214 avant ce soir ? »`;
  const claims: FactCheck["claims"] = [];
  for (const m of text.matchAll(/#\d+/g)) {
    claims.push(m[0] === "#214"
      ? { excerpt: m[0], verdict: "ok", source: asked, fix: null }
      : { excerpt: m[0], verdict: "contredit", source: asked, fix: "#214" });
  }
  for (const m of text.matchAll(/\b\d{1,2} ?h(?: ?\d{2})?\b/gi)) {
    claims.push({ excerpt: m[0], verdict: "non_verifiable", source: asked, fix: "ce soir" });
  }
  const order = { contredit: 0, non_verifiable: 1, ok: 2 } as const;
  claims.sort((a, b) => order[a.verdict] - order[b.verdict]);
  const now = new Date();
  const at = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return { threadId, checkedAt: at, claims, sources: { messages: 3, people: 1, github: 0 } };
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
    github: (b.github ?? []).map(mapGithub),
    sources: { messages: Number(b.sources?.messages ?? 0), reposSearched: Number(b.sources?.repos_searched ?? 0) },
  };
}
function mapGithub(g: any): BriefGithubItem {
  return {
    kind: g.kind,
    repo: g.repo,
    number: g.number ?? null,
    title: g.title,
    state: g.state ?? null,
    url: g.url,
    why: g.why ?? "",
  };
}
const DEMO_LINK_STATES: GithubState[] = ["open", "merged", "closed"];
function mapHit(h: any): MessageHit {
  return {
    threadId: h.thread_id ?? null,
    conversation: h.conversation,
    sender: h.sender,
    at: h.at,
    mine: Boolean(h.mine),
    text: h.text,
    excerpt: h.excerpt,
    match: Array.isArray(h.match) ? [h.match[0], h.match[1]] : null,
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
    manager: text(p?.manager),
    relation: text(p?.relation),
    tone: text(p?.tone),
    note: text(p?.note),
  };
}
function mapSuggestion(p: any): PersonSuggestion {
  return {
    name: String(p?.name ?? ""),
    role: text(p?.role),
    team: text(p?.team),
    manager: text(p?.manager),
    source: p?.source === "teams" ? "teams" : "entourage",
    threadId: text(p?.thread_id),
  };
}
const foldName = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const wordsMatch = (name: string, query: string) => {
  const tokens = foldName(name).split(/[^a-z0-9]+/).filter(Boolean);
  const words = foldName(query).split(/[^a-z0-9]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => tokens.some((t) => t.startsWith(w)));
};
// Démo : un petit entourage et ce que la recherche de Teams trouverait en plus.
const DEMO_ENTOURAGE: Person[] = [
  { name: "Hugo Lannes", role: "Architecte", team: "Interop", manager: "Sofia Marino" },
  { name: "Élodie Faure", role: "Testeuse", team: "Qualité", manager: "Sofia Marino" },
  { name: "Lucas Bernard", role: "Développeur interop", team: "Hexagone", manager: "Sofia Marino" },
  { name: "Sofia Marino", role: "Cheffe de projet", team: "Interop", manager: null },
].map((p) => ({ aliases: [], relation: null, tone: null, note: null, ...p }));
const DEMO_TEAMS_PEOPLE = ["Alice Martin", "Antoine Girard", "Nadia Benali", "Thomas Petit"];
const demoStarted = new Set<string>();

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
    if (p.safety.markAutoReplies !== undefined) f.mark_auto_replies = p.safety.markAutoReplies;
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
    return { paused: false, screenSharing: false, brain: "claude", selftestOk: false, onboarded: false, watchlist: [], drafts: [], logs: [], notices: [], capabilities: { react: false, reply: false, mentions: false, ownStatus: false, delete: false }, myPresence: null, outbox: [], teamsCheck: null };
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
    notices: [],
    capabilities: { react: true, reply: true, mentions: true, ownStatus: true, delete: true },
    myPresence: "available",
    outbox: [],
    teamsCheck: null,
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
    markAutoReplies: true,
  },
  brief: { enabled: true, lastMessages: 30 },
  telemetry: { enabled: false, endpoint: "", includeContent: false },
  mcp: { enabled: false, token: "", allowSend: false },
  teamsWeb: { enabled: false },
};
const localBriefs = new Map<string, Brief>();
// Recherche du mode démo : comme le moteur, seuls les messages déjà lus (reçus ou ouverts).
const demoArchive = new DemoArchive();
for (const d of mockDrafts) demoArchive.add(d.threadId, [{ sender: d.from, text: d.incoming, at: d.receivedAt, mine: false }]);
/** Démo : message de statut. */
let demoStatusMessage = "";
/** Démo : réactions posées, par conversation et message. */
const demoReactions = new Map<string, Reaction[]>();
/** Mode démo : messages supprimés, par « conversation/id ». */
const demoDeleted = new Set<string>();
/** Ce que Teams affiche à la place d'un message supprimé. */
export const DELETED_TEXT = "Ce message a été supprimé.";

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

/** Seuls le nom, le type et le contenu partent : jamais un chemin sur le disque. */
const wireFiles = (files: PendingFile[]) => files.map(({ name, type, data }) => ({ name, type, data }));

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
  // Panneau Réflexion : les dernières actions de la zone de réponse, la plus récente d'abord.
  const [reflections, setReflections] = useState<ReflectionRun[]>([]);
  const demoStopped = useRef(new Set<string>());
  const upsertReflection = (run: ReflectionRun) =>
    setReflections((list) => {
      const i = list.findIndex((r) => r.id === run.id);
      if (i < 0) return [run, ...list].slice(0, MAX_REFLECTIONS);
      if (list[i].rev > run.rev) return list;
      const next = list.slice();
      next[i] = run;
      return next;
    });

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastFrame = "";
    // Les messages déjà annoncés. À la première trame après une connexion, tout ce qui
    // est là est ancien : on le note sans le rejouer.
    let announced: Set<string> | null = null;
    const announce = (next: TrameState) => {
      const fresh = announced ? next.notices.filter((n) => !announced!.has(n.id)) : [];
      announced = new Set(next.notices.map((n) => n.id));
      // Trame au premier plan : la liste montre déjà le message.
      if (!fresh.length || !notificationsEnabled() || document.hasFocus()) return;
      for (const n of fresh.reverse()) {
        const title = n.conversation && n.conversation !== n.from ? `${n.from} · ${n.conversation}` : n.from;
        notify(title, next.screenSharing ? "Nouveau message" : n.text);
      }
    };

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
        // Le moteur renvoie toutes ses actions à chaque connexion ; redémarré, il en recompte les numéros.
        setReflections([]);
      };
      ws.onmessage = (e) => {
        if (closed) return;
        // Trame identique à la précédente (keep-alive) : aucun re-rendu.
        if (e.data === lastFrame) return;
        lastFrame = e.data;
        try {
          const data = JSON.parse(e.data);
          // Trames à part : une action suivie dans le panneau Réflexion.
          if (data?.kind === "reflection") return upsertReflection(data.run as ReflectionRun);
          const next = mapState(data);
          announce(next);
          setState(next);
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        lastFrame = "";
        announced = null;
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

  /** Démo : rejoue la réflexion de l'action dans le panneau, puis rend le résultat simulé. */
  const demoReflect = async <T,>(plan: DemoPlan, data: T): Promise<Result<T>> => {
    if (!demoRef.current) return { ok: false, error: OFFLINE };
    const outcome = await playDemoReflection(plan, upsertReflection, (id) => demoStopped.current.has(id));
    return outcome === "done" ? ({ ok: true, ...data } as Result<T>) : { ok: false, error: CANCELLED, status: 409 };
  };
  const conversationName = (threadId: string | null) =>
    stateRef.current.watchlist.find((w) => w.threadId === threadId)?.displayName ?? null;

  /** Arrête une action en cours (le processus du cerveau est tué). */
  const cancelReflection = async (id: string): Promise<Result> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      demoStopped.current.add(id);
      return { ok: true };
    }
    return request("POST", `/api/reflections/${encodeURIComponent(id)}/cancel`);
  };

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

  /** Son statut Teams et son message de statut (le moteur ouvre puis referme le menu du profil). */
  const getMyStatus = async (): Promise<Result<{ presence: Presence | null; message: string }>> => {
    if (!connectedRef.current) return demo(300, { presence: stateRef.current.myPresence, message: demoStatusMessage });
    return request<{ presence: Presence | null; message: string }>("GET", "/api/me/status");
  };
  /** Change son statut dans Teams ; réussi seulement si Teams affiche ensuite ce statut. */
  /** `duration` : Teams remet le statut d'avant après ce délai ; null : jusqu'à changement. */
  const setMyStatus = async (choice: StatusChoice, duration: StatusDuration | null = null): Promise<Result<{ presence: Presence | null }>> => {
    if (!connectedRef.current) {
      const presence: Presence = choice === "reset" ? "available" : choice;
      const res = await demo(500, { presence });
      if (res.ok) setState((s) => ({ ...s, myPresence: presence }));
      return res;
    }
    const res = await request<{ presence: Presence | null }>("POST", "/api/me/status", {
      presence: choice,
      ...(duration && choice !== "reset" ? { duration } : {}),
    });
    if (res.ok) setState((s) => ({ ...s, myPresence: res.presence ?? null }));
    return res;
  };
  /** Message de statut (vide : l'efface), vérifié dans Teams. */
  const setStatusMessage = async (text: string): Promise<Result<{ message: string }>> => {
    if (!connectedRef.current) {
      const res = await demo(500, { message: text.replace(/\s+/g, " ").trim() });
      if (res.ok) demoStatusMessage = res.message;
      return res;
    }
    return request<{ message: string }>("POST", "/api/me/status-message", { text });
  };
  /** Un message de statut proposé dans ta voix ; rien n'est envoyé à Teams. `previous` :
   *  le message actuel, pour en proposer un autre. source « fallback » : message tout prêt. */
  const suggestStatusMessage = async (previous: string): Promise<Result<{ text: string; source: "brain" | "fallback" }>> => {
    if (!connectedRef.current) {
      const pool = ["🎧 Concentré, je réponds dès que possible", "☕ Pause rapide, je reviens vite", "🛠️ En plein dans le code, l'urgent passe toujours", "🚀 On avance bien aujourd'hui"];
      const others = pool.filter((m) => m !== previous.trim());
      return demo(900, { text: others[Math.floor(Math.random() * others.length)], source: "brain" as const });
    }
    return request<{ text: string; source: "brain" | "fallback" }>("POST", "/api/me/status-message/suggest", { text: previous });
  };

  /** Le retrait de la carte est fait par l'UI après l'animation « Envoyé » (removeDraft). */
  /** `mentions` : noms écrits « @Nom » dans le texte, à transformer en vraies mentions Teams.
   *  `files` : fichiers choisis par l'utilisateur, envoyés avec le message. */
  const sendDraft = async (id: string, text: string, replyTo?: MessageRef | null, mentions: string[] = [], files: PendingFile[] = []): Promise<Result<{ queued: QueuedSend | null }>> => {
    if (!connectedRef.current) return demo(files.length ? 1500 : 700, { queued: null });
    const res = await request<{ queued?: any }>("POST", `/api/drafts/${encodeURIComponent(id)}/send`, {
      text,
      reply_to: replyTo ? messageRef(replyTo) : null,
      mentions,
      attachments: wireFiles(files),
    });
    return res.ok ? { ok: true, queued: res.queued ? mapQueued(res.queued) : null } : res;
  };
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

  /** Relit la liste des conversations dans Teams ; l'état arrive ensuite par le flux habituel. */
  const refreshConversations = async (): Promise<Result<{ count: number }>> => {
    if (!connectedRef.current) return demo(600, { count: stateRef.current.watchlist.length });
    return request<{ count: number }>("POST", "/api/conversations/refresh");
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
  /** « Nouvelle conversation » : personnes dont le nom commence par ce qui est tapé. */
  const searchPeople = async (query: string): Promise<Result<PeopleSearch>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(150);
      const dm = (name: string) =>
        stateRef.current.watchlist.find((w) => w.surface === "dm" && foldName(w.displayName) === foldName(name))?.threadId ?? null;
      const directory = demoPeopleList.length ? demoPeopleList : DEMO_ENTOURAGE;
      const seen = new Set<string>();
      const people: PersonSuggestion[] = [];
      for (const p of directory.filter((p) => wordsMatch(p.name, query) || p.aliases.some((a) => wordsMatch(a, query)))) {
        seen.add(foldName(p.name));
        people.push({ name: p.name, role: p.role, team: p.team, manager: p.manager, source: "entourage", threadId: dm(p.name) });
      }
      for (const name of DEMO_TEAMS_PEOPLE.filter((n) => wordsMatch(n, query) && !seen.has(foldName(n)))) {
        people.push({ name, role: null, team: null, manager: null, source: "teams", threadId: dm(name) });
      }
      return { ok: true, people: people.slice(0, 8), canStart: true, teamsSearch: true, unsupported: null };
    }
    const res = await request<{ people: any[]; can_start: boolean; teams_search: boolean; unsupported: string | null }>(
      "GET",
      `/api/people/search?q=${encodeURIComponent(query)}`
    );
    if (!res.ok) return res;
    return {
      ok: true,
      people: (res.people ?? []).map(mapSuggestion).filter((p) => p.name),
      canStart: Boolean(res.can_start),
      teamsSearch: Boolean(res.teams_search),
      unsupported: text(res.unsupported),
    };
  };
  /** Ouvre (ou crée) la conversation privée dans Teams ; elle rejoint la liste, non suivie. */
  const startConversation = async (name: string): Promise<Result<{ conversation: WatchEntity }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(900);
      const known = stateRef.current.watchlist.find((w) => w.surface === "dm" && foldName(w.displayName) === foldName(name));
      if (known) return { ok: true, conversation: known };
      const conversation: WatchEntity = {
        threadId: `19:demo-${foldName(name).replace(/[^a-z0-9]+/g, "")}@unq.gbl.spaces`,
        displayName: name,
        surface: "dm",
        watch: false,
        mode: "draft",
        namedPeople: [],
        rank: 0,
        lastActivity: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
      };
      demoStarted.add(conversation.threadId);
      setState((s) => ({
        ...s,
        watchlist: [conversation, ...s.watchlist.map((w) => (typeof w.rank === "number" ? { ...w, rank: w.rank + 1 } : w))],
      }));
      return { ok: true, conversation };
    }
    const res = await request<{ conversation: any }>("POST", "/api/conversations/start", { name });
    if (!res.ok) return res;
    const conversation = mapWatch(res.conversation);
    // Visible tout de suite, sans attendre la prochaine trame du flux d'état.
    setState((s) => (s.watchlist.some((w) => w.threadId === conversation.threadId) ? s : { ...s, watchlist: [conversation, ...s.watchlist] }));
    return { ok: true, conversation };
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
  /** `last` : combien de messages remonter ; `top` dans la réponse : le début de la conversation est atteint. */
  const threadMessages = async (
    threadId: string,
    fresh = false,
    last = 30
  ): Promise<Result<{ messages: ThreadMessage[]; top: boolean }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(700);
      if (demoStarted.has(threadId)) return { ok: true, messages: [], top: true };
      const conv = stateRef.current.watchlist.find((w) => w.threadId === threadId);
      const who = conv?.displayName ?? "Quelqu'un";
      const messages: ThreadMessage[] = [
        { id: "d1", sender: who, text: "Salut, tu as vu le ticket sur le mapping OBX ?", at: "09:12", mine: false, reactions: demoReactions.get(`${threadId}/d1`) ?? [] },
        demoDeleted.has(`${threadId}/d2`)
          ? { id: "d2", sender: "Toi", text: DELETED_TEXT, at: "09:14", mine: true, reactions: [], deleted: true }
          : { id: "d2", sender: "Toi", text: "Oui, je regarde ce matin.", at: "09:14", mine: true, reactions: [] },
        {
          id: "d4",
          sender: who,
          text:
            "Les PR à relire :\nhttps://github.com/Wifsimster/passerelle/pull/214\nhttps://github.com/Wifsimster/passerelle/pull/215\nhttps://github.com/Wifsimster/passerelle/issues/198\nEt la doc (voir https://fr.wikipedia.org/wiki/Health_Level_7_(norme)), section « https://www.hl7.org/fhir/réponse.html ».",
          at: "09:40",
          mine: false,
          reactions: demoReactions.get(`${threadId}/d4`) ?? [],
        },
        { id: "d3", sender: who, text: "Top. Tu peux relire la PR #214 avant ce soir ?", at: "10:02", mine: false, reactions: demoReactions.get(`${threadId}/d3`) ?? [], files: [{ name: "Recette-OBX.pdf", url: "" }], images: [{ data: null, width: 0, height: 0 }] },
      ];
      demoArchive.add(threadId, messages);
      return { ok: true, messages, top: true };
    }
    const query = new URLSearchParams({ last: String(last), ...(fresh ? { fresh: "true" } : {}) });
    const res = await request<{ messages: ThreadMessage[]; top?: boolean }>(
      "GET",
      `/api/threads/${encodeURIComponent(threadId)}/messages?${query}`
    );
    return res.ok ? { ...res, top: Boolean(res.top) } : res;
  };
  /** Quelqu'un écrit, ton dernier message est vu : ce que montre la liste que le moteur
   *  interroge déjà (rien n'est ouvert dans Teams). Démo : rien à signaler. */
  const threadActivity = async (threadId: string): Promise<Result<ThreadActivity>> => {
    if (!connectedRef.current) return demoRef.current ? { ok: true, typing: false, typingText: null, seen: null } : { ok: false, error: OFFLINE };
    const res = await request<{ typing?: boolean; typing_text?: string | null; seen?: boolean | null }>(
      "GET",
      `/api/threads/${encodeURIComponent(threadId)}/activity`
    );
    if (!res.ok) return res;
    return { ok: true, typing: Boolean(res.typing), typingText: res.typing_text || null, seen: typeof res.seen === "boolean" ? res.seen : null };
  };
  /** Titre et état d'une PR / issue GitHub dont le lien est affiché dans un message (null : GitHub coupé ou illisible). */
  const githubLink = async (ref: GithubRef): Promise<BriefGithubItem | null> => {
    if (!connectedRef.current) {
      if (!demoRef.current || !localSettings.github.enabled) return null;
      await wait(300);
      const path = ref.kind === "pr" ? "pull" : "issues";
      return {
        kind: ref.kind,
        repo: `${ref.owner}/${ref.repo}`,
        number: ref.number,
        title: `${ref.kind === "pr" ? "Correctif" : "Anomalie"} de démonstration n° ${ref.number}`,
        state: DEMO_LINK_STATES[ref.number % DEMO_LINK_STATES.length],
        url: `https://github.com/${ref.owner}/${ref.repo}/${path}/${ref.number}`,
        why: "Lien dans la conversation",
      };
    }
    const query = new URLSearchParams({ kind: ref.kind, repo: `${ref.owner}/${ref.repo}`, number: String(ref.number) });
    const res = await request<{ link: any }>("GET", `/api/github/link?${query}`);
    return res.ok && res.link ? mapGithub(res.link) : null;
  };
  /** Recherche dans les messages déjà lus par le moteur (rien n'est relu dans Teams). */
  const searchMessages = async (q: string): Promise<Result<{ results: MessageHit[]; scope: SearchScope }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(150);
      const names = new Map(stateRef.current.watchlist.map((w) => [w.threadId, w.displayName]));
      return { ok: true, results: demoArchive.search(q, names), scope: demoArchive.scope() };
    }
    const res = await request<{ results: any[]; scope: SearchScope }>("GET", `/api/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return res;
    return { ok: true, results: res.results.map(mapHit), scope: res.scope };
  };
  /** Recherche native de Teams : tout l'historique, y compris ce que Trame n'a pas lu. */
  const searchTeams = async (q: string): Promise<Result<{ results: MessageHit[] }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(1800);
      return { ok: true, results: demoTeamsSearch(q, stateRef.current.watchlist) };
    }
    const res = await request<{ results: any[] }>("POST", "/api/search/teams", { q });
    if (!res.ok) return res;
    return { ok: true, results: res.results.map(mapHit) };
  };
  /** Envoi à la main, avec les fichiers choisis par l'utilisateur (jamais en mode Auto). */
  /** `queued` : Teams n'était pas prêt, le message attend dans la file d'envoi et partira seul. */
  const sendInThread = async (threadId: string, text: string, replyTo?: MessageRef | null, mentions: string[] = [], files: PendingFile[] = []): Promise<Result<{ queued: QueuedSend | null }>> => {
    if (!connectedRef.current) return demo(files.length ? 1500 : 800, { queued: null });
    const res = await request<{ queued?: any }>("POST", `/api/threads/${encodeURIComponent(threadId)}/send`, {
      text,
      reply_to: replyTo ? messageRef(replyTo) : null,
      mentions,
      attachments: wireFiles(files),
    });
    return res.ok ? { ok: true, queued: res.queued ? mapQueued(res.queued) : null } : res;
  };
  /** File d'envoi : retirer un message, ou le réessayer tout de suite. */
  const cancelQueued = (id: string): Promise<Result> =>
    connectedRef.current ? request("POST", `/api/outbox/${encodeURIComponent(id)}/cancel`) : demo(200, {});
  const retryQueued = (id: string): Promise<Result> =>
    connectedRef.current ? request("POST", `/api/outbox/${encodeURIComponent(id)}/retry`) : demo(200, {});
  /** Le pilote Teams sait-il joindre un fichier, et dans quelles limites. */
  const attachmentLimits = async (): Promise<Result<{ limits: AttachmentLimits }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      return { ok: true, limits: DEFAULT_LIMITS };
    }
    const res = await request<{
      can_attach: boolean;
      unsupported: string | null;
      max_files: number;
      max_file_bytes: number;
      max_total_bytes: number;
      extensions: string[];
    }>("GET", "/api/attachments");
    if (!res.ok) return res;
    return {
      ok: true,
      limits: {
        canAttach: Boolean(res.can_attach),
        unsupported: res.unsupported ?? null,
        maxFiles: res.max_files,
        maxFileBytes: res.max_file_bytes,
        maxTotalBytes: res.max_total_bytes,
        extensions: res.extensions,
      },
    };
  };
  /** Propose une réponse au dernier message reçu, ou à `target` (réponse à un message précis). */
  const suggestInThread = async (threadId: string, target?: MessageRef | null): Promise<Result<{ text: string }>> => {
    if (!connectedRef.current) {
      const text = target
        ? `Bien vu pour « ${target.text.length > 40 ? target.text.slice(0, 40) + "…" : target.text} » : je m'en occupe et je te dis.`
        : "Oui, je la relis cet après-midi et je te fais un retour avant 17 h.";
      const who = conversationName(threadId) ?? "ton interlocuteur";
      return demoReflect(
        {
          action: "suggest",
          threadId,
          conversation: conversationName(threadId),
          before: ["Lecture du fil (15 derniers messages au plus)", "Contexte rassemblé : fil (3 messages), entourage (1 fiche), GitHub (non utilisé pour une proposition)"],
          thinking: target
            ? `${who} attend une réponse à un message précis, pas au dernier du fil. Je le cite et je réponds sur ce point seulement. Ton direct, tutoiement comme dans le fil, une phrase et un engagement.`
            : `${who} demande une relecture de la PR #214 avant ce soir. Le fil montre que c'est attendu aujourd'hui : je m'engage sur un créneau précis plutôt qu'un « je regarde ». Ton direct, tutoiement, une phrase.`,
          after: `Réponse reçue et nettoyée (${text.length} caractères)`,
          result: text,
        },
        { text }
      );
    }
    return request<{ text: string }>("POST", `/api/threads/${encodeURIComponent(threadId)}/suggest`, target ? { message: messageRef(target) } : undefined);
  };
  /** Vérifie les faits d'un message prêt à partir (fil, entourage, GitHub). N'envoie jamais rien. */
  const checkInThread = async (threadId: string, text: string, target?: MessageRef | null): Promise<Result<{ check: FactCheck }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      const who = stateRef.current.watchlist.find((w) => w.threadId === threadId)?.displayName ?? "Quelqu'un";
      const check = demoCheck(threadId, who, text);
      const bad = check.claims.filter((c) => c.verdict === "contredit").length;
      return demoReflect(
        {
          action: "check",
          threadId,
          conversation: conversationName(threadId),
          before: ["Lecture du fil (30 derniers messages au plus)", "Contexte rassemblé : fil (3 messages), entourage (1 fiche), GitHub (rien à lire)"],
          thinking: `Je relève les numéros, heures et jours cités dans le message, puis je cherche qui les a donnés dans le fil. ${who} a parlé de la PR #214 « avant ce soir » à 10:02 : c'est la source à comparer. Une valeur différente est une contradiction, une heure que personne n'a donnée reste non vérifiable.`,
          after: `Réponse reçue et validée : ${check.claims.length} affirmation(s) exploitable(s)`,
          result: check.claims.length ? `${check.claims.length} affirmation(s) relevée(s), ${bad} contredite(s)` : "Rien à signaler",
        },
        { check }
      );
    }
    const res = await request<{ check: any }>("POST", `/api/threads/${encodeURIComponent(threadId)}/check`, {
      text,
      message: target ? messageRef(target) : null,
    });
    return res.ok ? { ok: true, check: mapCheck(res.check) } : res;
  };
  /** Orthographe, grammaire et typographie du message en cours, par le cerveau choisi. N'envoie rien. */
  const correctText = async (text: string, threadId: string | null = null): Promise<Result<{ text: string; changed: boolean }>> => {
    if (!connectedRef.current) {
      const fixed = demoCorrect(text);
      const changed = fixed !== text.trim();
      return demoReflect(
        {
          action: "correct",
          threadId,
          conversation: conversationName(threadId),
          before: [`Message à corriger : ${text.length} caractères (ni le fil ni l'entourage ne sont lus)`],
          thinking: "Je relis l'orthographe, les accords et la typographie française : espaces insécables, apostrophes, guillemets. Je garde le ton, les mentions, les liens et les emoji tels quels, je ne réécris aucune phrase.",
          after: changed ? "Réponse reçue et validée : liens, mentions et code intacts" : "Réponse reçue : rien à corriger",
          result: fixed,
        },
        { text: fixed, changed }
      );
    }
    return request<{ text: string; changed: boolean }>("POST", "/api/correct", { text, thread_id: threadId });
  };
  /** Réaction en un clic sur un message précis. Réussie seulement si Teams l'affiche. */
  const reactInThread = async (threadId: string, target: MessageRef, reaction: Reaction): Promise<Result> => {
    if (!connectedRef.current) {
      const res = await demo(500, {});
      if (res.ok && target.id) {
        const key = `${threadId}/${target.id}`;
        const mine = demoReactions.get(key) ?? [];
        if (!mine.includes(reaction)) demoReactions.set(key, [...mine, reaction]);
      }
      return res;
    }
    return request("POST", `/api/threads/${encodeURIComponent(threadId)}/react`, { message: messageRef(target), reaction });
  };
  /** Supprime un de tes messages dans Teams. Réussie seulement si Teams le montre supprimé. */
  const deleteInThread = async (threadId: string, target: MessageRef): Promise<Result> => {
    if (!connectedRef.current) {
      if (!target.id) return { ok: false, error: "Message introuvable : rien n'a été supprimé." };
      const res = await demo(700, {});
      if (res.ok) demoDeleted.add(`${threadId}/${target.id}`);
      return res;
    }
    return request("POST", `/api/threads/${encodeURIComponent(threadId)}/delete`, { message: messageRef(target) });
  };
  /** Marque la conversation comme lue dans Teams, sans l'ouvrir. */
  const markRead = async (threadId: string): Promise<Result> => {
    if (!connectedRef.current) return demo(200, {});
    return request("POST", `/api/threads/${encodeURIComponent(threadId)}/read`);
  };
  /** Vide la zone de saisie de la conversation dans Teams (texte, pièce jointe en attente). */
  const clearCompose = async (threadId: string): Promise<Result> => {
    if (!connectedRef.current) return demo(400, {});
    return request("POST", `/api/threads/${encodeURIComponent(threadId)}/clear-compose`);
  };
  const showInTeams = async (threadId: string): Promise<Result> => {
    if (!connectedRef.current) return demo(400, {});
    return request("POST", `/api/threads/${encodeURIComponent(threadId)}/show`);
  };

  /** Journal, fin du backend.log et dernières traces OpenTelemetry, en un seul texte ;
   *  avec des filtres, seulement les lignes d'Activité qu'ils gardent. */
  const exportLogs = async (filters?: LogFilters): Promise<Result<{ filename: string; text: string }>> => {
    const filtered = !!filters && isFiltered(filters);
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      const logs = filtered ? filterLogs(stateRef.current.logs, filters!) : stateRef.current.logs;
      const lines = logs.map((l) => `${l.at}  ${l.level.padEnd(5)}  ${l.text}`);
      const title = filtered ? "# Trame : activité filtrée (démo)" : "# Trame : journaux (démo)";
      const filename = filtered ? "trame-activite-demo.txt" : "trame-journaux-demo.txt";
      return { ok: true, filename, text: [title, "", "## Journal", ...lines].join("\n") + "\n" };
    }
    return request<{ filename: string; text: string }>("GET", `/api/logs/export${filtered ? logParams(filters!) : ""}`);
  };

  /** Activité conservée d'un démarrage à l'autre, filtrée, la plus récente d'abord. */
  const queryLogs = async (filters: LogFilters, before?: string | null, limit = 100): Promise<Result<LogPage>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      const all = filterLogs(stateRef.current.logs, filters);
      return { ok: true, items: all, total: all.length, next: null };
    }
    return request<LogPage>("GET", `/api/logs${logParams(filters, { limit: String(limit), ...(before ? { before } : {}) })}`);
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

  /** Contrôle des repères de la page Teams, en lecture seule (aucun menu ouvert). */
  const checkTeams = async (): Promise<Result<{ check: TeamsCheck | null }>> => {
    if (!connectedRef.current) return demoRef.current ? demo(600, { check: null }) : { ok: false, error: OFFLINE };
    const res = await request<{ check: unknown }>("POST", "/api/teams/check");
    if (!res.ok) return res;
    const check = mapTeamsCheck(res.check);
    setState((s) => ({ ...s, teamsCheck: check }));
    return { ok: true, check };
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
    getMyStatus,
    setMyStatus,
    setStatusMessage,
    suggestStatusMessage,
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
    refreshConversations,
    uploadSoul,
    getSoul,
    getSoulTemplate,
    factoryReset,
    threadMessages,
    threadActivity,
    githubLink,
    searchMessages,
    searchTeams,
    reactInThread,
    deleteInThread,
    sendInThread,
    attachmentLimits,
    suggestInThread,
    checkInThread,
    correctText,
    reflections,
    cancelReflection,
    showInTeams,
    markRead,
    clearCompose,
    cancelQueued,
    retryQueued,
    diagnoseTeams,
    teamsWebStatus,
    checkTeams,
    exportLogs,
    queryLogs,
    previewSoul,
    getPeople,
    listPeople,
    searchPeople,
    startConversation,
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

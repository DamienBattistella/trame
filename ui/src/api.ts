import { demoHistory } from "@/demoThread";
import { useEffect, useRef, useState } from "react";
import {
  Brain,
  Brief,
  BriefGithubItem,
  GithubState,
  FactCheck,
  BriefRange,
  DraftItem,
  Effort,
  ConversationSort,
  UPDATE_CHECK_CHOICES,
  UpdateCheckMinutes,
  Theme,
  GithubLogin,
  GithubStatus,
  ClaudeStatus,
  ThreadActivity,
  ThreadMessage,
  MeetingLink,
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
  Meeting,
  SavedTranscript,
  SkillsSummary,
  ReportSession,
  PublishPlan,
  PublishedRef,
  GithubReportState,
} from "@/types";
import { demoSoulDetails, mapSoulDetails, SoulDetails } from "@/lib/persona";
import { mockBrief, mockConversations, mockDrafts, mockFavorites, mockFollowUps, mockLogs } from "@/mockData";
import { isDesktop, notificationsEnabled, notify, setUpdateCheckMinutes as setDesktopUpdateCheckMinutes } from "@/desktop";
import { loadPrefs, toasts } from "@/lib/notifyPrefs";
import { DemoArchive, demoTeamsSearch } from "@/lib/textSearch";
import type { GithubRef } from "@/lib/linkify";
import { DEFAULT_LIMITS } from "@/lib/attachments";
import { filterLogs, isFiltered, logParams } from "@/lib/logFilters";
import { demoCorrect } from "@/lib/demoCorrect";
import { playDemoReflection, type DemoPlan } from "@/lib/demoReflection";
import { demoSkills } from "@/lib/demoSkills";
import { demoPrompt, demoSession, demoTurn } from "@/lib/demoReport";

const BRIEF_RANGES: readonly unknown[] = ["messages", "today", "24h", "7d", "30d"] satisfies BriefRange[];

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
  /** Sa photo de profil Teams (data URL) ; null sans photo : l'icône de profil la remplace. */
  myPhoto: string | null;
  /** Messages envoyés quand Teams n'était pas prêt : ils partent dès qu'il l'est. */
  outbox: QueuedSend[];
  /** threadId -> compteur : change quand un message arrive ou que Trame en envoie un. */
  threadUpdates: Record<string, number>;
  /** Réponses parties seules (mode Auto), encore annulables : Trame les supprime dans Teams. */
  undoable: UndoableSend[];
  /** Ce que le mode Auto a envoyé seul aujourd'hui. */
  autoToday: { at: string; threadId: string; conversation: string; text: string }[];
  /** Dernier contrôle des repères de la page Teams ; null tant qu'il n'a pas tourné. */
  teamsCheck: TeamsCheck | null;
  /** Tes questions restées sans réponse, avec la relance proposée (jamais envoyée seule). */
  followUps: FollowUpItem[];
  /** Conversations épinglées en haut de la liste, dans l'ordre choisi. Indépendant de « Suivie ». */
  favorites: string[];
  /** Conversations archivées : hors des sections principales, de retour au premier message reçu. */
  archived: Record<string, ArchivedInfo>;
}

export type ArchivedInfo = { at: string; auto: boolean; hidden: boolean };

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

/** Une relance proposée : ta question restée sans réponse, depuis quand (ISO, heure
 *  locale), et le texte proposé, modifiable avant envoi. */
export interface FollowUpItem {
  id: string;
  threadId: string;
  conversation: string;
  question: string;
  askedAt: string;
  proposal: string;
}

function mapFollowUp(f: any): FollowUpItem {
  return {
    id: f.id,
    threadId: f.thread_id,
    conversation: f.conversation ?? "",
    question: f.question ?? "",
    askedAt: f.asked_at ?? "",
    proposal: f.proposal ?? "",
  };
}

/** Un message en file d'envoi. waiting : en attente ; sending : en cours ; failed :
 *  refusé, à ton action ; uncertain : peut-être parti, à vérifier dans Teams. */
export interface UndoableSend {
  id: string;
  threadId: string;
  conversation: string;
  text: string;
  sentAt: string;
  /** Fin de la fenêtre d'annulation (ms depuis l'époque). */
  expiresAtMs: number;
}

/** Santé de Trame (page Santé) : un point par sujet, du pire au meilleur dans `status`. */
export interface HealthReport {
  status: "ok" | "warn" | "error" | "unknown";
  items: { key: string; label: string; status: "ok" | "warn" | "error" | "unknown"; detail: string }[];
  version: string;
  uptimeS: number;
}

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

/** `code` : « maybe_sent », le même contenu, resté « non confirmé », semble déjà dans le fil. */
export type Result<T = {}> = ({ ok: true; error?: undefined } & T) | { ok: false; error: string; status?: number; code?: string };

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
      mentioned: Boolean(n.mentioned),
      followed: Boolean(n.followed),
    })),
    capabilities: {
      react: Boolean(s.capabilities?.react),
      reply: Boolean(s.capabilities?.reply),
      mentions: Boolean(s.capabilities?.mentions),
      ownStatus: Boolean(s.capabilities?.own_status),
      delete: Boolean(s.capabilities?.delete),
    },
    myPresence: s.my_presence ?? null,
    myPhoto: typeof s.my_photo === "string" ? s.my_photo : null,
    outbox: (s.outbox ?? []).map(mapQueued),
    threadUpdates: s.thread_updates ?? {},
    autoToday: (s.auto_today ?? []).map((a: any) => ({ at: a.at ?? "", threadId: a.thread_id, conversation: a.conversation ?? "", text: a.text ?? "" })),
    undoable: (s.undoable ?? []).map((u: any) => ({
      id: u.id,
      threadId: u.thread_id,
      conversation: u.conversation,
      text: u.text ?? "",
      sentAt: u.sent_at ?? "",
      expiresAtMs: Number(u.expires_at_ms ?? 0),
    })),
    teamsCheck: mapTeamsCheck(s.teams_check),
    followUps: (s.follow_ups ?? []).map(mapFollowUp),
    favorites: Array.isArray(s.favorites) ? s.favorites.map(String) : [],
    archived: mapArchived(s.archived),
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
    github: {
      enabled: Boolean(g.enabled),
      allRepos: Boolean(g.all_repos),
      write: {
        enabled: Boolean(g.write?.enabled),
        allRepos: Boolean(g.write?.all_repos),
        reposAllowlist: Array.isArray(g.write?.repos_allowlist) ? g.write.repos_allowlist : [],
        pathTemplate: String(g.write?.path_template ?? "docs/comptes-rendus/{date}-{slug}.md"),
        draft: g.write?.draft === undefined ? true : Boolean(g.write.draft),
      },
    },
    safety: {
      autoPauseOnScreenShare: Boolean(f.auto_pause_on_screen_share),
      selftestGate: Boolean(f.selftest_gate),
      countdownSeconds: Number(f.countdown_seconds ?? 5),
      neverAutoSendIfMessageContains: Array.isArray(f.never_auto_send_if_message_contains)
        ? f.never_auto_send_if_message_contains
        : [],
      markAutoReplies: f.mark_auto_replies === undefined ? true : Boolean(f.mark_auto_replies),
      autoMaxPerHour: Number(f.auto_max_per_hour ?? 5),
      autoQuietHours: Boolean(f.auto_quiet_hours),
      autoQuietFrom: f.auto_quiet_from ?? "19:00",
      autoQuietTo: f.auto_quiet_to ?? "08:00",
      autoWeekends: f.auto_weekends === undefined ? true : Boolean(f.auto_weekends),
    },
    brief: {
      enabled: b.enabled === undefined ? true : Boolean(b.enabled),
      lastMessages: Number(b.last_messages ?? 30),
      range: BRIEF_RANGES.includes(b.range) ? b.range : "messages",
    },
    followUps: {
      enabled: s?.follow_ups?.enabled === undefined ? true : Boolean(s.follow_ups.enabled),
      delayHours: Number(s?.follow_ups?.delay_hours ?? 24),
    },
    archive: {
      afterDays: Number(s?.archive?.after_days ?? 0),
      hideInTeams: Boolean(s?.archive?.hide_in_teams),
    },
    telemetry: {
      enabled: Boolean(s?.telemetry?.enabled),
      endpoint: String(s?.telemetry?.endpoint ?? ""),
      includeContent: Boolean(s?.telemetry?.include_content),
    },
    mcp: { enabled: Boolean(s?.mcp?.enabled), token: String(s?.mcp?.token ?? ""), allowSend: Boolean(s?.mcp?.allow_send) },
    teamsWeb: { enabled: Boolean(s?.teams_web?.enabled) },
    ui: {
      conversationSort: toSort(s?.ui?.conversation_sort),
      updateCheckMinutes: toCheckMinutes(s?.ui?.update_check_minutes),
      theme: s?.ui?.theme === "light" ? "light" : "dark",
    },
  };
}
/** Copie locale du thème, pour le premier rendu avant la réponse du moteur. */
const THEME_KEY = "trame.theme";
const toSort = (v: unknown): ConversationSort => (v === "recent" || v === "alpha" ? v : "watched");
const toCheckMinutes = (v: unknown): UpdateCheckMinutes =>
  UPDATE_CHECK_CHOICES.includes(v as UpdateCheckMinutes) ? (v as UpdateCheckMinutes) : 15;
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
    sources: {
      messages: Number(b.sources?.messages ?? 0),
      reposSearched: Number(b.sources?.repos_searched ?? 0),
      range: BRIEF_RANGES.includes(b.sources?.range) ? b.sources.range : "messages",
    },
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
    links: Array.isArray(h.links) ? h.links : [],
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
/** Démo : les conversations de réunion ont un lien de réunion, la première est en cours. */
const demoMeeting = (threadId: string): MeetingLink | null => {
  const m = /^19:meeting_x(\d+)@thread\.v2$/.exec(threadId);
  if (!m) return null;
  const url = `https://teams.microsoft.com/l/meetup-join/19%3ameeting_demo${m[1]}%40thread.v2/0`;
  return { url, live: m[1] === "0" };
};

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
    if (p.github.write) {
      const w: Record<string, unknown> = {};
      if (p.github.write.enabled !== undefined) w.enabled = p.github.write.enabled;
      if (p.github.write.allRepos !== undefined) w.all_repos = p.github.write.allRepos;
      if (p.github.write.reposAllowlist !== undefined) w.repos_allowlist = p.github.write.reposAllowlist;
      if (p.github.write.pathTemplate !== undefined) w.path_template = p.github.write.pathTemplate;
      if (p.github.write.draft !== undefined) w.draft = p.github.write.draft;
      g.write = w;
    }
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
    if (p.safety.autoMaxPerHour !== undefined) f.auto_max_per_hour = p.safety.autoMaxPerHour;
    if (p.safety.autoQuietHours !== undefined) f.auto_quiet_hours = p.safety.autoQuietHours;
    if (p.safety.autoQuietFrom !== undefined) f.auto_quiet_from = p.safety.autoQuietFrom;
    if (p.safety.autoQuietTo !== undefined) f.auto_quiet_to = p.safety.autoQuietTo;
    if (p.safety.autoWeekends !== undefined) f.auto_weekends = p.safety.autoWeekends;
    out.safety = f;
  }
  if (p.brief) {
    const b: Record<string, unknown> = {};
    if (p.brief.enabled !== undefined) b.enabled = p.brief.enabled;
    if (p.brief.lastMessages !== undefined) b.last_messages = p.brief.lastMessages;
    if (p.brief.range !== undefined) b.range = p.brief.range;
    out.brief = b;
  }
  if (p.followUps) {
    const f: Record<string, unknown> = {};
    if (p.followUps.enabled !== undefined) f.enabled = p.followUps.enabled;
    if (p.followUps.delayHours !== undefined) f.delay_hours = p.followUps.delayHours;
    out.follow_ups = f;
  }
  if (p.archive) {
    const a: Record<string, unknown> = {};
    if (p.archive.afterDays !== undefined) a.after_days = p.archive.afterDays;
    if (p.archive.hideInTeams !== undefined) a.hide_in_teams = p.archive.hideInTeams;
    out.archive = a;
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
  if (p.ui) {
    const u: Record<string, unknown> = {};
    if (p.ui.conversationSort !== undefined) u.conversation_sort = p.ui.conversationSort;
    if (p.ui.updateCheckMinutes !== undefined) u.update_check_minutes = p.ui.updateCheckMinutes;
    if (p.ui.theme !== undefined) u.theme = p.ui.theme;
    out.ui = u;
  }
  return out;
}
export function mergeSettings(s: Settings, p: SettingsPatch): Settings {
  return {
    ...s,
    ...(p.onboarded !== undefined && { onboarded: p.onboarded }),
    ...(p.brain !== undefined && { brain: p.brain }),
    models: { ...s.models, ...p.models },
    github: { ...s.github, ...p.github, write: { ...s.github.write, ...p.github?.write } },
    safety: { ...s.safety, ...p.safety },
    brief: { ...s.brief, ...p.brief },
    followUps: { ...s.followUps, ...p.followUps },
    archive: { ...s.archive, ...p.archive },
    telemetry: { ...s.telemetry, ...p.telemetry },
    teamsWeb: { enabled: p.teamsWeb?.enabled ?? s.teamsWeb.enabled },
    ui: { ...s.ui, ...p.ui },
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
    return { paused: false, screenSharing: false, brain: "claude", selftestOk: false, onboarded: false, watchlist: [], drafts: [], logs: [], notices: [], capabilities: { react: false, reply: false, mentions: false, ownStatus: false, delete: false }, myPresence: null, myPhoto: null, outbox: [], threadUpdates: {}, undoable: [], autoToday: [], teamsCheck: null, followUps: [], favorites: [], archived: {} };
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
    myPhoto: null,
    outbox: [],
    threadUpdates: {},
    undoable: [],
    autoToday: [],
    teamsCheck: null,
    followUps: mockFollowUps.map((f) => ({ ...f })),
    favorites: [...mockFavorites],
    archived: {},
  };
}

// Réglages du mode démo : vivent le temps de la session.
let localSettings: Settings = {
  onboarded: false,
  brain: "claude",
  models: { claudeModel: "haiku", claudeEffort: "", copilotModel: "gpt-6-luna", copilotEffort: "low" },
  github: {
    enabled: true,
    allRepos: true,
    write: { enabled: false, allRepos: false, reposAllowlist: ["Wifsimster/passerelle"], pathTemplate: "docs/comptes-rendus/{date}-{slug}.md", draft: true },
  },
  safety: {
    autoPauseOnScreenShare: true,
    selftestGate: true,
    countdownSeconds: 5,
    neverAutoSendIfMessageContains: ["RH", "confidentiel", "salaire"],
    markAutoReplies: true,
    autoMaxPerHour: 5,
    autoQuietHours: false,
    autoQuietFrom: "19:00",
    autoQuietTo: "08:00",
    autoWeekends: true,
  },
  brief: { enabled: true, lastMessages: 30, range: "messages" },
  followUps: { enabled: true, delayHours: 24 },
  archive: { afterDays: 0, hideInTeams: false },
  telemetry: { enabled: false, endpoint: "", includeContent: false },
  mcp: { enabled: false, token: "", allowSend: false },
  teamsWeb: { enabled: false },
  ui: { conversationSort: "watched", updateCheckMinutes: 15, theme: "dark" },
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

// Publication GitHub du mode démo : un dépôt lié déduit, une PR brouillon simulée, et le
// badge « déjà publié » qui apparaît sur la réunion une fois la PR ouverte.
const DEMO_WRITE_REPO = "Wifsimster/passerelle";
const demoPublishedReports: Record<string, PublishedRef> = {};
const demoPublishedMeetings = new Set<string>();
function demoPublishPlan(reportId: string, meetingId: string, title: string, date: string | null): PublishPlan {
  const w = localSettings.github.write;
  const slug = (title || "compte-rendu").normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 60);
  const path = `docs/comptes-rendus/${date ? date + "-" : ""}${slug}.md`;
  const branch = `trame/compte-rendu/${date ? date + "-" : ""}${slug}`;
  const already = demoPublishedReports[reportId] ?? null;
  const status = demoGithubStatus();
  const blocked = !w.enabled
    ? "L'ouverture de pull requests est désactivée (Réglages › GitHub)."
    : !status.loggedIn
      ? "Connecte-toi d'abord à GitHub (Réglages › GitHub)."
      : "";
  return {
    reportId, writeEnabled: w.enabled, repo: DEMO_WRITE_REPO,
    repoReason: "lien GitHub vers Wifsimster/passerelle dans la transcription", repoConfident: true,
    path, branch, base: "main", draft: w.draft, repos: [DEMO_WRITE_REPO, ...w.reposAllowlist.filter((r) => r !== DEMO_WRITE_REPO)],
    state: already
      ? { repo: DEMO_WRITE_REPO, exists: false, prUrl: already.url, prNumber: already.number, prDraft: already.draft, reason: "une pull request ouvre déjà ce compte-rendu", path, branch }
      : { repo: DEMO_WRITE_REPO, exists: false, path, branch },
    blocked,
  };
}
function demoReportState(meetingId: string): GithubReportState {
  const pub = demoPublishedMeetings.has(meetingId);
  if (!pub) return { repo: null };
  return { repo: DEMO_WRITE_REPO, exists: false, prUrl: `https://github.com/${DEMO_WRITE_REPO}/pull/215`, prNumber: 215, prDraft: true, reason: "une pull request ouvre déjà ce compte-rendu", repoConfident: true };
}

export type BriefPrefs = Settings["brief"] & { github: boolean };
const prefsOf = (s: Settings): BriefPrefs => ({ ...s.brief, github: s.github.enabled });

export type GraphRoute = { via: "graph" | "page"; reason: string | null; at: string };
export type GraphStatus = {
  client_id: string;
  tenant_id: string;
  configured: boolean;
  signed_in: boolean;
  account: string | null;
  pending: boolean;
  error: string | null;
  routes: Record<string, GraphRoute>;
};
const DEMO_GRAPH: GraphStatus = {
  client_id: "",
  tenant_id: "",
  configured: false,
  signed_in: false,
  account: null,
  pending: false,
  error: null,
  routes: {
    list: { via: "page", reason: "Graph non connecté", at: "10:02:11" },
    read: { via: "page", reason: "Graph non connecté", at: "10:02:12" },
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
      return { ok: false, error, status: res.status, ...(typeof data?.code === "string" ? { code: data.code } : {}) };
    }
    return { ...(data ?? {}), ok: true } as Result<T>;
  } catch {
    return { ok: false, error: "Le moteur Trame est injoignable." };
  }
}

// Mode démo : skills fictifs, activation gardée le temps de la page.
const demoSkillState: SkillsSummary = demoSkills();

// Mode démo : réunions fictives, rien n'est lu ni écrit.
const DEMO_TRANSCRIPTS_DIR = String.raw`C:\Users\vous\Documents\Trame\Transcriptions`;
/** Nom du .vtt, comme le moteur le forme (« 2026-11-24 Titre.vtt »). */
const demoFileName = (m: Meeting) => `${m.date ? m.date + " " : ""}${m.title.replace(/[<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim()}.vtt`;
// Réunions fictives datées par rapport à aujourd'hui, dans l'ordre des conversations
// (pas des dates) comme Teams les donne : récurrentes, plusieurs périodes, déjà récupérées.
const DEMO_MEETING_SEEDS: [title: string, daysAgo: number, start: string, end: string, transcript: boolean, saved?: boolean][] = [
  ["Point interop HL7", 2, "10:00", "10:30", true, true],
  ["Rétro sprint 42", 3, "16:00", "17:00", true],
  ["Café d'équipe", 6, "09:00", "09:15", false],
  ["Synchro inter-équipes", 0, "11:30", "12:00", true],
  ["Revue d'architecture", 0, "09:00", "10:00", true],
  ["Atelier parcours patient", 1, "15:30", "16:30", true],
  ["Point projet Atlas", 1, "13:45", "14:30", true],
  ["Synchro inter-équipes", 7, "11:30", "12:00", true, true],
  ["Point projet Atlas", 8, "13:45", "14:30", true, true],
  ["Démo de fin de sprint", 13, "14:30", "15:00", true],
  ["Synchro inter-équipes", 14, "11:30", "12:00", true],
  ["Synchro inter-équipes", 28, "11:30", "12:00", true, true],
  ["Point recette", 56, "10:00", "11:15", true],
  ["Comité de pilotage", 84, "14:00", "15:30", true],
];
/** Mode démo : Teams ne montre pas cette transcription (refus d'accès). */
const DEMO_DENIED = "Démo de fin de sprint";
function demoMeetings(): Meeting[] {
  const today = new Date();
  const fmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return DEMO_MEETING_SEEDS.map(([title, daysAgo, start, end, transcript, saved], i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const m: Meeting = { meetingId: `demo-${i + 1}`, threadId: `19:meeting_demo${i + 1}@thread.v2`, mid: String(i + 1), title,
      when: `${fmt.format(d)} ${start} - ${end}`, date, start, end, chat: title, organizer: saved ? "Sofia Marino" : "",
      transcript, saved: null };
    return saved ? { ...m, saved: { path: `${DEMO_TRANSCRIPTS_DIR}\\${demoFileName(m)}`, name: demoFileName(m) } } : m;
  });
}
const mapMeeting = (m: any): Meeting => ({
  meetingId: m.meeting_id || `${m.thread_id}#${m.mid}`, threadId: m.thread_id, mid: String(m.mid), title: m.title || m.chat || "Réunion",
  when: m.when || "", date: m.date ?? null, start: m.start ?? null, end: m.end ?? null, chat: m.chat || "",
  organizer: m.organizer || "", transcript: Boolean(m.transcript),
  saved: m.saved?.path ? { path: String(m.saved.path), name: String(m.saved.name || "") } : null,
});

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
  // Tri de la liste des conversations, enregistré dans config.json.
  const [conversationSort, setConversationSortState] = useState<ConversationSort>(localSettings.ui.conversationSort);
  // Fréquence de recherche des mises à jour, enregistrée dans config.json et transmise à l'application.
  const [updateCheckMinutes, setUpdateCheckMinutesState] = useState<UpdateCheckMinutes>(localSettings.ui.updateCheckMinutes);
  // Thème clair ou sombre, enregistré dans config.json ; recopié en local pour peindre le bon thème dès le démarrage.
  const [theme, setThemeState] = useState<Theme>(() => (localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  const applyPrefs = (s: Settings) => {
    setBriefPrefs(prefsOf(s));
    setThemeState(s.ui.theme);
    setConversationSortState(s.ui.conversationSort);
    setUpdateCheckMinutesState(s.ui.updateCheckMinutes);
    void setDesktopUpdateCheckMinutes(s.ui.updateCheckMinutes);
  };
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
      // Filtrées (portée, heures calmes) et regroupées selon les réglages de notification.
      for (const t of toasts(fresh.reverse(), loadPrefs(), new Date(), next.screenSharing)) notify(t.title, t.body);
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
  // duration : une durée de Teams ; until : « Personnalisé », "AAAA-MM-JJTHH:MM" local. L'un ou l'autre.
  const setMyStatus = async (
    choice: StatusChoice,
    duration: StatusDuration | null = null,
    until: string | null = null
  ): Promise<Result<{ presence: Presence | null }>> => {
    if (!connectedRef.current) {
      const presence: Presence = choice === "reset" ? "available" : choice;
      const res = await demo(500, { presence });
      if (res.ok) setState((s) => ({ ...s, myPresence: presence }));
      return res;
    }
    const res = await request<{ presence: Presence | null }>("POST", "/api/me/status", {
      presence: choice,
      ...(until && choice !== "reset" ? { until } : duration && choice !== "reset" ? { duration } : {}),
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
  const sendDraft = async (id: string, text: string, replyTo?: MessageRef | null, mentions: string[] = [], files: PendingFile[] = [], force = false): Promise<Result<{ queued: QueuedSend | null }>> => {
    if (!connectedRef.current) return demo(files.length ? 1500 : 700, { queued: null });
    const res = await request<{ queued?: any }>("POST", `/api/drafts/${encodeURIComponent(id)}/send`, {
      text,
      reply_to: replyTo ? messageRef(replyTo) : null,
      mentions,
      attachments: wireFiles(files),
      ...(force ? { force: true } : {}),
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
      applyPrefs(localSettings);
      return { ok: true, settings: localSettings };
    }
    const res = await request<{ settings: unknown }>("GET", "/api/settings");
    if (!res.ok) return res;
    const settings = mapSettings(res.settings);
    applyPrefs(settings);
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
      applyPrefs(localSettings);
      return { ok: true, settings: localSettings };
    }
    const res = await request<{ settings: unknown }>("PUT", "/api/settings", settingsPatchToWire(patch));
    if (!res.ok) return res;
    const settings = mapSettings(res.settings);
    setState((s) => ({ ...s, brain: settings.brain, onboarded: settings.onboarded }));
    applyPrefs(settings);
    return { ok: true, settings };
  };
  /** Optimiste : le tri change tout de suite, puis est enregistré pour les prochains lancements. */
  const setConversationSort = (sort: ConversationSort) => {
    setConversationSortState(sort);
    if (connectedRef.current || demoRef.current) void updateSettings({ ui: { conversationSort: sort } });
  };

  /** Optimiste, comme le tri : l'application applique la fréquence tout de suite, le moteur l'enregistre. */
  const setUpdateCheckMinutes = (minutes: UpdateCheckMinutes) => {
    setUpdateCheckMinutesState(minutes);
    void setDesktopUpdateCheckMinutes(minutes);
    if (connectedRef.current || demoRef.current) void updateSettings({ ui: { updateCheckMinutes: minutes } });
  };

  /** Optimiste, comme le tri : le thème change tout de suite, puis est enregistré. */
  const setTheme = (next: Theme) => {
    setThemeState(next);
    if (connectedRef.current || demoRef.current) void updateSettings({ ui: { theme: next } });
  };
  const themeRef = useRef(theme);
  themeRef.current = theme;
  /** Alt+D, de n'importe où : bascule à partir du thème affiché. */
  const toggleTheme = () => setTheme(themeRef.current === "dark" ? "light" : "dark");

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

  /** Skills d'agent : liste, sources, activation. En démo, des skills fictifs. */
  const skillsCall = async (method: string, path: string, body?: unknown, change?: (s: SkillsSummary) => void): Promise<Result<{ summary: SkillsSummary }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      change?.(demoSkillState);
      await wait(150);
      return { ok: true, summary: { ...demoSkillState, skills: demoSkillState.skills.map((x) => ({ ...x })) } };
    }
    const res = await request<SkillsSummary>(method, path, body);
    if (!res.ok) return res;
    const { ok: _ok, ...summary } = res;
    return { ok: true, summary: summary as SkillsSummary };
  };
  const getSkills = () => skillsCall("GET", "/api/skills");
  const reloadSkills = () => skillsCall("POST", "/api/skills/reload");
  const setSkillEnabled = (name: string, enabled: boolean) =>
    skillsCall("POST", `/api/skills/${encodeURIComponent(name)}`, { enabled }, (s) => {
      const sk = s.skills.find((x) => x.name === name);
      if (sk) sk.enabled = enabled;
    });
  const setSkillDirs = (dirs: string[]) => skillsCall("PUT", "/api/skills/dirs", { dirs }, (s) => (s.dirs = dirs));
  const syncSkillRepo = async (url: string, branch: string): Promise<Result<{ summary: SkillsSummary }>> => {
    if (!connectedRef.current && demoRef.current) return { ok: false, error: "Démo : aucun dépôt n'est récupéré." };
    return skillsCall("POST", "/api/skills/repos", { url, branch });
  };
  const removeSkillRepo = (url: string, branch: string) => skillsCall("POST", "/api/skills/repos/remove", { url, branch });

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

  /** Réglages › Persona : le SOUL.md lu section par section, ses versions, son apprentissage. */
  const soulCall = async (method: string, path: string, body?: unknown): Promise<Result<{ details: SoulDetails }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(400);
      return { ok: true, details: demoSoulDetails() };
    }
    const res = await request<Record<string, unknown>>(method, path, body);
    return res.ok ? { ok: true, details: mapSoulDetails(res) } : res;
  };
  const getSoulDetails = () => soulCall("GET", "/api/soul/details");
  const restoreSoulVersion = (id: string) => soulCall("POST", `/api/soul/versions/${encodeURIComponent(id)}/restore`);
  const learnSoul = () => soulCall("POST", "/api/soul/learn");
  const setSoulLearning = (patch: { enabled?: boolean; every?: number }) => soulCall("POST", "/api/soul/learning", patch);
  const forgetSoulSignals = () => soulCall("POST", "/api/soul/signals/forget");
  const getSoulVersion = async (id: string): Promise<Result<{ content: string }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      return { ok: true, content: demoSoulDetails().content.split("\n## Appris")[0] + "\n" };
    }
    const res = await request<{ version: { content: string } }>("GET", `/api/soul/versions/${encodeURIComponent(id)}`);
    return res.ok ? { ok: true, content: res.version.content } : res;
  };

  /** Mode manuel : historique d'une conversation, réponse tapée à la main, proposition, ouverture dans Teams. */
  /** `last` : combien de messages remonter ; `top` dans la réponse : le début de la conversation est atteint. */
  const threadMessages = async (
    threadId: string,
    fresh = false,
    last = 30
  ): Promise<Result<{ messages: ThreadMessage[]; top: boolean; meeting: MeetingLink | null }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(700);
      const meeting = demoMeeting(threadId);
      if (demoStarted.has(threadId)) return { ok: true, messages: [], top: true, meeting };
      const conv = stateRef.current.watchlist.find((w) => w.threadId === threadId);
      const who = conv?.displayName ?? "Quelqu'un";
      const messages: ThreadMessage[] = [
        ...demoHistory(who),
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
        // Lien dont le texte n'est pas l'adresse, carte Jira et aperçu GitHub, comme Teams les montre.
        {
          id: "d5",
          sender: who,
          text: "Les deux fiches pour la recette :\n[HL7-12] Typage OBX-2 - Jira\n[HL7-13] Unités UCUM - Jira",
          at: "09:52",
          mine: false,
          reactions: demoReactions.get(`${threadId}/d5`) ?? [],
          links: [
            { text: "[HL7-12] Typage OBX-2 - Jira", url: "https://example.atlassian.net/browse/HL7-12" },
            { text: "[HL7-13] Unités UCUM - Jira", url: "https://example.atlassian.net/browse/HL7-13" },
          ],
          cards: [
            { source: "Jira", title: "HL7-12: Typage OBX-2", url: "https://example.atlassian.net/browse/HL7-12", fields: ["Assigned to Lucas Bernard", "Medium", "OPEN"] },
            { source: "GitHub", title: "Mapping HL7 des résultats de labo · Pull Request #214", url: "https://github.com/Wifsimster/passerelle/pull/214", fields: [] },
          ],
        },
        { id: "d3", sender: who, text: "Top. Tu peux relire la PR #214 avant ce soir ?", at: "10:02", mine: false, reactions: demoReactions.get(`${threadId}/d3`) ?? [], files: [{ name: "Recette-OBX.pdf", url: "" }], images: [{ data: null, width: 0, height: 0 }] },
      ];
      demoArchive.add(threadId, messages);
      return { ok: true, messages, top: true, meeting };
    }
    const query = new URLSearchParams({ last: String(last), ...(fresh ? { fresh: "true" } : {}) });
    const res = await request<{ messages: ThreadMessage[]; top?: boolean; meeting?: MeetingLink | null }>(
      "GET",
      `/api/threads/${encodeURIComponent(threadId)}/messages?${query}`
    );
    return res.ok ? { ...res, top: Boolean(res.top), meeting: res.meeting ?? null } : res;
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
  /** Réunions terminées des conversations de réunion récentes (Trame les ouvre dans Teams, en lecture). */
  const listMeetings = async (): Promise<Result<{ meetings: Meeting[]; directory: string }>> => {
    if (!connectedRef.current) return demo(1200, { meetings: demoMeetings(), directory: DEMO_TRANSCRIPTS_DIR });
    const res = await request<{ meetings: any[]; directory: string }>("GET", "/api/meetings");
    return res.ok ? { ok: true, meetings: res.meetings.map(mapMeeting), directory: res.directory } : res;
  };
  /** La liste de la dernière lecture, gardée sur le poste (survit aux mises à jour) : Teams n'est pas relu. */
  const knownMeetings = async (): Promise<Result<{ meetings: Meeting[]; directory: string; readAt: Date | null }>> => {
    if (!connectedRef.current) return demo(0, { meetings: [], directory: DEMO_TRANSCRIPTS_DIR, readAt: null });
    const res = await request<{ meetings: any[]; directory: string; read_at: string | null }>("GET", "/api/meetings/known");
    return res.ok
      ? { ok: true, meetings: res.meetings.map(mapMeeting), directory: res.directory, readAt: res.read_at ? new Date(res.read_at) : null }
      : res;
  };
  /** Relit la transcription d'une réunion dans Teams et l'enregistre en .vtt sur le poste. */
  const saveTranscript = async (m: Meeting, directory?: string): Promise<Result<SavedTranscript>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(2200);
      if (!m.transcript) return { ok: false, error: "Pas de transcription pour cette réunion.", status: 404 };
      if (m.title === DEMO_DENIED) return { ok: false, error: "Accès refusé : Teams ne te montre pas cette transcription.", status: 403 };
      const dir = directory || DEMO_TRANSCRIPTS_DIR;
      const name = demoFileName(m);
      return { ok: true, path: `${dir}\\${name}`, name, directory: dir, cues: 4, speakers: ["Lucas Bernard", "Sofia Marino"], complete: true, organizer: "Sofia Marino" };
    }
    const res = await request<any>("POST", "/api/meetings/transcript", { thread_id: m.threadId, mid: m.mid, directory: directory || null });
    if (!res.ok) return res;
    return { ok: true, path: res.path, name: res.name, directory: res.directory, cues: res.cues, speakers: res.speakers || [],
      complete: Boolean(res.complete), organizer: res.organizer || "" };
  };
  /** Ouvre le dossier des transcriptions dans l'Explorateur (créé s'il manque). */
  const openTranscriptsFolder = async (directory?: string): Promise<Result<{ directory: string }>> => {
    if (!connectedRef.current) return demo(300, { directory: directory || DEMO_TRANSCRIPTS_DIR });
    return request("POST", "/api/meetings/open-folder", { directory: directory || null });
  };
  /** Le dossier des transcriptions, sans lire Teams ni rien ouvrir. */
  const getTranscriptsFolder = async (): Promise<Result<{ directory: string }>> => {
    if (!connectedRef.current) return demo(0, { directory: DEMO_TRANSCRIPTS_DIR });
    return request("GET", "/api/meetings/folder");
  };
  /** Change le dossier des transcriptions (retenu pour les suivantes), sans rien ouvrir. */
  const setTranscriptsFolder = async (directory: string): Promise<Result<{ directory: string }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      return /^[A-Za-z]:[\\/]/.test(directory.trim())
        ? demo(300, { directory: directory.trim() })
        : { ok: false, error: "Indique un chemin complet (par exemple C:\\Users\\toi\\Documents\\Transcriptions).", status: 422 };
    }
    return request("POST", "/api/meetings/folder", { directory });
  };
  /** Ouvre un .vtt enregistré, ou le montre sélectionné dans l'Explorateur (reveal). */
  const openTranscript = async (path: string, reveal = false): Promise<Result<{ path: string }>> => {
    if (!connectedRef.current) return demo(200, { path });
    return request("POST", "/api/meetings/file", { path, reveal });
  };
  /** Compte-rendu de réunion : un skill appliqué au .vtt (récupéré d'abord s'il manque), en plusieurs tours. */
  const demoReports = useRef(new Map<string, ReportSession>());
  const demoReportTurn = async (s: ReportSession) => {
    const prompt = demoPrompt(s);
    s.pendingPrompt = prompt;
    const first = !s.turns.some((t) => t.role === "assistant");
    let runId = "";
    const outcome = await playDemoReflection(
      {
        action: "report",
        threadId: null,
        conversation: s.title,
        before: first
          ? [`Transcription : ${s.vttPath.split("\\").pop()}, ${s.cues} prise(s) de parole, ${s.vttChars} caractères (texte complet envoyé)`]
          : ["Réponse de l'utilisateur transmise, l'échange continue"],
        loaded: first ? s.skill : undefined,
        thinking: first
          ? "Je lis la transcription : deux participants, les tests OBX sont verts, la PR #214 sera fusionnée et la démo interop reste jeudi à 10 h. Le skill demande un compte-rendu structuré, puis de proposer des issues : je pose la question au lieu de les créer, Trame ne crée rien lui-même."
          : "L'utilisateur a répondu. Je reprends le compte-rendu et j'ajoute seulement ce qu'il a demandé, sous forme de texte à copier.",
        after: "Réponse reçue",
        result: "",
      },
      (run) => {
        runId = run.id;
        s.runId = run.id;
        upsertReflection(run);
      },
      (id) => demoStopped.current.has(id)
    );
    if (outcome === "cancelled" || s.status === "cancelled") {
      s.pendingPrompt = "";
      s.status = "cancelled";
      s.rev++;
      return;
    }
    s.pendingPrompt = "";
    const turn = demoTurn(s, prompt, runId);
    s.turns = [...s.turns, turn];
    if (turn.report) s.report = turn.report;
    s.status = turn.question ? "waiting" : "done";
    s.rev++;
  };
  const reportCall = async (method: string, path: string, body?: unknown): Promise<Result<{ report: ReportSession }>> =>
    request<{ report: ReportSession }>(method, path, body);
  const startReport = async (m: Meeting, path?: string): Promise<Result<{ report: ReportSession }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      const s = demoSession(m, DEMO_TRANSCRIPTS_DIR);
      demoReports.current.set(s.id, s);
      void demoReportTurn(s);
      return { ok: true, report: { ...s } };
    }
    return reportCall("POST", "/api/reports", { thread_id: m.threadId, mid: m.mid, title: m.title, date: m.date, path: path || null });
  };
  const getReport = async (id: string): Promise<Result<{ report: ReportSession }>> => {
    if (!connectedRef.current) {
      const s = demoReports.current.get(id);
      return s ? { ok: true, report: { ...s, turns: [...s.turns] } } : { ok: false, error: OFFLINE };
    }
    return reportCall("GET", `/api/reports/${encodeURIComponent(id)}`);
  };
  const answerReport = async (id: string, text: string): Promise<Result<{ report: ReportSession }>> => {
    if (!connectedRef.current) {
      const s = demoReports.current.get(id);
      if (!s) return { ok: false, error: OFFLINE };
      s.turns = [...s.turns, { role: "user", text, at: new Date().toTimeString().slice(0, 8), question: "", options: [], report: "", prompt: "", runId: "" }];
      s.status = "running";
      s.rev++;
      void demoReportTurn(s);
      return { ok: true, report: { ...s } };
    }
    return reportCall("POST", `/api/reports/${encodeURIComponent(id)}/answer`, { text });
  };
  const cancelReport = async (id: string): Promise<Result<{ report: ReportSession }>> => {
    if (!connectedRef.current) {
      const s = demoReports.current.get(id);
      if (!s) return { ok: false, error: OFFLINE };
      if (s.runId) demoStopped.current.add(s.runId);
      s.status = "cancelled";
      s.rev++;
      return { ok: true, report: { ...s } };
    }
    return reportCall("POST", `/api/reports/${encodeURIComponent(id)}/cancel`);
  };
  const saveReport = async (id: string): Promise<Result<{ report: ReportSession }>> => {
    if (!connectedRef.current) {
      const s = demoReports.current.get(id);
      if (!s) return { ok: false, error: OFFLINE };
      await wait(300);
      s.savedPath = s.vttPath.replace(/\.vtt$/, ".md");
      s.rev++;
      return { ok: true, report: { ...s } };
    }
    return reportCall("POST", `/api/reports/${encodeURIComponent(id)}/save`);
  };
  const openReportFolder = async (id: string): Promise<Result<{ directory: string }>> => {
    if (!connectedRef.current) return demo(300, { directory: DEMO_TRANSCRIPTS_DIR });
    return request("POST", `/api/reports/${encodeURIComponent(id)}/open-folder`);
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
  /** `force` : renvoyer quand même ce qui semble déjà parti (réponse « maybe_sent »). */
  const sendInThread = async (threadId: string, text: string, replyTo?: MessageRef | null, mentions: string[] = [], files: PendingFile[] = [], force = false): Promise<Result<{ queued: QueuedSend | null }>> => {
    if (!connectedRef.current) return demo(files.length ? 1500 : 800, { queued: null });
    const res = await request<{ queued?: any }>("POST", `/api/threads/${encodeURIComponent(threadId)}/send`, {
      text,
      reply_to: replyTo ? messageRef(replyTo) : null,
      mentions,
      attachments: wireFiles(files),
      ...(force ? { force: true } : {}),
    });
    return res.ok ? { ok: true, queued: res.queued ? mapQueued(res.queued) : null } : res;
  };
  /** Retire une réponse partie seule (mode Auto) : Trame la supprime dans Teams. */
  const undoAuto = (id: string): Promise<Result> =>
    connectedRef.current ? request("POST", `/api/undo/${encodeURIComponent(id)}`) : demo(600, {});
  /** Santé de Trame ; en démo, un exemple plausible. */
  const health = async (): Promise<Result<HealthReport>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      return demo(300, {
        status: "warn" as const,
        version: "démo",
        uptimeS: 4380,
        items: [
          { key: "teams", label: "Connexion à Teams", status: "ok" as const, detail: "Connecté (démo)." },
          { key: "page", label: "Page Teams", status: "ok" as const, detail: "Repères présents (14 vérifiés, contrôle de 16:05)." },
          { key: "outbox", label: "File d'envoi", status: "warn" as const, detail: "1 message(s) en attente d'envoi." },
          { key: "brain", label: "Cerveau", status: "ok" as const, detail: "Claude · haiku" },
          { key: "pause", label: "Veille", status: "ok" as const, detail: "Active." },
          { key: "disk", label: "Espace disque", status: "ok" as const, detail: "42,0 Go libres sur 931,0 Go (C:\\)" },
        ],
      });
    }
    const res = await request<{ status: HealthReport["status"]; items: HealthReport["items"]; version: string; uptime_s: number }>("GET", "/api/health");
    return res.ok ? { ok: true, status: res.status, items: res.items, version: res.version, uptimeS: res.uptime_s } : res;
  };
  /** File d'envoi : retirer un message, ou le réessayer tout de suite. */
  const cancelQueued = (id: string): Promise<Result> =>
    connectedRef.current ? request("POST", `/api/outbox/${encodeURIComponent(id)}/cancel`) : demo(200, {});
  const retryQueued = (id: string): Promise<Result> =>
    connectedRef.current ? request("POST", `/api/outbox/${encodeURIComponent(id)}/retry`) : demo(200, {});
  /** Relances : envoyer (sur ton clic, par le même chemin qu'un envoi à la main),
   *  reporter ou ignorer. `queued` : Teams n'était pas prêt, la relance attend dans la file d'envoi. */
  const dropFollowUp = (id: string) => setState((s) => ({ ...s, followUps: s.followUps.filter((f) => f.id !== id) }));
  const followUpAction = async (id: string, what: "snooze" | "ignore", body?: unknown): Promise<Result> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(250);
      dropFollowUp(id);
      return { ok: true };
    }
    const res = await request("POST", `/api/follow-ups/${encodeURIComponent(id)}/${what}`, body);
    if (res.ok || res.status === 404) dropFollowUp(id);
    return res.ok || res.status === 404 ? { ok: true } : res;
  };
  const sendFollowUp = async (id: string, text: string): Promise<Result<{ queued: QueuedSend | null }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(800);
      dropFollowUp(id);
      return { ok: true, queued: null };
    }
    const res = await request<{ queued?: any }>("POST", `/api/follow-ups/${encodeURIComponent(id)}/send`, { text });
    if (!res.ok) return res;
    dropFollowUp(id);
    return { ok: true, queued: res.queued ? mapQueued(res.queued) : null };
  };
  const snoozeFollowUp = (id: string, hours = 24) => followUpAction(id, "snooze", { hours });
  const ignoreFollowUp = (id: string) => followUpAction(id, "ignore");
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
  /** Propose une réponse au dernier message reçu, ou à `target` (réponse à un message précis ;
   *  `mine` : un de tes messages, à relancer ou compléter). N'envoie jamais rien. */
  const suggestInThread = async (
    threadId: string,
    target?: MessageRef | null,
    opts: { mine?: boolean } = {}
  ): Promise<Result<{ text: string }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      const quoted = target ? `« ${target.text.length > 40 ? target.text.slice(0, 40) + "…" : target.text} »` : "";
      const text = target && opts.mine
        ? `Petite relance sur ${quoted} : tu as pu regarder ? Je peux t'en dire plus si besoin.`
        : target
          ? `Bien vu pour ${quoted} : je m'en occupe et je te dis.`
          : "Oui, je la relis cet après-midi et je te fais un retour avant 17 h.";
      const who = conversationName(threadId) ?? "ton interlocuteur";
      return demoReflect(
        {
          action: "suggest",
          threadId,
          conversation: conversationName(threadId),
          before: ["Lecture du fil (15 derniers messages au plus)", "Contexte rassemblé : fil (3 messages), entourage (1 fiche), GitHub (non utilisé pour une proposition)"],
          thinking: target && opts.mine
            ? `Le message choisi est le tien, pas celui de ${who} : je ne me réponds pas, je propose une relance courte qui rappelle le point et laisse la porte ouverte. Ton direct, tutoiement comme dans le fil.`
            : target
            ? `${who} attend une réponse à un message précis, pas au dernier du fil. Je le cite et je réponds sur ce point seulement. Ton direct, tutoiement comme dans le fil, une phrase et un engagement.`
            : `${who} demande une relecture de la PR #214 avant ce soir. Le fil montre que c'est attendu aujourd'hui : je m'engage sur un créneau précis plutôt qu'un « je regarde ». Ton direct, tutoiement, une phrase.`,
          after: `Réponse reçue et nettoyée (${text.length} caractères)`,
          result: text,
          skill: !target && demoSkillState.skills.some((x) => x.name === "relecture-pr" && x.enabled) ? "relecture-pr" : undefined,
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
          skill: demoSkillState.skills.some((x) => x.name === "typographie-francaise" && x.enabled) ? "typographie-francaise" : undefined,
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

  /** Microsoft Graph : application enregistrée par la DSI, connexion, voie suivie par action. */
  const graphStatus = async (): Promise<Result<{ graph: GraphStatus }>> => {
    if (!connectedRef.current) return demo(200, { graph: DEMO_GRAPH });
    return request("GET", "/api/graph");
  };
  const graphConfigure = async (clientId: string, tenantId: string): Promise<Result<{ graph: GraphStatus }>> => {
    if (!connectedRef.current) return demo(200, { graph: { ...DEMO_GRAPH, client_id: clientId, tenant_id: tenantId } });
    return request("PUT", "/api/graph", { client_id: clientId, tenant_id: tenantId });
  };
  const graphLogin = async (): Promise<Result<{ graph: GraphStatus }>> => {
    if (!connectedRef.current) return demo(200, { graph: { ...DEMO_GRAPH, signed_in: true, account: "prenom.nom@exemple.fr" } });
    return request("POST", "/api/graph/login");
  };
  const graphLogout = async (): Promise<Result<{ graph: GraphStatus }>> => {
    if (!connectedRef.current) return demo(200, { graph: DEMO_GRAPH });
    return request("POST", "/api/graph/logout");
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
  const generateBrief = async (
    threadId: string,
    opts: { lastMessages?: number; range?: BriefRange } = {}
  ): Promise<Result<{ brief: Brief }>> => {
    const { lastMessages, range } = opts;
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(3600);
      const conv = stateRef.current.watchlist.find((w) => w.threadId === threadId);
      const brief = mockBrief(threadId, conv?.displayName ?? "Conversation", {
        lastMessages: lastMessages ?? localSettings.brief.lastMessages,
        range: range ?? localSettings.brief.range,
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
      {
        ...(lastMessages !== undefined && { last_messages: lastMessages }),
        ...(range !== undefined && { range }),
      }
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

  /** Ce que « Publier sur GitHub » ferait pour ce compte-rendu : dépôt lié, branche, chemin, état déjà-présent. Ne publie rien. */
  const githubPublishPlan = async (reportId: string): Promise<Result<{ plan: PublishPlan }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(400);
      const s = demoReports.current.get(reportId);
      return { ok: true, plan: demoPublishPlan(reportId, s?.meetingId ?? "", s?.title ?? "Réunion", /20\d\d-\d\d-\d\d/.exec(s?.vttPath ?? "")?.[0] ?? null) };
    }
    return request<{ plan: PublishPlan }>("POST", "/api/github/publish/plan", { report_id: reportId });
  };
  /** Ouvre une pull request brouillon ajoutant le .md du compte-rendu au dépôt choisi (sur confirmation explicite). */
  const githubPublish = async (reportId: string, repo: string, opts?: { path?: string; draft?: boolean }): Promise<Result<{ published: PublishedRef; report: ReportSession }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(1300);
      const s = demoReports.current.get(reportId);
      if (!s) return { ok: false, error: OFFLINE };
      const plan = demoPublishPlan(reportId, s.meetingId, s.title, /20\d\d-\d\d-\d\d/.exec(s.vttPath)?.[0] ?? null);
      const num = 200 + Math.floor(Math.random() * 100);
      const published: PublishedRef = { url: `https://github.com/${repo}/pull/${num}`, number: num, draft: opts?.draft ?? plan.draft, repo, path: opts?.path ?? plan.path, branch: plan.branch };
      demoPublishedReports[reportId] = published;
      demoPublishedMeetings.add(s.meetingId);
      s.published = published;
      s.rev++;
      return { ok: true, published, report: { ...s } };
    }
    return request("POST", "/api/github/publish", { report_id: reportId, repo, path: opts?.path ?? null, draft: opts?.draft ?? null });
  };
  /** Le compte-rendu de cette réunion est-il déjà sur le dépôt lié (fichier ou PR ouverte) ? Pour la liste des réunions. */
  const githubReportState = async (m: { meetingId: string; title: string; date: string | null; path?: string }): Promise<Result<{ state: GithubReportState }>> => {
    if (!connectedRef.current) {
      if (!demoRef.current) return { ok: false, error: OFFLINE };
      await wait(250);
      return { ok: true, state: demoReportState(m.meetingId) };
    }
    return request<{ state: GithubReportState }>("POST", "/api/github/report-state", { meeting_id: m.meetingId, title: m.title, date: m.date, path: m.path ?? null });
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
  /** Bouton robot : activer le mode Auto suit aussi la conversation, le couper la garde suivie en brouillons. */
  const setAuto = (threadId: string, on: boolean) => {
    const cur = stateRef.current.watchlist.find((w) => w.threadId === threadId);
    if (!cur) return Promise.resolve<Result>({ ok: true });
    const next: WatchlistEntry[] = [{ threadId, watch: on || cur.watch, mode: on ? "auto" : "draft" }];
    return applyWatch(next, () => saveWatchlist(next));
  };
  const setMode = (threadId: string, mode: Mode) => {
    const cur = stateRef.current.watchlist.find((w) => w.threadId === threadId);
    if (!cur) return Promise.resolve<Result>({ ok: true });
    return applyWatch([{ threadId, watch: cur.watch, mode }], () =>
      request("POST", `/api/mode/${encodeURIComponent(threadId)}`, { mode })
    );
  };

  /** Favoris : optimiste, remis comme avant si le moteur refuse. */
  const applyFavorites = async (next: string[], send: () => Promise<Result>): Promise<Result> => {
    if (!connectedRef.current && !demoRef.current) return { ok: false, error: OFFLINE };
    const prev = stateRef.current.favorites;
    setState((s) => ({ ...s, favorites: next }));
    if (!connectedRef.current) return { ok: true };
    const res = await send();
    if (!res.ok) setState((s) => ({ ...s, favorites: prev }));
    return res;
  };
  /** Ajoute (en dernier) ou retire une conversation des favoris. */
  const toggleFavorite = (threadId: string) => {
    const cur = stateRef.current.favorites;
    const favorite = !cur.includes(threadId);
    return applyFavorites(favorite ? [...cur, threadId] : cur.filter((t) => t !== threadId), () =>
      request("POST", `/api/favorite/${encodeURIComponent(threadId)}`, { favorite })
    );
  };
  /** Archiver ou désarchiver : optimiste, remis comme avant si le moteur refuse. */
  const setArchived = async (threadId: string, archived: boolean): Promise<Result> => {
    if (!connectedRef.current && !demoRef.current) return { ok: false, error: OFFLINE };
    const prev = stateRef.current.archived;
    const next = { ...prev };
    if (archived) next[threadId] = { at: new Date().toISOString(), auto: false, hidden: false };
    else delete next[threadId];
    setState((s) => ({ ...s, archived: next }));
    if (!connectedRef.current) return { ok: true };
    const res = await request<{ archived: Record<string, unknown> }>("POST", `/api/archive/${encodeURIComponent(threadId)}`, { archived });
    setState((s) => ({ ...s, archived: res.ok ? mapArchived(res.archived) : prev }));
    return res;
  };
  /** Masquer dans Teams n'est possible que par Microsoft Graph connecté. */
  const archiveStatus = async (): Promise<Result<{ canHideInTeams: boolean }>> => {
    if (!connectedRef.current) return { ok: true, canHideInTeams: false };
    const res = await request<{ can_hide_in_teams: boolean }>("GET", "/api/archive");
    return res.ok ? { ok: true, canHideInTeams: Boolean(res.can_hide_in_teams) } : res;
  };
  /** Nouvel ordre des favoris (glisser-déposer, Ctrl+Maj+↑/↓). */
  const reorderFavorites = (order: string[]) =>
    applyFavorites(order, () => request("PUT", "/api/favorites", { order }));

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
    getSkills,
    reloadSkills,
    startReport,
    getReport,
    answerReport,
    cancelReport,
    saveReport,
    openReportFolder,
    setSkillEnabled,
    setSkillDirs,
    syncSkillRepo,
    removeSkillRepo,
    briefPrefs,
    conversationSort,
    setConversationSort,
    updateCheckMinutes,
    setUpdateCheckMinutes,
    theme,
    setTheme,
    toggleTheme,
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
    githubPublishPlan,
    githubPublish,
    githubReportState,
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
    listMeetings,
    knownMeetings,
    saveTranscript,
    openTranscriptsFolder,
    getTranscriptsFolder,
    setTranscriptsFolder,
    openTranscript,
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
    health,
    undoAuto,
    retryQueued,
    sendFollowUp,
    snoozeFollowUp,
    ignoreFollowUp,
    diagnoseTeams,
    teamsWebStatus,
    graphStatus,
    graphConfigure,
    graphLogin,
    graphLogout,
    checkTeams,
    exportLogs,
    queryLogs,
    previewSoul,
    getSoulDetails,
    getSoulVersion,
    restoreSoulVersion,
    learnSoul,
    setSoulLearning,
    forgetSoulSignals,
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
    setAuto,
    toggleFavorite,
    reorderFavorites,
    setArchived,
    archiveStatus,
  };
}

export type Trame = ReturnType<typeof useTrame>;
export { SOUL_MAX_BYTES };

function mapArchived(raw: unknown): Record<string, ArchivedInfo> {
  const out: Record<string, ArchivedInfo> = {};
  if (raw && typeof raw === "object")
    for (const [t, a] of Object.entries(raw as Record<string, any>))
      out[t] = { at: String(a?.at ?? ""), auto: Boolean(a?.auto), hidden: Boolean(a?.hidden) };
  return out;
}

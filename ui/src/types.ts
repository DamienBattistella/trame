export type Surface = "dm" | "group" | "channel";
export type Mode = "draft" | "auto";
/** Présence Teams de la personne d'une conversation privée. */
export type Presence = "available" | "busy" | "in_call" | "in_meeting" | "presenting" | "dnd" | "brb" | "away" | "ooo" | "offline";

export interface WatchEntity {
  threadId: string;
  displayName: string;
  surface: Surface;
  watch: boolean;
  mode: Mode;
  namedPeople: string[];
  /** Position dans la liste de Teams (0 = activité la plus récente). */
  rank?: number | null;
  /** Heure du dernier message telle que Teams l'affiche (« 04:49 », « 25/11 »). */
  lastActivity?: string | null;
  unread?: boolean;
  /** Statut lu dans Teams (conversation privée seulement) ; absent quand Teams ne le dit pas. */
  presence?: Presence | null;
}

export interface DraftItem {
  id: string;
  threadId: string;
  from: string;
  surface: Surface;
  incoming: string;
  proposal: string;
  receivedAt: string;
  mode: Mode;
  usedGithub?: string;
  senderLabel?: string;
}

/** Message tout juste reçu, annoncé par une notification Windows. */
export interface Notice {
  id: string;
  threadId: string;
  conversation: string;
  from: string;
  text: string;
  at: string;
  surface: Surface;
}

export interface LogItem {
  at: string;
  level: "info" | "warn" | "sent" | "draft";
  text: string;
}

export type Brain = "claude" | "copilot";

export type Effort = "" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Settings {
  onboarded: boolean;
  brain: Brain;
  /** Vide : le réglage par défaut de Claude Code ou de Copilot. */
  models: { claudeModel: string; claudeEffort: Effort; copilotModel: string; copilotEffort: Effort };
  github: { enabled: boolean; allRepos: boolean };
  safety: {
    autoPauseOnScreenShare: boolean;
    selftestGate: boolean;
    countdownSeconds: number;
    neverAutoSendIfMessageContains: string[];
  };
  brief: { enabled: boolean; lastMessages: number };
  telemetry: { enabled: boolean; endpoint: string; includeContent: boolean };
  mcp: { enabled: boolean; token: string; allowSend: boolean };
  teamsWeb: { enabled: boolean };
}

export interface SettingsPatch {
  onboarded?: boolean;
  brain?: Brain;
  models?: Partial<Settings["models"]>;
  github?: Partial<Settings["github"]>;
  safety?: Partial<Settings["safety"]>;
  brief?: Partial<Settings["brief"]>;
  telemetry?: Partial<Settings["telemetry"]>;
  mcp?: { enabled?: boolean; regenerateToken?: boolean; allowSend?: boolean };
  teamsWeb?: { enabled?: boolean };
}

export type GithubKind = "pr" | "issue" | "commit";
export type GithubState = "open" | "closed" | "merged";

export interface BriefGithubItem {
  kind: GithubKind;
  repo: string;
  number: number | null;
  title: string;
  state: GithubState | null;
  url: string;
  why: string;
}

export interface Brief {
  threadId: string;
  displayName: string;
  generatedAt: string;
  summary: string;
  openPoints: string[];
  topics: string[];
  githubEnabled: boolean;
  github: BriefGithubItem[];
  sources: { messages: number; reposSearched: number };
}

export interface ThreadMessage {
  sender: string;
  text: string;
  at: string;
  mine: boolean;
}

/** Une personne de l'entourage, telle que Trame la décrit au cerveau. */
export interface Person {
  name: string;
  aliases: string[];
  role: string | null;
  team: string | null;
  manager: string | null;
  relation: string | null;
  tone: string | null;
  note: string | null;
}

/** Une suggestion de « Nouvelle conversation » : l'entourage d'abord, puis la recherche de Teams. */
export interface PersonSuggestion {
  name: string;
  role: string | null;
  team: string | null;
  manager: string | null;
  source: "entourage" | "teams";
  /** Conversation privée déjà dans la liste, s'il y en a une. */
  threadId: string | null;
}

export interface PeopleSearch {
  people: PersonSuggestion[];
  /** Le pilote Teams sait démarrer une conversation. */
  canStart: boolean;
  /** Le pilote Teams sait chercher des personnes au-delà de l'entourage. */
  teamsSearch: boolean;
  /** Pourquoi le pilote ne peut pas démarrer de conversation. */
  unsupported: string | null;
}

export interface PeopleSummary {
  loaded: boolean;
  count: number;
  source: string | null;
  generatedAt: string | null;
}

export interface ClaudeStatus {
  installed: boolean;
  loggedIn: boolean;
  account: string | null;
  plan: string | null;
  loginPending: boolean;
  loginUrl: string | null;
}

export interface GithubStatus {
  installed: boolean;
  loggedIn: boolean;
  account: string | null;
  scopes: string[];
  ssoBlocked: string[];
  loginPending: boolean;
  loginResult?: "ok" | "failed" | null;
  loginError?: string | null;
}

export interface GithubLogin {
  code: string;
  verificationUrl: string;
}

export type Surface = "dm" | "group" | "channel";
export type Mode = "draft" | "auto";

export interface WatchEntity {
  threadId: string;
  displayName: string;
  surface: Surface;
  watch: boolean;
  mode: Mode;
  namedPeople: string[];
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
}

export interface LogItem {
  at: string;
  level: "info" | "warn" | "sent" | "draft";
  text: string;
}

export type Brain = "claude" | "copilot";

export interface Settings {
  onboarded: boolean;
  brain: Brain;
  github: { enabled: boolean; allRepos: boolean };
  safety: {
    autoPauseOnScreenShare: boolean;
    selftestGate: boolean;
    countdownSeconds: number;
    neverAutoSendIfMessageContains: string[];
  };
  brief: { enabled: boolean; lastMessages: number };
}

export interface SettingsPatch {
  onboarded?: boolean;
  brain?: Brain;
  github?: Partial<Settings["github"]>;
  safety?: Partial<Settings["safety"]>;
  brief?: Partial<Settings["brief"]>;
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
}

export interface GithubLogin {
  code: string;
  verificationUrl: string;
}

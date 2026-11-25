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

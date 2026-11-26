export type Surface = "dm" | "group" | "channel";
export type Mode = "draft" | "auto";
/** Présence Teams de la personne d'une conversation privée. */
export type Presence = "available" | "busy" | "in_call" | "in_meeting" | "presenting" | "dnd" | "brb" | "away" | "ooo" | "offline";
/** Ce que l'on peut choisir comme statut dans Teams (« Réinitialiser » : Teams décide à nouveau). */
export type StatusChoice = "available" | "busy" | "dnd" | "brb" | "away" | "offline" | "reset";
/** « Rétablir le statut après » de Teams ; null : jusqu'à ce qu'on le change. */
export type StatusDuration = "30m" | "1h" | "2h" | "today" | "week";

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

export type LogLevel = "info" | "warn" | "sent" | "draft";

export interface LogItem {
  at: string;
  /** Date et heure ISO locales (vide pour une ligne d'avant ce champ). */
  ts?: string;
  level: LogLevel;
  text: string;
}

/** Recherche et filtres du panneau Activité. Aucun niveau choisi = tous. */
export interface LogFilters {
  q: string;
  levels: LogLevel[];
  /** Date et heure ISO locales, sans fuseau. */
  since?: string;
}

export interface LogPage {
  items: LogItem[];
  /** Lignes qui correspondent en tout, au-delà de cette page. */
  total: number;
  /** Curseur de la page suivante (plus ancienne), null à la fin. */
  next: string | null;
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
    /** 🤖 à la fin de chaque message envoyé sans clic (mode Auto). */
    markAutoReplies: boolean;
  };
  brief: { enabled: boolean; lastMessages: number };
  /** Relances : proposer de relancer une question restée sans réponse depuis delayHours heures ouvrées. */
  followUps: { enabled: boolean; delayHours: number };
  telemetry: { enabled: boolean; endpoint: string; includeContent: boolean };
  mcp: { enabled: boolean; token: string; allowSend: boolean };
  teamsWeb: { enabled: boolean };
  /** Préférences d'interface, gardées dans config.json : une mise à jour ne les perd pas. */
  ui: { conversationSort: ConversationSort };
}

export type ConversationSort = "watched" | "recent" | "alpha";

export interface SettingsPatch {
  onboarded?: boolean;
  brain?: Brain;
  models?: Partial<Settings["models"]>;
  github?: Partial<Settings["github"]>;
  safety?: Partial<Settings["safety"]>;
  brief?: Partial<Settings["brief"]>;
  followUps?: Partial<Settings["followUps"]>;
  telemetry?: Partial<Settings["telemetry"]>;
  mcp?: { enabled?: boolean; regenerateToken?: boolean; allowSend?: boolean };
  teamsWeb?: { enabled?: boolean };
  ui?: Partial<Settings["ui"]>;
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

/** Le petit jeu de réactions de Teams. */
export type Reaction = "like" | "heart" | "laugh" | "surprised";
export const REACTIONS: { key: Reaction; emoji: string; label: string }[] = [
  { key: "like", emoji: "👍", label: "J'aime" },
  { key: "heart", emoji: "❤️", label: "Cœur" },
  { key: "laugh", emoji: "😆", label: "Rigole" },
  { key: "surprised", emoji: "😮", label: "Surpris" },
];

export interface ThreadMessage {
  /** Identifiant du message dans Teams, quand le pilote le connaît. */
  id?: string | null;
  sender: string;
  text: string;
  at: string;
  mine: boolean;
  /** Réactions que tu as mises sur ce message. */
  reactions?: Reaction[];
  /** Pièces jointes reçues : fichiers (nom, lien) et images (aperçu). */
  files?: ReceivedFile[];
  images?: ReceivedImage[];
  /** Message auquel celui-ci répond (affiché en citation). */
  replyTo?: MessageRef | null;
  /** Tes messages : true « Vu », false « Envoyé », absent ou null si Teams ne le dit pas. */
  seen?: boolean | null;
  /** Message supprimé : Teams n'en montre plus que « Ce message a été supprimé. » */
  deleted?: boolean;
}

/** Réunion d'une conversation de réunion : son lien (ouvert dans Teams) et si elle est en cours. */
export interface MeetingLink {
  url: string;
  live: boolean;
}

/** Activité d'une conversation, lue dans la liste que Trame interroge déjà. */
export interface ThreadActivity {
  /** Quelqu'un est en train d'écrire. */
  typing: boolean;
  /** « Ana est en train d'écrire », seulement pour la conversation ouverte dans la fenêtre Teams de Trame. */
  typingText: string | null;
  /** Ton dernier message vu, en direct ; null si la fenêtre Teams de Trame montre une autre conversation. */
  seen: boolean | null;
}

/** Un message trouvé : dans l'historique déjà lu par Trame, ou par la recherche de Teams. */
export interface MessageHit {
  /** null : conversation que Trame ne sait pas relier à sa liste (recherche de Teams). */
  threadId: string | null;
  conversation: string;
  sender: string;
  at: string;
  mine: boolean;
  text: string;
  /** Extrait sur une ligne, `match` y situe la correspondance [début, fin) ; null quand
   *  Teams a trouvé le message sans ces mots exacts (formes voisines). */
  excerpt: string;
  match: [number, number] | null;
}

/** Jusqu'où va la recherche : messages lus par le moteur depuis son démarrage. */
export interface SearchScope {
  conversations: number;
  messages: number;
  /** Date ISO du démarrage du moteur (ou de sa réinitialisation). */
  since: string;
}
/** Un message précis du fil, cible d'une réaction ou d'une réponse. */
export type MessageRef = Pick<ThreadMessage, "id" | "sender" | "text" | "at">;

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

/** Vérification des faits d'un message avant envoi : lecture seule, n'envoie rien. */
export type FactVerdict = "contredit" | "non_verifiable" | "ok";
export interface FactClaim {
  /** Passage du message, tel quel : la correction le remplace. */
  excerpt: string;
  verdict: FactVerdict;
  /** Source citée : message du fil, fiche de l'entourage ou GitHub. */
  source: string;
  fix: string | null;
}
export interface FactCheck {
  threadId: string;
  checkedAt: string;
  claims: FactClaim[];
  sources: { messages: number; people: number; github: number };
}

/** Fichier joint à un message reçu ; `url` vide : à ouvrir dans Teams. */
export interface ReceivedFile {
  name: string;
  url: string;
}

/** Image d'un message reçu ; `data` absent quand Teams ne l'affichait pas à la lecture. */
export interface ReceivedImage {
  data: string | null;
  width: number;
  height: number;
}

/** Ce que le pilote Teams permet pour les pièces jointes, et les limites affichées. */
export interface AttachmentLimits {
  canAttach: boolean;
  /** Pourquoi « Joindre » est désactivé (pilote sans pièces jointes). */
  unsupported: string | null;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** Extensions autorisées, sans le point, en minuscules. */
  extensions: string[];
}

/** Un fichier choisi par l'utilisateur, prêt à partir avec le message (contenu en base64). */
export interface PendingFile {
  id: string;
  name: string;
  size: number;
  type: string;
  data: string;
}

/** Une étape d'une action suivie dans le panneau Réflexion : étape de Trame, réflexion du modèle, ou échec. */
export interface ReflectionStep {
  /** Millisecondes depuis le début de l'action. */
  atMs: number;
  kind: "step" | "thinking" | "error";
  text: string;
}

export type ReflectionAction = "correct" | "check" | "suggest";

/** Ce que fait le modèle pendant une action de la zone de réponse. Reste local : jamais envoyé dans Teams. */
export interface ReflectionRun {
  id: string;
  action: ReflectionAction | string;
  title: string;
  threadId: string | null;
  conversation: string | null;
  provider: string;
  model: string;
  startedAt: string;
  status: "running" | "done" | "error" | "cancelled";
  steps: ReflectionStep[];
  result: string;
  durationMs: number | null;
  /** Le cerveau a transmis le texte de sa réflexion (sinon : étapes de Trame seulement). */
  reasoning: boolean;
  rev: number;
}

/** Une réunion Teams terminée (carte « récapitulatif » d'une conversation de réunion). */
export interface Meeting {
  /** Conversation de réunion + carte : ce que le moteur demande pour la transcription. */
  meetingId: string;
  threadId: string;
  mid: string;
  title: string;
  /** Créneau tel que Teams l'écrit (« mardi 24 novembre 2026 11:00 - 11:45 »). */
  when: string;
  /** Date ISO, si le créneau a pu être lu. */
  date: string | null;
  chat: string;
  /** Connu une fois la transcription relue (propriétaire de l'enregistrement). */
  organizer: string;
  transcript: boolean;
}

/** Une transcription enregistrée en .vtt sur le poste. */
export interface SavedTranscript {
  path: string;
  name: string;
  directory: string;
  cues: number;
  speakers: string[];
  /** Faux si la liste n'a pas pu être relue jusqu'au bout. */
  complete: boolean;
  organizer: string;
}

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
  /** Message auquel la réponse répond : cité dans Teams à l'envoi. */
  replyTo?: MessageRef | null;
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
  /** On te mentionne dans ce message. */
  mentioned?: boolean;
  /** La conversation est suivie dans Trame. */
  followed?: boolean;
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
  github: { enabled: boolean; allRepos: boolean; write: GithubWriteSettings };
  safety: {
    autoPauseOnScreenShare: boolean;
    selftestGate: boolean;
    countdownSeconds: number;
    neverAutoSendIfMessageContains: string[];
    /** 🤖 à la fin de chaque message envoyé sans clic (mode Auto). */
    markAutoReplies: boolean;
    /** Garde-fous du mode Auto : plafond par heure et par conversation (0 : aucun),
     *  heures de silence (« HH:MM », peut passer minuit), envois le week-end. */
    autoMaxPerHour: number;
    autoQuietHours: boolean;
    autoQuietFrom: string;
    autoQuietTo: string;
    autoWeekends: boolean;
  };
  brief: { enabled: boolean; lastMessages: number; range: BriefRange };
  /** Relances : proposer de relancer une question restée sans réponse depuis delayHours heures ouvrées. */
  followUps: { enabled: boolean; delayHours: number };
  /** Archivage : sans activité depuis afterDays jours (0 : jamais), et masquer aussi dans Teams (service de chat). */
  archive: { afterDays: number; hideInTeams: boolean };
  telemetry: { enabled: boolean; endpoint: string; includeContent: boolean };
  mcp: { enabled: boolean; token: string; allowSend: boolean };
  teamsWeb: { enabled: boolean };
  /** Préférences d'interface, gardées dans config.json : une mise à jour ne les perd pas. */
  ui: { conversationSort: ConversationSort; updateCheckMinutes: UpdateCheckMinutes; theme: Theme; notificationSound: NotificationSound };
}

export type ConversationSort = "watched" | "recent" | "alpha";
export type Theme = "dark" | "light";
/** Son des notifications Windows : « off » (muet) ou un son du système. */
export type NotificationSound = "off" | "Default" | "IM" | "Mail" | "Reminder" | "SMS";
export const NOTIFICATION_SOUNDS: readonly NotificationSound[] = ["off", "Default", "IM", "Mail", "Reminder", "SMS"];
/** Minutes entre deux recherches de mise à jour pendant que Trame tourne (0 : au lancement seulement). */
export type UpdateCheckMinutes = 0 | 5 | 15 | 60 | 360;
export const UPDATE_CHECK_CHOICES: readonly UpdateCheckMinutes[] = [5, 15, 60, 360, 0];

/** Ouverture de pull requests GitHub (écriture). Coupée par défaut : tant qu'elle l'est,
 *  Trame ne fait que lire GitHub. Même activée, elle n'ajoute qu'une branche + un fichier
 *  + une PR brouillon, jamais de push sur la branche protégée, jamais d'écrasement. */
export interface GithubWriteSettings {
  enabled: boolean;
  allRepos: boolean;
  reposAllowlist: string[];
  pathTemplate: string;
  draft: boolean;
}

/** Une pull request ouverte pour publier un compte-rendu. */
export interface PublishedRef {
  url: string;
  number: number | null;
  draft: boolean;
  repo: string;
  path: string;
  branch: string;
}

/** Le compte-rendu est-il déjà sur le dépôt lié : fusionné (fichier) ou en attente (PR ouverte) ? */
export interface GithubReportState {
  /** Dépôt lié à la réunion, ou null si aucun lien sûr n'a pu être établi. */
  repo: string | null;
  path?: string;
  branch?: string;
  exists?: boolean;
  url?: string;
  prUrl?: string;
  prNumber?: number | null;
  prDraft?: boolean;
  reason?: string;
  /** Le lien réunion → dépôt est sûr (lien GitHub ou association mémorisée), pas une simple correspondance de nom. */
  repoConfident?: boolean;
  repoReason?: string;
}

/** Ce que publierait un « Publier sur GitHub » : dépôt cible, branche, chemin, état déjà-présent, blocage éventuel. */
export interface PublishPlan {
  reportId: string;
  writeEnabled: boolean;
  repo: string | null;
  repoReason: string;
  repoConfident: boolean;
  path: string;
  branch: string;
  base: string;
  draft: boolean;
  /** Dépôts où l'utilisateur peut ouvrir une PR (à choisir si le lien n'est pas sûr). */
  repos: string[];
  state: GithubReportState | null;
  /** Pourquoi la publication est impossible pour l'instant (écriture coupée, pas connecté, droit manquant…). */
  blocked: string;
}

/** Période lue pour un résumé : les N derniers messages, ou une plage de temps. */
export type BriefRange = "messages" | "today" | "24h" | "7d" | "30d";

export interface SettingsPatch {
  onboarded?: boolean;
  brain?: Brain;
  models?: Partial<Settings["models"]>;
  github?: { enabled?: boolean; allRepos?: boolean; write?: Partial<GithubWriteSettings> };
  safety?: Partial<Settings["safety"]>;
  brief?: Partial<Settings["brief"]>;
  followUps?: Partial<Settings["followUps"]>;
  archive?: Partial<Settings["archive"]>;
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
  sources: { messages: number; reposSearched: number; range: BriefRange };
}

/** Le petit jeu de réactions de Teams. */
/** Clé de réaction de Teams : les six rapides, ou tout emoji (« 1f44f_clappinghands »). */
export type Reaction = string;
/** Une réaction sur un message : combien l'ont mise, et si tu en fais partie. */
export interface ReactionCount {
  key: Reaction;
  /** L'emoji déduit de la clé par le moteur ; "" pour une émoticône propre à l'organisation. */
  emoji: string;
  count: number;
  mine: boolean;
}
export const REACTIONS: { key: Reaction; emoji: string; label: string }[] = [
  { key: "like", emoji: "👍", label: "J'aime" },
  { key: "heart", emoji: "❤️", label: "Cœur" },
  { key: "laugh", emoji: "😆", label: "Rigole" },
  { key: "surprised", emoji: "😮", label: "Surpris" },
  { key: "sad", emoji: "😢", label: "Triste" },
  { key: "angry", emoji: "😡", label: "En colère" },
];

/** Ce qu'on montre d'une réaction : son emoji, sinon sa clé (émoticône de l'organisation). */
export const reactionGlyph = (key: Reaction, emoji?: string) =>
  emoji || REACTIONS.find((r) => r.key === key)?.emoji || `:${key}:`;

export interface ThreadMessage {
  /** Identifiant du message dans Teams, quand le pilote le connaît. */
  id?: string | null;
  sender: string;
  text: string;
  at: string;
  mine: boolean;
  /** Réactions que tu as mises sur ce message. */
  reactions?: Reaction[];
  /** Toutes les réactions du message (les tiennes et celles des autres), quand Teams les donne. */
  reaction_counts?: ReactionCount[];
  /** Pièces jointes reçues : fichiers (nom, lien) et images (aperçu). */
  files?: ReceivedFile[];
  images?: ReceivedImage[];
  /** Message auquel celui-ci répond (affiché en citation). */
  replyTo?: MessageRef | null;
  /** Tes messages : true « Vu », false « Envoyé », absent ou null si Teams ne le dit pas. */
  seen?: boolean | null;
  /** Message supprimé : Teams n'en montre plus que « Ce message a été supprimé. » */
  deleted?: boolean;
  /** Liens du texte dont le texte n'est pas l'adresse (« [ALL-141] Recherche identité - Jira »). */
  links?: MessageLink[];
  /** Cartes d'aperçu sous le message (Jira, GitHub, un site), résumées. */
  cards?: LinkCard[];
  /** Message cité par cette réponse (« Répondre » dans Teams), lu dans Teams. */
  quote?: MessageQuote | null;
  /** Personnes mentionnées (@nom), telles qu'elles apparaissent dans le texte. */
  mentions?: string[];
  /** Modifié par son auteur après l'envoi (« Modifié » dans Teams). */
  edited?: boolean;
}

/** Le message cité au-dessus d'une réponse : auteur, heure telle que Teams l'affiche, extrait. */
export interface MessageQuote {
  sender: string;
  at: string;
  text: string;
}

/** Un lien du texte d'un message : son texte tel qu'affiché, son adresse (http/https). */
export interface MessageLink {
  text: string;
  url: string;
}

/** Une carte d'aperçu résumée : source, titre, adresse (peut manquer), quelques champs. */
export interface LinkCard {
  source: string;
  title: string;
  url: string;
  fields: string[];
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
  links?: MessageLink[];
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
  /** « video » : lue dans Trame (lien de partage résolu en téléchargement direct). */
  kind?: "video" | "";
}

/** Téléchargement direct d'un fichier reçu : adresse pré-signée par SharePoint pour ce
 *  fichier seul, valable environ une heure. Jamais enregistrée. */
export interface FileLink {
  name: string;
  size: number;
  mime: string;
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

export type ReflectionAction = "correct" | "check" | "suggest" | "report";

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
  /** Skills dont le texte a été donné au modèle pendant l'action. */
  skills?: string[];
  rev: number;
}

/** Un skill d'agent (dossier avec SKILL.md) que Trame peut proposer au cerveau. */
export interface SkillInfo {
  name: string;
  description: string;
  /** « Trame », le dossier partagé (~/.agents/skills…) ou « git <url> ». */
  source: string;
  path: string;
  version: string;
  size: number;
  enabled: boolean;
  /** Le skill contient des scripts : Trame ne les exécute jamais. */
  hasScripts: boolean;
  scripts: string[];
  references: string[];
}

export interface SkillsSummary {
  ownDir: string;
  dirs: string[];
  /** Dépôts git, avec leur dernière mise à jour de la session (syncedAt en secondes Unix, null avant la première). */
  repos: { url: string; branch: string; commit?: string; syncedAt?: number | null; error?: string }[];
  /** Mise à jour automatique des dépôts, en heures (0 = à la main seulement). */
  autoUpdateHours?: number;
  sources: { label: string; path: string; exists: boolean; defaultOn: boolean }[];
  skills: SkillInfo[];
  ignored: { folder: string; source: string; reason: string }[];
  limits: { skillKb: number; fileKb: number; maxActive: number };
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
  /** Début et fin « HH:MM », si le créneau a des heures lisibles. */
  start: string | null;
  end: string | null;
  chat: string;
  /** Connu une fois la transcription relue (propriétaire de l'enregistrement). */
  organizer: string;
  transcript: boolean;
  /** Le .vtt déjà enregistré dans le dossier des transcriptions, s'il y est. */
  saved: { path: string; name: string } | null;
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

/** Un tour de l'échange d'un compte-rendu : le cerveau (avec le prompt exact envoyé) ou l'utilisateur. */
export interface ReportTurn {
  role: "assistant" | "user";
  text: string;
  at: string;
  /** Question posée à l'utilisateur (le compte-rendu attend sa réponse). */
  question: string;
  options: string[];
  /** Compte-rendu (Markdown) rendu à ce tour. */
  report: string;
  /** Le prompt envoyé au cerveau pour ce tour, mot pour mot. */
  prompt: string;
  /** Action du panneau Réflexion de ce tour. */
  runId: string;
}

/** Un compte-rendu de réunion : un skill appliqué à une transcription .vtt, en plusieurs tours. */
export interface ReportSession {
  id: string;
  title: string;
  meetingId: string;
  skill: string;
  skillSource: string;
  vttPath: string;
  vttChars: number;
  cues: number;
  provider: string;
  model: string;
  status: "running" | "waiting" | "done" | "error" | "cancelled";
  turns: ReportTurn[];
  report: string;
  error: string;
  savedPath: string;
  runId: string;
  /** Le prompt en cours d'envoi (pendant que le cerveau travaille). */
  pendingPrompt: string;
  /** Pull request ouverte pour ce compte-rendu (null tant qu'il n'est pas publié sur GitHub). */
  published: PublishedRef | null;
  startedAt: string;
  rev: number;
  references: string[];
}

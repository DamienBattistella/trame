import { Brief, BriefGithubItem, WatchEntity, DraftItem, LogItem } from "./types";

export const mockConversations: WatchEntity[] = [
  { threadId: "19:aa11@thread.v2", displayName: "Sofia Marino", surface: "dm", watch: true, mode: "auto", namedPeople: [] },
  { threadId: "19:bb22@thread.v2", displayName: "Lucas Bernard", surface: "dm", watch: true, mode: "draft", namedPeople: [] },
  { threadId: "19:cc33@thread.v2", displayName: "Équipe Interop", surface: "group", watch: true, mode: "draft", namedPeople: ["Sofia Marino"] },
  { threadId: "19:dd44@thread.v2", displayName: "#prod-incidents", surface: "channel", watch: false, mode: "draft", namedPeople: [] },
  { threadId: "19:ee55@thread.v2", displayName: "Chiara Rossi", surface: "dm", watch: false, mode: "draft", namedPeople: [] },
  { threadId: "19:ff66@thread.v2", displayName: "Projet FHIR Passerelle", surface: "group", watch: true, mode: "draft", namedPeople: ["Lucas Bernard"] },
  ...extraConversations(),
];

/** Volume réaliste d'exemple (~60 conversations) pour éprouver recherche et filtres. */
function extraConversations(): WatchEntity[] {
  const people = [
    "Amélie Durand", "Hugo Lefèvre", "Inès Moreau", "Julien Petit", "Léa Garnier", "Mathis Roux",
    "Nora Fontaine", "Omar Benali", "Pauline Girard", "Quentin Faure", "Rania Haddad", "Sacha Lambert",
    "Théo Mercier", "Ugo Conti", "Valentina Ricci", "William Chevalier", "Yasmine Robin", "Zoé Marchand",
    "Bastien Colin", "Camille Vidal", "Diane Perrin", "Elias Morin", "Fanny Gauthier", "Gabriel Dupuis",
    "Hélène Brun", "Ismaël Noël", "Jade Fournier", "Kevin Masson", "Lina Blanc", "Marco Bianchi",
  ];
  const groups = [
    "Équipe Plateforme", "Squad Facturation", "Comité d'architecture", "Support N2", "Projet DPI Urgences",
    "Release train Q1", "Guilde Front-end", "Équipe Sécurité", "Onboarding nouveaux", "Projet HL7 Labo",
    "Revue de code hebdo", "Daily Interop", "Projet Imagerie", "Équipe Data", "Pilotage DSI",
  ];
  const channels = [
    "#général", "#annonces", "#deploiements", "#ci-alertes", "#support-clients", "#veille-techno",
    "#architecture", "#qualite", "#rh-infos", "#random", "#incidents-p1", "#hl7-fhir",
  ];
  const mk = (displayName: string, surface: WatchEntity["surface"], i: number): WatchEntity => ({
    threadId: `19:x${surface}${i}@thread.v2`,
    displayName,
    surface,
    watch: false,
    mode: "draft",
    namedPeople: [],
  });
  return [
    ...people.map((n, i) => mk(n, "dm", i)),
    ...groups.map((n, i) => mk(n, "group", i)),
    ...channels.map((n, i) => mk(n, "channel", i)),
  ];
}

export const mockDrafts: DraftItem[] = [
  {
    id: "d1",
    threadId: "19:bb22@thread.v2",
    from: "Lucas Bernard",
    senderLabel: "Développeur interop · Hexagone",
    surface: "dm",
    incoming: "Tu peux relire la PR #214 sur le mapping HL7 ? Je bloque sur le segment OBX.",
    proposal:
      "Oui je regarde — pour OBX le souci vient du type de valeur (OBX-2), on force NM alors que c'est du ST. Je te mets un commentaire sur la PR dans la journée.",
    receivedAt: "il y a 4 min",
    mode: "draft",
    usedGithub: "Wifsimster/passerelle • PR #214",
  },
  {
    id: "d2",
    threadId: "19:cc33@thread.v2",
    from: "Sofia Marino",
    senderLabel: "Cheffe de projet · Interop",
    surface: "group",
    incoming: "@Damien dispo pour un point interop demain 10h ?",
    proposal: "Ça marche pour moi demain 10h, j'envoie l'invit.",
    receivedAt: "il y a 12 min",
    mode: "draft",
  },
];

export const mockLogs: LogItem[] = [
  { at: "20:14:02", level: "sent", text: "Envoyé à Sofia Marino : « Ça marche, je regarde. »" },
  { at: "20:11:40", level: "draft", text: "Réponse à relire pour Lucas Bernard" },
  { at: "20:09:18", level: "info", text: "GitHub consulté : Wifsimster/passerelle PR #214" },
  { at: "20:02:55", level: "warn", text: "Partage d'écran : Trame se met en pause" },
  { at: "20:00:01", level: "info", text: "Vérification de Teams : OK" },
];

type BriefSeed = {
  length: number;
  summary: string;
  openPoints: string[];
  topics: string[];
  github: BriefGithubItem[];
  repos: number;
};

const PASSERELLE = "Wifsimster/passerelle";

const BRIEF_SEEDS: Record<string, BriefSeed> = {
  "19:bb22@thread.v2": {
    length: 42,
    summary:
      "Lucas te demande une relecture de la PR #214 sur le mapping HL7 → FHIR. Il bloque sur le segment OBX : le type de valeur (OBX-2) est forcé à NM alors que les résultats du labo arrivent en ST. Vous aviez convenu de corriger avant la démo interop de jeudi.",
    openPoints: [
      "Relire la PR #214 et commenter le mapping OBX-2",
      "Décider si les valeurs ST non numériques deviennent valueString ou une Observation à part",
      "Confirmer à Lucas que la correction tient avant jeudi",
    ],
    topics: ["HL7 v2", "Segment OBX", "Mapping FHIR", "PR #214", "Démo interop"],
    github: [
      {
        kind: "pr",
        repo: PASSERELLE,
        number: 214,
        title: "Mapping HL7 ORU^R01 → Observation FHIR",
        state: "open",
        url: "https://github.com/Wifsimster/passerelle/pull/214",
        why: "La PR dont Lucas parle, en attente de ta relecture.",
      },
      {
        kind: "issue",
        repo: PASSERELLE,
        number: 198,
        title: "OBX-2 ST mal converti en valueQuantity",
        state: "open",
        url: "https://github.com/Wifsimster/passerelle/issues/198",
        why: "Le bug d'origine, cité dans la description de la PR.",
      },
      {
        kind: "commit",
        repo: PASSERELLE,
        number: null,
        title: "fix(hl7): garder OBX-5 brut quand OBX-2 vaut ST",
        state: null,
        url: "https://github.com/Wifsimster/passerelle/commit/3f9c2e1",
        why: "Correctif partiel poussé hier par Lucas sur la branche de la PR.",
      },
      {
        kind: "pr",
        repo: PASSERELLE,
        number: 187,
        title: "Parser HL7 : segments répétés OBX",
        state: "merged",
        url: "https://github.com/Wifsimster/passerelle/pull/187",
        why: "Base du parser OBX actuel, utile pour comprendre le choix NM.",
      },
    ],
    repos: 3,
  },
  "19:cc33@thread.v2": {
    length: 64,
    summary:
      "L'équipe prépare la démo interop de jeudi avec le labo. Sofia propose un point demain 10h pour caler le scénario : réception d'un ORU^R01, conversion en Observation FHIR, affichage côté DPI. Le mapping OBX reste le seul point bloquant identifié.",
    openPoints: [
      "Répondre à Sofia pour le point de demain 10h",
      "Valider le scénario de démo avec le labo",
      "Vérifier que la PR #214 est fusionnée avant jeudi",
    ],
    topics: ["Démo interop", "ORU^R01", "FHIR Observation", "Planning"],
    github: [
      {
        kind: "pr",
        repo: PASSERELLE,
        number: 214,
        title: "Mapping HL7 ORU^R01 → Observation FHIR",
        state: "open",
        url: "https://github.com/Wifsimster/passerelle/pull/214",
        why: "Point bloquant cité pour la démo.",
      },
      {
        kind: "issue",
        repo: PASSERELLE,
        number: 205,
        title: "Jeu de messages de test pour la démo labo",
        state: "closed",
        url: "https://github.com/Wifsimster/passerelle/issues/205",
        why: "Les messages d'exemple que la démo réutilise.",
      },
    ],
    repos: 2,
  },
};

/** Brief d'exemple, réaliste, pour le mode hors ligne. */
export function mockBrief(
  threadId: string,
  displayName: string,
  opts: { lastMessages: number; github: boolean }
): Brief {
  const seed: BriefSeed = BRIEF_SEEDS[threadId] ?? {
    length: 18,
    summary: `Échanges récents avec ${displayName} : surtout de la coordination, sans décision en attente de ta part. Le dernier message propose de faire le point en fin de semaine.`,
    openPoints: ["Proposer un créneau pour le point de fin de semaine"],
    topics: ["Coordination", "Planning"],
    github: [],
    repos: 2,
  };
  const now = new Date();
  return {
    threadId,
    displayName,
    generatedAt: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    summary: seed.summary,
    openPoints: seed.openPoints,
    topics: seed.topics,
    githubEnabled: opts.github,
    github: opts.github ? seed.github : [],
    sources: { messages: Math.min(opts.lastMessages, seed.length), reposSearched: opts.github ? seed.repos : 0 },
  };
}

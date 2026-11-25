import { WatchEntity, DraftItem, LogItem } from "./types";

export const mockConversations: WatchEntity[] = [
  { threadId: "19:aa11@thread.v2", displayName: "Sofia Marino", surface: "dm", watch: true, mode: "auto", namedPeople: [] },
  { threadId: "19:bb22@thread.v2", displayName: "Lucas Bernard", surface: "dm", watch: true, mode: "draft", namedPeople: [] },
  { threadId: "19:cc33@thread.v2", displayName: "Équipe Interop", surface: "group", watch: true, mode: "draft", namedPeople: ["Sofia Marino"] },
  { threadId: "19:dd44@thread.v2", displayName: "#prod-incidents", surface: "channel", watch: false, mode: "draft", namedPeople: [] },
  { threadId: "19:ee55@thread.v2", displayName: "Chiara Rossi", surface: "dm", watch: false, mode: "draft", namedPeople: [] },
  { threadId: "19:ff66@thread.v2", displayName: "Projet FHIR Passerelle", surface: "group", watch: true, mode: "draft", namedPeople: ["Lucas Bernard"] },
];

export const mockDrafts: DraftItem[] = [
  {
    id: "d1",
    threadId: "19:bb22@thread.v2",
    from: "Lucas Bernard",
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
    surface: "group",
    incoming: "@Damien dispo pour un point interop demain 10h ?",
    proposal: "Ça marche pour moi demain 10h, j'envoie l'invit.",
    receivedAt: "il y a 12 min",
    mode: "draft",
  },
];

export const mockLogs: LogItem[] = [
  { at: "20:14:02", level: "sent", text: "Auto → Sofia Marino : « Ça marche, je regarde. »" },
  { at: "20:11:40", level: "draft", text: "Brouillon déposé → Lucas Bernard (fil non ouvert)" },
  { at: "20:09:18", level: "info", text: "Contexte GitHub consulté : Wifsimster/passerelle PR #214" },
  { at: "20:02:55", level: "warn", text: "Partage d'écran détecté → veille en pause automatique" },
  { at: "20:00:01", level: "info", text: "Auto-test des sélecteurs : OK (compo, liste, rail)" },
];

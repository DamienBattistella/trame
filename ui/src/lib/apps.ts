// Application d'une adresse (GitHub, GitLab, Jira, Confluence, Teams, SharePoint, OneDrive,
// Figma) et son libellé court, comme une pastille : « alliage#4271 », « ALL-103 », « portail!12 ».
// Pur (aucun import) : testé tel quel par `node --test` (ui/tests/apps.test.ts).

export type App = "github" | "gitlab" | "jira" | "confluence" | "teams" | "sharepoint" | "onedrive" | "figma";

export type AppRef = {
  app: App;
  /** Ce que désigne l'adresse : PR, issue, commit, dépôt, MR, ticket, page, fichier, réunion… */
  kind: "pr" | "issue" | "commit" | "repo" | "mr" | "ticket" | "page" | "file" | "meeting" | "message" | "chat" | "channel" | "link";
  /** Libellé court de la pastille. */
  label: string;
};

/** Nom lisible de chaque application (infobulles, lecteurs d'écran). */
export const APP_NAME: Record<App, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  jira: "Jira",
  confluence: "Confluence",
  teams: "Teams",
  sharepoint: "SharePoint",
  onedrive: "OneDrive",
  figma: "Figma",
};

const decode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
};

const JIRA_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/;

function parse(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function github(parts: string[]): AppRef | null {
  const [owner, repo, kind, id] = parts;
  if (!owner || !repo || /^(orgs|settings|marketplace|features|topics|search|login|sponsors|notifications)$/i.test(owner)) return null;
  if (/^(pull|issues)$/i.test(kind ?? "") && /^\d+$/.test(id ?? ""))
    return { app: "github", kind: kind!.toLowerCase() === "pull" ? "pr" : "issue", label: `${repo}#${id}` };
  if (/^commit$/i.test(kind ?? "") && /^[0-9a-f]{7,40}$/i.test(id ?? "")) return { app: "github", kind: "commit", label: `${repo}@${id!.slice(0, 7)}` };
  if (kind && /^(pull|issues|commit)$/i.test(kind)) return null;
  return { app: "github", kind: "repo", label: `${owner}/${repo}` };
}

function gitlab(parts: string[]): AppRef | null {
  const dash = parts.indexOf("-");
  const project = (dash >= 0 ? parts.slice(0, dash) : parts).filter(Boolean);
  if (project.length < 2) return null;
  const name = project[project.length - 1];
  const [kind, id] = dash >= 0 ? parts.slice(dash + 1) : [];
  if (kind === "merge_requests" && /^\d+$/.test(id ?? "")) return { app: "gitlab", kind: "mr", label: `${name}!${id}` };
  if (kind === "issues" && /^\d+$/.test(id ?? "")) return { app: "gitlab", kind: "issue", label: `${name}#${id}` };
  if (kind === "commit" && /^[0-9a-f]{7,40}$/i.test(id ?? "")) return { app: "gitlab", kind: "commit", label: `${name}@${id!.slice(0, 7)}` };
  return { app: "gitlab", kind: "repo", label: project.join("/") };
}

/** Fichier nommé par le dernier morceau de l'adresse (« Recette OBX.docx »), sinon null. */
function fileName(u: URL): string | null {
  const file = u.searchParams.get("file");
  if (file) return decode(file);
  const last = decode(u.pathname.split("/").filter(Boolean).pop() ?? "");
  return /\.[a-z0-9]{2,5}$/i.test(last) && !/\.aspx$/i.test(last) ? last : null;
}

/** L'application d'une adresse et son libellé court, null pour un site quelconque. */
export function appRef(url: string): AppRef | null {
  const u = parse(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean).map(decode);

  if (host === "github.com") return github(parts);
  if (/(^|\.)gitlab(\.|-)/.test(host) || host === "gitlab.com") return gitlab(parts);

  const atlassian = /(^|\.)atlassian\.net$/.test(host);
  const browse = parts.indexOf("browse");
  if ((atlassian || /^jira[.-]/.test(host) || parts[0] === "jira") && browse >= 0 && JIRA_KEY.test(parts[browse + 1] ?? ""))
    return { app: "jira", kind: "ticket", label: parts[browse + 1] };
  const selected = u.searchParams.get("selectedIssue");
  if ((atlassian || /^jira[.-]/.test(host)) && selected && JIRA_KEY.test(selected)) return { app: "jira", kind: "ticket", label: selected };
  if ((atlassian && parts[0] === "wiki") || /^(confluence|wiki)[.-]/.test(host)) {
    const at = parts.indexOf("pages");
    const title = at >= 0 && /^\d+$/.test(parts[at + 1] ?? "") ? parts[at + 2] : u.searchParams.get("title");
    return { app: "confluence", kind: "page", label: title ? decode(title).replace(/\+/g, " ") : "Page Confluence" };
  }

  if (host === "teams.microsoft.com" || host === "teams.cloud.microsoft" || host.endsWith(".teams.microsoft.com")) {
    const what = parts[0] === "l" ? parts[1] : "";
    if (what === "meetup-join") return { app: "teams", kind: "meeting", label: "Réunion Teams" };
    if (what === "message") return { app: "teams", kind: "message", label: "Message Teams" };
    if (what === "chat") return { app: "teams", kind: "chat", label: "Conversation Teams" };
    if (what === "channel") return { app: "teams", kind: "channel", label: parts[3] ? decode(parts[3]) : "Canal Teams" };
    return { app: "teams", kind: "link", label: "Teams" };
  }
  if (/-my\.sharepoint\.com$/.test(host) || host === "onedrive.live.com" || host === "1drv.ms")
    return { app: "onedrive", kind: "file", label: fileName(u) ?? "OneDrive" };
  if (/(^|\.)sharepoint\.com$/.test(host)) return { app: "sharepoint", kind: "file", label: fileName(u) ?? "SharePoint" };

  if (host === "figma.com" && /^(file|design|proto|board)$/.test(parts[0] ?? "") && parts[1])
    return { app: "figma", kind: "file", label: parts[2] ? parts[2].replace(/-/g, " ") : "Figma" };
  return null;
}

/** Bases Jira connues dans un fil, par projet : `{ ALL: "https://x.atlassian.net" }`.
 *  Une clé seule (« ALL-94 ») n'est reconnue que si son projet a déjà été lié dans le fil. */
export function jiraBases(urls: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const url of urls) {
    const ref = appRef(url);
    if (ref?.app !== "jira") continue;
    const u = new URL(url);
    const at = u.pathname.indexOf("/browse/");
    const base = at >= 0 ? `${u.origin}${u.pathname.slice(0, at)}` : u.origin;
    const project = ref.label.split("-")[0];
    out[project] ??= base;
  }
  return out;
}

/** Libellé d'un lien nommé Jira (« [ALL-141] Recherche identité - Jira ») : la clé en pastille,
 *  le résumé à côté. null si le texte n'a pas cette forme. */
export function jiraNamed(text: string): { key: string; title: string } | null {
  const m = /^\[?([A-Z][A-Z0-9]{1,9}-\d{1,7})\]?\s*[:\-–]?\s*(.*?)(?:\s+-\s+Jira)?$/.exec(text.trim());
  return m ? { key: m[1], title: m[2].trim() } : null;
}

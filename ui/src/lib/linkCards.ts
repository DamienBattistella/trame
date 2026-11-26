// Cartes d'aperçu d'un message (Jira, GitHub, un site) : ce qu'en montre une bulle.
// Pur (aucun import hors lib) : testé tel quel par `node --test` (ui/tests/linkCards.test.ts).
import { safeUrl } from "./linkify.ts";

export type CardKind = "jira" | "github" | "gitlab" | "web";
export type Card = { source: string; title: string; url: string; fields: string[] };
export type CardView = { kind: CardKind; source: string; title: string; url: string | null; detail: string };

const host = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};

function kindOf(source: string, h: string): CardKind {
  const s = source.toLowerCase();
  if (s === "jira" || /(^|\.)atlassian\.net$/.test(h)) return "jira";
  if (s === "github" || /(^|\.)github\.(com|io)$/.test(h)) return "github";
  if (s === "gitlab" || /(^|\.)gitlab\./.test(h)) return "gitlab";
  return "web";
}

/** Vue d'une carte : source, titre (l'adresse courte à défaut), adresse ouvrable ou null,
 *  et au plus deux champs (le premier et le dernier : assignée et état pour Jira). */
export function cardView(card: Card): CardView {
  const url = card.url ? safeUrl(card.url) : null;
  const h = host(url);
  const short = url ? url.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/$/, "") : "";
  const fields = card.fields.filter(Boolean);
  const picked = fields.length > 2 ? [fields[0], fields[fields.length - 1]] : fields;
  return {
    kind: kindOf(card.source, h),
    source: card.source || h,
    title: card.title || short,
    url,
    detail: picked.join(" · "),
  };
}

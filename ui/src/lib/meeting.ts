/** Lien d'une réunion Teams, tel que le moteur le relaie pour une conversation de réunion.
 *  Le moteur l'a déjà vérifié ; on le revérifie avant de l'ouvrir : seul un lien de réunion
 *  Microsoft Teams (https, hôte Teams, chemin de réunion) est ouvert, jamais autre chose. */
const HOSTS = new Set(["teams.microsoft.com", "teams.cloud.microsoft", "teams.live.com"]);
const PATHS = ["/l/meetup-join/", "/meet/"];

export function meetingUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 2048 || /[\s\u0000-\u001f]/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password || !HOSTS.has(u.hostname)) return null;
  // L'hôte tel qu'écrit (URL le met en minuscules) : comme le moteur, rien d'approchant.
  if (!raw.startsWith(`https://${u.hostname}/`)) return null;
  return PATHS.some((p) => u.pathname.startsWith(p) && u.pathname.length > p.length) ? raw : null;
}

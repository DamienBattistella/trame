/**
 * « Personnalisé » du statut Teams : jusqu'à une date et une heure locales. Teams ne
 * propose que des heures par demi-heure ; Trame s'en tient à 30 jours (comme le moteur).
 */
export const UNTIL_MAX_DAYS = 30;

const pad = (n: number) => String(n).padStart(2, "0");
/** AAAA-MM-JJ local (pas toISOString, qui passe en UTC). */
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Les demi-heures d'un jour ("HH:MM"), sans celles déjà passées si c'est aujourd'hui. */
export function halfHours(day: string, now: Date): string[] {
  const out: string[] = [];
  for (let i = 0; i < 48; i++) {
    const time = `${pad(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`;
    if (at(day, time) > now) out.push(time);
  }
  return out;
}

/** L'instant local visé. */
export const at = (day: string, time: string) => {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h, mi);
};

/** Bornes du choix de date : aujourd'hui, et au plus UNTIL_MAX_DAYS jours plus tard. */
export const dayBounds = (now: Date) => ({
  min: dayKey(now),
  max: dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + UNTIL_MAX_DAYS)),
});

/** Le choix proposé d'emblée : la prochaine demi-heure, au moins 30 minutes plus tard. */
export function defaultUntil(now: Date): { day: string; time: string } {
  const t = new Date(now.getTime() + 30 * 60_000);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() <= 30 ? (t.getMinutes() === 0 ? 0 : 30) : 60);
  return { day: dayKey(t), time: `${pad(t.getHours())}:${pad(t.getMinutes())}` };
}

/** Ce qu'attend le moteur : "AAAA-MM-JJTHH:MM", ou null si le choix est impossible. */
export function untilValue(day: string, time: string, now: Date): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:(00|30)$/.test(time)) return null;
  const end = at(day, time);
  if (Number.isNaN(end.getTime()) || dayKey(end) !== day) return null;
  const { max } = dayBounds(now);
  if (end <= now || day > max) return null;
  return `${day}T${time}`;
}

const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** « 14 h 30 », « demain 9 h », « jeudi 3 décembre 14 h 30 ». */
export function untilLabel(day: string, time: string, now: Date): string {
  const end = at(day, time);
  const hour = end.getMinutes() ? `${end.getHours()} h ${pad(end.getMinutes())}` : `${end.getHours()} h`;
  if (day === dayKey(now)) return hour;
  if (day === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) return `demain ${hour}`;
  return `${DAYS[end.getDay()]} ${end.getDate()} ${MONTHS[end.getMonth()]} ${hour}`;
}

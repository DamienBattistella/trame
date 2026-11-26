import { LogFilters, LogItem, LogLevel } from "@/types";
import { fold } from "@/lib/textSearch";

export const LOG_LEVELS: LogLevel[] = ["info", "warn", "sent", "draft"];

/** Une recherche d'au moins deux caractères, un niveau ou une date : la vue est filtrée. */
export function isFiltered(f: LogFilters): boolean {
  return fold(f.q).length >= 2 || (f.levels.length > 0 && f.levels.length < LOG_LEVELS.length) || !!f.since;
}

/** Paramètres de `/api/logs` et `/api/logs/export` (même sens que le moteur). */
export function logParams(f: LogFilters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams(extra);
  if (fold(f.q).length >= 2) p.set("q", f.q.trim());
  if (f.levels.length > 0 && f.levels.length < LOG_LEVELS.length) p.set("levels", f.levels.join(","));
  if (f.since) p.set("since", f.since);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

/** Même filtre que le moteur (backend/journal.py), pour le mode démo. */
export function filterLogs(logs: LogItem[], f: LogFilters): LogItem[] {
  const q = fold(f.q);
  return logs.filter(
    (l) =>
      (f.levels.length === 0 || f.levels.includes(l.level)) &&
      (!f.since || (l.ts ?? "") >= f.since) &&
      (q.length < 2 || fold(l.text).includes(q))
  );
}

/** Date et heure locales sans fuseau, comme le journal du moteur les écrit. */
export function localIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export type Period = "all" | "hour" | "today" | "week";

export function periodStart(p: Period, now = new Date()): string | undefined {
  if (p === "all") return undefined;
  if (p === "hour") return localIso(new Date(now.getTime() - 3600_000));
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (p === "week") d.setDate(d.getDate() - 6);
  return localIso(d);
}

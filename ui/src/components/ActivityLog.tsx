import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Loader2, Search, SearchX, X } from "lucide-react";
import { Trame } from "@/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GroupList, SectionLabel, Segment, spring } from "@/components/kit";
import { LogExportButtons } from "@/components/LogExportButtons";
import { Highlight } from "@/components/MessageSearchResults";
import { LOG_LEVELS, Period, isFiltered, periodStart } from "@/lib/logFilters";
import { findFolded } from "@/lib/textSearch";
import { cn } from "@/lib/utils";
import { LogFilters, LogItem, LogLevel } from "@/types";

const DEBOUNCE_MS = 250;
const PAGE = 100;

const DOT: Record<LogLevel, string> = { info: "bg-muted-foreground", warn: "bg-warning", sent: "bg-success", draft: "bg-primary" };
const LEVEL_LABEL: Record<LogLevel, string> = { info: "Infos", warn: "Alertes", sent: "Envois", draft: "Brouillons" };
const LEVEL_ONE: Record<LogLevel, string> = { info: "Info", warn: "Alerte", sent: "Envoi", draft: "Brouillon" };
const PERIODS: { value: Period; label: string }[] = [
  { value: "all", label: "Tout" },
  { value: "hour", label: "1 h" },
  { value: "today", label: "Aujourd'hui" },
  { value: "week", label: "7 jours" },
];

/** Heure seule aujourd'hui, date et heure avant. */
function when(l: LogItem) {
  if (!l.ts) return l.at;
  const d = new Date(l.ts);
  if (Number.isNaN(d.getTime()) || d.toDateString() === new Date().toDateString()) return l.at;
  return `${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${l.at}`;
}

/** Panneau Activité : recherche (sans accents ni casse), niveaux, période, sur le journal
 *  conservé d'un démarrage à l'autre. Copier / Exporter suivent la vue filtrée. */
export function ActivityLog({ logs, trame }: { logs: LogItem[]; trame: Trame }) {
  const id = useId();
  const [q, setQ] = useState("");
  const [levels, setLevels] = useState<LogLevel[]>([]);
  const [period, setPeriod] = useState<Period>("all");
  const [items, setItems] = useState<LogItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const seq = useRef(0);

  // Une nouvelle ligne d'activité relance la requête (la vue reste vivante) et
  // recalcule la période : « 1 h » reste la dernière heure.
  const newest = logs[0]?.ts ?? logs[0]?.at;
  const filters = useMemo<LogFilters>(() => ({ q, levels, since: periodStart(period) }), [q, levels, period, newest]);
  const filtered = isFiltered(filters);

  useEffect(() => {
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      const res = await trame.queryLogs(filters, null, PAGE);
      if (mine !== seq.current) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setItems(res.items);
      setTotal(res.total);
      setNext(res.next);
    }, items === null ? 0 : DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filters]);

  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    const mine = seq.current;
    const res = await trame.queryLogs(filters, next, PAGE);
    setMore(false);
    if (mine !== seq.current || !res.ok) return;
    setItems((cur) => [...(cur ?? []), ...res.items]);
    setNext(res.next);
  };

  const toggle = (l: LogLevel) => setLevels((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));
  const reset = () => {
    setQ("");
    setLevels([]);
    setPeriod("all");
  };

  // Sans moteur joignable, on garde au moins les lignes de cette session.
  const shown = items ?? (error ? logs : []);
  const loading = items === null && !error;

  return (
    <div className="flex h-full min-h-[28rem] flex-col gap-3 py-5">
      <div className="flex items-end justify-between gap-3">
        <SectionLabel>Activité</SectionLabel>
        <div className="mb-2">
          <LogExportButtons trame={trame} filters={filters} />
        </div>
      </div>

      {/* Recherche, niveaux et période sur une ligne dès qu'il y a la place (1024 px). */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-4">
      <div className="relative lg:min-w-64 lg:flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQ("")}
          placeholder="Rechercher dans l'activité…"
          aria-label="Rechercher dans l'activité"
          className="h-10 rounded-full pl-9 pr-9"
        />
        <AnimatePresence>
          {q && (
            <motion.button
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              onClick={() => setQ("")}
              aria-label="Effacer la recherche"
              className="absolute right-2.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Niveaux affichés">
        {LOG_LEVELS.map((l) => {
          const on = levels.includes(l);
          return (
            <button
              key={l}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(l)}
              className={cn(
                "relative rounded-full px-3 py-1 text-xs font-medium transition-colors",
                on ? "text-link" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {on && <motion.span layoutId={`level-${id}-${l}`} transition={spring} className="absolute inset-0 rounded-full bg-primary/12 ring-1 ring-primary/30" />}
              <span className="relative flex items-center gap-1.5">
                <span className={cn("size-2 rounded-full", DOT[l])} aria-hidden />
                {LEVEL_LABEL[l]}
              </span>
            </button>
          );
        })}
      </div>
        <div className="ml-auto">
          <Segment<Period> label="Période" value={period} onChange={setPeriod} options={PERIODS} />
        </div>
      </div>
      </div>

      <div className="flex min-h-5 items-center justify-between px-1 text-xs text-muted-foreground" aria-live="polite">
        <span className="tabular-nums">
          {loading ? (
            <Loader2 className="size-3 animate-spin" aria-label="Recherche en cours" />
          ) : error ? (
            error
          ) : filtered ? (
            total === 0 ? "Aucune ligne ne correspond" : `${total} ligne${total > 1 ? "s" : ""} correspond${total > 1 ? "ent" : ""}`
          ) : (
            `${total} ligne${total > 1 ? "s" : ""} d'activité`
          )}
        </span>
        {filtered && (
          <button type="button" onClick={reset} className="font-medium text-link hover:underline">
            Effacer les filtres
          </button>
        )}
      </div>

      <GroupList className="min-h-0 flex-1">
        <ScrollArea className="h-full" viewportLabel="Activité de Trame" viewportClassName="focus-visible:ring-inset">
          {!loading && shown.length === 0 &&
            (filtered ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
                <SearchX className="size-5" />
                Aucune activité ne correspond{q.trim() ? ` à « ${q.trim()} »` : ""}.
                <Button variant="outline" size="sm" className="mt-1 rounded-full" onClick={reset}>
                  Effacer les filtres
                </Button>
              </div>
            ) : (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                Aucune activité pour l'instant. Chaque message lu, réponse proposée ou envoi apparaîtra ici.
              </div>
            ))}
          <AnimatePresence initial={false}>
            {shown.map((l) => (
              <motion.div
                key={`${l.ts ?? l.at}-${l.text}`}
                layout
                initial={{ opacity: 0, y: -6, backgroundColor: "color-mix(in oklch, var(--primary) 12%, transparent)" }}
                animate={{ opacity: 1, y: 0, backgroundColor: "rgba(0,0,0,0)" }}
                transition={{ duration: 0.6 }}
                className="flex items-start gap-3 px-4 py-2.5 text-sm leading-5"
              >
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[l.level])} title={LEVEL_LABEL[l.level]} />
                <span className="shrink-0 font-mono text-xs leading-5 tabular-nums text-muted-foreground">{when(l)}</span>
                {/* Fenêtre large : le niveau en clair, en colonne, pour parcourir le journal d'un œil. */}
                <span className="hidden w-16 shrink-0 text-xs leading-5 text-muted-foreground xl:block">{LEVEL_ONE[l.level]}</span>
                <span className="min-w-0 flex-1 break-words">
                  <Highlight text={l.text} range={findFolded(l.text, q)} />
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
          {next && (
            <div className="flex justify-center px-4 py-3">
              <Button variant="ghost" size="sm" className="rounded-full" disabled={more} onClick={loadMore}>
                {more && <Loader2 className="size-4 animate-spin" />}
                Voir l'activité plus ancienne
              </Button>
            </div>
          )}
        </ScrollArea>
      </GroupList>
    </div>
  );
}

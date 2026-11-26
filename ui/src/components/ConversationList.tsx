import { useId, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GroupList, spring } from "@/components/kit";
import { cn } from "@/lib/utils";
import { Surface, WatchEntity } from "@/types";

type Filter = "all" | Surface | "watched";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Tous" },
  { id: "dm", label: "1:1" },
  { id: "group", label: "Groupes" },
  { id: "channel", label: "Canaux" },
  { id: "watched", label: "Suivies" },
];

const sortKey = (c: WatchEntity) => c.displayName.replace(/^#/, "");
const FEW = 6;
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Liste de conversations à grande échelle : recherche, filtres, sélection en masse,
 *  zone défilante à hauteur fixe. Partagée par le wizard et le panneau. */
export function ConversationList({
  items,
  renderRow,
  onBulk,
  filters = true,
  className = "h-[40vh]",
  fewClassName,
  footer,
}: {
  items: WatchEntity[];
  renderRow: (c: WatchEntity) => React.ReactNode;
  onBulk?: (ids: string[], watch: boolean) => void;
  filters?: boolean;
  className?: string;
  /** Hauteur maximale quand la liste est courte (pas de recherche ni de filtres). */
  fewClassName?: string;
  footer?: React.ReactNode;
}) {
  const few = items.length <= FEW;
  const id = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const matchesQuery = (c: WatchEntity) => !query || norm(c.displayName).includes(norm(query));

  const counts = useMemo(() => {
    const base = items.filter(matchesQuery);
    return {
      all: base.length,
      dm: base.filter((c) => c.surface === "dm").length,
      group: base.filter((c) => c.surface === "group").length,
      channel: base.filter((c) => c.surface === "channel").length,
      watched: base.filter((c) => c.watch).length,
    } as Record<Filter, number>;
  }, [items, query]);

  const visible = useMemo(
    () =>
      items
        .filter(matchesQuery)
        .filter((c) => filter === "all" || (filter === "watched" ? c.watch : c.surface === filter))
        .sort((a, b) => sortKey(a).localeCompare(sortKey(b), "fr", { sensitivity: "base" })),
    [items, query, filter]
  );

  const allVisibleWatched = visible.length > 0 && visible.every((c) => c.watch);
  const watchedTotal = items.filter((c) => c.watch).length;

  const rows = (
          <div className="divide-y divide-border">
            {visible.map((c) => (
              <div key={c.threadId} className="[content-visibility:auto] [contain-intrinsic-size:auto_56px]">
                {renderRow(c)}
              </div>
            ))}
            {visible.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
                Aucune conversation ne correspond{query ? ` à « ${query} »` : ""}.
                {(query || filter !== "all") && (
                  <button
                    type="button"
                    className="font-medium text-link hover:underline"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    Tout afficher
                  </button>
                )}
              </div>
            )}
          </div>
  );

  return (
    <div className="flex w-full flex-col gap-3 text-left">
      {!few && (
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Rechercher parmi ${items.length} conversations…`}
          className="h-10 rounded-full pl-9 pr-9"
        />
        <AnimatePresence>
          {query && (
            <motion.button
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              onClick={() => setQuery("")}
              aria-label="Effacer la recherche"
              className="absolute right-2.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
      )}

      {filters && !few && (
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "relative rounded-full px-3 py-1 text-xs font-medium transition-colors",
                filter === f.id ? "text-link" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {filter === f.id && (
                <motion.span layoutId={`filter-${id}`} transition={spring} className="absolute inset-0 rounded-full bg-primary/12 ring-1 ring-primary/30" />
              )}
              <span className="relative">
                {f.label} <span className="tabular-nums">{counts[f.id]}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      <GroupList>
        {few && fewClassName ? (
          <div className={cn("overflow-y-auto", fewClassName)}>{rows}</div>
        ) : (
          <ScrollArea className={cn("[&_[data-radix-scroll-area-viewport]>div]:!block", !few && className)}>{rows}</ScrollArea>
        )}
      </GroupList>

      <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
        {footer ?? (
          <span className="tabular-nums">
            {watchedTotal} suivie{watchedTotal > 1 ? "s" : ""} sur {items.length}
          </span>
        )}
        {onBulk && visible.length > 0 && (
          <button
            onClick={() => onBulk(visible.map((c) => c.threadId), !allVisibleWatched)}
            className="font-medium text-link hover:underline"
          >
            {allVisibleWatched ? "Tout décocher" : "Tout cocher"}
            {visible.length !== items.length && ` (${visible.length})`}
          </button>
        )}
      </div>
    </div>
  );
}

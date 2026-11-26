import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Star } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { InitialsAvatar } from "@/components/kit";
import { cn } from "@/lib/utils";
import type { WatchEntity } from "@/types";

const MAX = 50;
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/^#/, "").toLowerCase();

/** Ctrl+K : aller à une conversation en tapant quelques lettres de son nom. */
export function QuickSwitcher({
  open,
  onOpenChange,
  items,
  status,
  favorite,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dans l'ordre de la liste : favoris, à relire, non lues, suivies, autres. */
  items: WatchEntity[];
  status: (c: WatchEntity) => "review" | "unread" | null;
  /** Les favoris passent en premier, même parmi les résultats d'une recherche. */
  favorite: (c: WatchEntity) => boolean;
  onPick: (threadId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const results = useMemo(() => {
    const q = norm(query.trim());
    if (!q) return items.slice(0, MAX);
    // Le début du nom (ou d'un mot) passe avant une correspondance au milieu.
    const starts: WatchEntity[] = [];
    const inside: WatchEntity[] = [];
    for (const c of items) {
      const n = norm(c.displayName);
      if (n.startsWith(q) || n.includes(` ${q}`)) starts.push(c);
      else if (n.includes(q)) inside.push(c);
    }
    const found = [...starts, ...inside];
    return [...found.filter(favorite), ...found.filter((c) => !favorite(c))].slice(0, MAX);
  }, [items, query, favorite]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Après un choix, le focus va à la conversation ouverte, pas là où il était avant la palette.
  const picked = useRef(false);
  const pick = (c: WatchEntity | undefined) => {
    if (!c) return;
    picked.current = true;
    onOpenChange(false);
    onPick(c.threadId);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const n = results.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      pick(results[Math.min(active, n - 1)]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(e) => {
          if (picked.current) e.preventDefault();
          picked.current = false;
        }}
className="top-[20%] flex max-h-[min(30rem,calc(100dvh-8rem))] translate-y-0 flex-col gap-0 p-0 sm:max-w-md">
        <DialogTitle className="sr-only">Aller à une conversation</DialogTitle>
        <DialogDescription className="sr-only">Tape un nom, flèches pour choisir, Entrée pour ouvrir.</DialogDescription>
        <div className="relative border-b p-3">
          <Search className="pointer-events-none absolute top-1/2 left-6 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
            placeholder="Aller à une conversation"
            aria-label="Aller à une conversation"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="quick-switcher-results"
            aria-activedescendant={results[active] ? `quick-switcher-${active}` : undefined}
            className="h-10 rounded-full pl-9"
          />
        </div>
        <ul id="quick-switcher-results" ref={list} role="listbox" aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto p-2">
          {results.map((c, i) => {
            const s = status(c);
            return (
              <li
                key={c.threadId}
                id={`quick-switcher-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(c)}
                className={cn("flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-sm", i === active && "bg-secondary")}
              >
                <InitialsAvatar name={c.displayName} presence={c.presence} className="size-7" />
                <span className={cn("min-w-0 flex-1 truncate", s && "font-semibold")}>{c.displayName}</span>
                {favorite(c) && <Star className="size-3.5 shrink-0 fill-warning text-warning" aria-label="Favori" />}
                {s === "review" ? (
                  <span className="text-xs text-warning">À relire</span>
                ) : s === "unread" ? (
                  <span className="text-xs text-link">Non lu</span>
                ) : null}
              </li>
            );
          })}
          {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Aucune conversation à ce nom.</li>}
        </ul>
        <div className="flex items-center gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> choisir</span>
          <span className="flex items-center gap-1"><Kbd>Entrée</Kbd> ouvrir</span>
          <span className="flex items-center gap-1"><Kbd>Échap</Kbd> fermer</span>
          <span className="ml-auto flex items-center gap-1"><Kbd>Ctrl</Kbd>+<Kbd>/</Kbd> raccourcis</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

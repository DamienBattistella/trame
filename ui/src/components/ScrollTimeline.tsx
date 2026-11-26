import { useEffect, useMemo, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Un repère : un message du fil, retrouvé dans la page par `data-msg-key`. */
export type TimelineItem = { key: string; sender: string; mine: boolean; at: string; preview: string; head: boolean };

// Hauteur d'un repère (trait + espace) : la colonne en montre autant que la hauteur le permet.
const TICK = 8;
const MIN_ITEMS = 6;

const excerpt = (t: string, n = 90) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
};

/** Chronologie du fil sur le bord gauche : un trait par message (plus court pour les tiens),
 *  le message lu au centre de l'écran mis en avant. Survol : aperçu ; clic ou Entrée : y aller.
 *  Clavier : un seul arrêt de tabulation, flèches haut / bas, Début / Fin.
 *  Fil très long : un trait par tranche de messages, pour tenir dans la hauteur. */
export function ScrollTimeline({
  items,
  scrollEl,
  onJump,
  className,
}: {
  items: TimelineItem[];
  /** L'élément qui défile, contenant les messages marqués `data-msg-key`. */
  scrollEl: () => HTMLElement | null;
  onJump: (key: string) => void;
  className?: string;
}) {
  const [height, setHeight] = useState(0);
  const [scrollable, setScrollable] = useState(false);
  const [active, setActive] = useState(items.length - 1);
  // Repère choisi (clic, clavier) : il reste le repère courant le temps que le saut se pose,
  // même si son message ne peut pas être centré (début ou fin du fil).
  const pinned = useRef<{ index: number; until: number } | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  // Un trait par message, ou par tranche quand la hauteur manque ; `at` : son premier message.
  const ticks = useMemo(() => {
    const fit = Math.max(8, Math.floor((height * 0.72) / TICK));
    const size = Math.max(1, Math.ceil(items.length / fit));
    const out: { at: number; item: TimelineItem; count: number }[] = [];
    for (let i = 0; i < items.length; i += size) out.push({ at: i, item: items[i], count: Math.min(size, items.length - i) });
    return out;
  }, [items, height]);

  const tickOf = (index: number) => {
    let t = 0;
    for (let i = 0; i < ticks.length; i++) if (ticks[i].at <= index) t = i;
    return t;
  };

  // Le message au centre de l'écran, recalculé au défilement (une fois par image) et quand le fil change.
  useEffect(() => {
    const el = scrollEl();
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setHeight(el.clientHeight);
      setScrollable(el.scrollHeight > el.clientHeight + 40);
      const nodes = el.querySelectorAll<HTMLElement>("[data-msg-key]");
      if (!nodes.length) return;
      const box = el.getBoundingClientRect();
      if (pinned.current && performance.now() < pinned.current.until) return setActive(pinned.current.index);
      pinned.current = null;
      // En haut ou en bas du fil, le premier ou le dernier message ; sinon celui qui passe au
      // milieu de la vue (là où le saut le pose).
      if (el.scrollTop <= 4) return setActive(0);
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) return setActive(nodes.length - 1);
      const line = box.top + box.height / 2;
      let lo = 0;
      let hi = nodes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (nodes[mid].getBoundingClientRect().top <= line) lo = mid;
        else hi = mid - 1;
      }
      setActive(lo);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scrollEl, items.length]);

  if (items.length < MIN_ITEMS || !scrollable) return null;
  const current = tickOf(Math.min(active, items.length - 1));

  const go = (t: number, focus = false) => {
    const tick = ticks[Math.max(0, Math.min(ticks.length - 1, t))];
    if (!tick) return;
    pinned.current = { index: tick.at, until: performance.now() + 500 };
    setActive(tick.at);
    onJump(tick.item.key);
    if (focus) buttons.current[ticks.indexOf(tick)]?.focus();
  };

  const onKey = (e: React.KeyboardEvent, t: number) => {
    const to = e.key === "ArrowUp" ? t - 1 : e.key === "ArrowDown" ? t + 1 : e.key === "Home" ? 0 : e.key === "End" ? ticks.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    go(to, true);
  };

  return (
    <nav
      aria-label="Chronologie de la conversation"
      className={cn("pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center", className)}
    >
      <ol className="pointer-events-auto flex flex-col py-2 pr-2 pl-2.5">
        {ticks.map((tick, t) => {
          const on = t === current;
          const { item } = tick;
          const label = `${item.mine ? "Toi" : item.sender}${item.at ? `, ${item.at}` : ""} : ${excerpt(item.preview, 60) || "message sans texte"}${tick.count > 1 ? ` (et ${tick.count - 1} de plus)` : ""}`;
          return (
            <li key={item.key} className="flex">
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <button
                    ref={(b) => {
                      buttons.current[t] = b;
                    }}
                    type="button"
                    tabIndex={on ? 0 : -1}
                    aria-label={label}
                    aria-current={on ? "location" : undefined}
                    onClick={() => go(t)}
                    onKeyDown={(e) => onKey(e, t)}
                    className="group/tick flex h-2 w-7 items-center rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "h-0.5 rounded-full transition-[width,background-color] duration-200 ease-out",
                        on
                          ? "w-5 bg-foreground"
                          : cn(
                              item.mine ? "w-2 bg-foreground/25" : item.head ? "w-3.5 bg-foreground/45" : "w-2.5 bg-foreground/35",
                              "group-hover/tick:w-4 group-hover/tick:bg-foreground/80"
                            )
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={6} className="max-w-72 py-1.5">
                  <span className="block text-xs font-semibold">
                    {item.mine ? "Toi" : item.sender}
                    {item.at && <span className="ml-1.5 font-normal opacity-70 tabular-nums">{item.at}</span>}
                  </span>
                  <span className="line-clamp-2 text-xs opacity-90">{excerpt(item.preview) || "Message sans texte"}</span>
                </TooltipContent>
              </Tooltip>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

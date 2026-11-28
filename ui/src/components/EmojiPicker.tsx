// Sélecteur d'emoji : toute la bibliothèque Unicode, à insérer dans un message ou à mettre en
// réaction. Chargé à la demande (le catalogue pèse quelques centaines de ko).
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import raw from "@/data/emoji.json";
import { REACTIONS, Reaction } from "@/types";
import { cn } from "@/lib/utils";
import { Emoji, EmojiCatalogData, SKIN_TONES, SkinTone, canvasCanDraw, decodeCatalog, drawable, reactionKey, searchEmoji, withTone } from "@/lib/emoji";

const catalog = decodeCatalog(raw as unknown as EmojiCatalogData);
const FLAGS = catalog.groups.length - 1;
let shown: Emoji[] | null = null;
/** Le catalogue moins ce que la police du système ne sait pas dessiner (calculé une fois). */
const visible = () => (shown ??= drawable(catalog.emoji, FLAGS, canvasCanDraw()));

export interface EmojiPick {
  /** Le caractère, avec la teinte choisie. */
  emoji: string;
  /** La clé de réaction Teams (avec sa teinte), null si Teams ne l'accepte pas en réaction. */
  key: Reaction | null;
}

export default function EmojiPicker({
  mode,
  tone,
  onTone,
  mine = [],
  onPick,
}: {
  /** « message » : tout s'insère ; « reaction » : seuls les emoji que Teams accepte en réaction. */
  mode: "message" | "reaction";
  tone: SkinTone;
  onTone: (t: SkinTone) => void;
  /** Tes réactions déjà mises sur le message (clés Teams). */
  mine?: Reaction[];
  onPick: (p: EmojiPick) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [tones, setTones] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const all = useMemo(visible, []);
  const hits = useMemo(() => (query.trim() ? searchEmoji(all, query) : null), [all, query]);
  const sections = useMemo(
    () => (hits ? [{ group: -1, title: hits.length ? "Résultats" : "", items: hits }] : catalog.groups.map((title, group) => ({ group, title, items: all.filter((e) => e.group === group) }))),
    [all, hits]
  );
  const reactionOnly = mode === "reaction";

  // La recherche prend le focus à l'ouverture, après celui que la fenêtre donne elle-même.
  useEffect(() => {
    const id = setTimeout(() => search.current?.focus());
    return () => clearTimeout(id);
  }, []);

  // Accolades : scrollTo rend une promesse dans les Chromium récents, et un effet ne rend
  // qu'une fonction de nettoyage.
  useEffect(() => {
    list.current?.scrollTo({ top: 0 });
  }, [query]);

  const pick = (e: Emoji) => {
    const key = reactionKey(e, tone);
    if (reactionOnly && !key) return;
    onPick({ emoji: withTone(e, tone), key });
  };

  const onScroll = () => {
    const box = list.current;
    if (!box || hits) return;
    const heads = Array.from(box.querySelectorAll<HTMLElement>("[data-group]"));
    const top = box.scrollTop + 8;
    let current = 0;
    for (const h of heads) if (h.offsetTop <= top) current = Number(h.dataset.group);
    setActive(current);
  };

  const jump = (group: number) => {
    setQuery("");
    setActive(group);
    // Après le rendu (la recherche effacée remet toutes les catégories en place).
    setTimeout(() => {
      const head = list.current?.querySelector<HTMLElement>(`[data-group="${group}"]`);
      if (head && list.current) list.current.scrollTop = head.offsetTop;
    });
  };

  const current = SKIN_TONES[tone];
  return (
    <div className="flex w-[22rem] flex-col gap-2" onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1.5">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-background px-2 text-sm focus-within:ring-2 focus-within:ring-ring/50">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hits) {
                e.preventDefault();
                const first = hits.find((h) => !reactionOnly || h.teamsKey);
                if (first) pick(first);
              }
            }}
            placeholder={reactionOnly ? "Chercher une réaction" : "Chercher un emoji"}
            aria-label={reactionOnly ? "Chercher une réaction" : "Chercher un emoji"}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div className="relative">
          <button
            type="button"
            title={`Teinte de peau : ${current.label}`}
            aria-label={`Teinte de peau : ${current.label}`}
            aria-expanded={tones}
            onClick={() => setTones((v) => !v)}
            className="grid size-8 place-items-center rounded-md text-lg leading-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          >
            {current.swatch}
          </button>
          {tones && (
            <div role="radiogroup" aria-label="Teinte de peau" className="absolute top-9 right-0 z-10 flex gap-0.5 rounded-md border bg-popover p-1 shadow-md">
              {SKIN_TONES.map((t) => (
                <button
                  key={t.tone}
                  type="button"
                  role="radio"
                  aria-checked={t.tone === tone}
                  title={t.label}
                  aria-label={t.label}
                  onClick={() => {
                    onTone(t.tone);
                    setTones(false);
                  }}
                  className={cn("grid size-8 place-items-center rounded-md text-lg leading-none hover:bg-muted", t.tone === tone && "bg-primary/15")}
                >
                  {t.swatch}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {reactionOnly && !hits && (
        <div className="flex justify-between gap-0.5 border-b pb-2" aria-label="Réactions rapides">
          {REACTIONS.map((r) => (
            <button
              key={r.key}
              type="button"
              title={mine.includes(r.key) ? `${r.label} · cliquer pour retirer` : r.label}
              aria-label={mine.includes(r.key) ? `Retirer la réaction : ${r.label}` : `Réagir : ${r.label}`}
              aria-pressed={mine.includes(r.key)}
              onClick={() => onPick({ emoji: r.emoji, key: r.key })}
              className={cn("grid size-9 place-items-center rounded-full text-xl leading-none transition-transform hover:scale-125 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring", mine.includes(r.key) && "bg-primary/10")}
            >
              {r.emoji}
            </button>
          ))}
        </div>
      )}

      <div ref={list} onScroll={onScroll} className="relative h-72 overflow-y-auto overscroll-contain pr-1" role="listbox" aria-label="Emoji">
        {sections.map((s) => (
          <section key={s.group} data-group={hits ? undefined : s.group} aria-label={s.title || "Aucun résultat"} style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${Math.ceil(s.items.length / 9) * 36 + 28}px` }}>
            {s.title && (
              <h3 className="sticky top-0 z-[1] bg-popover/95 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
                {s.title}
              </h3>
            )}
            <div className="grid grid-cols-9">
              {s.items.map((e) => {
                const key = reactionKey(e, tone);
                const off = reactionOnly && !key;
                const on = !!key && mine.includes(key);
                return (
                  <button
                    key={e.emoji}
                    type="button"
                    role="option"
                    aria-selected={on}
                    aria-disabled={off || undefined}
                    title={off ? `${e.name} · Teams ne l'accepte pas en réaction` : e.name}
                    aria-label={e.name}
                    onClick={() => pick(e)}
                    className={cn(
                      "grid size-9 place-items-center rounded-md text-[1.35rem] leading-none focus-visible:outline-2 focus-visible:outline-ring",
                      off ? "cursor-not-allowed opacity-25 grayscale" : "hover:bg-muted",
                      on && "bg-primary/15"
                    )}
                  >
                    {withTone(e, tone)}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        {hits && !hits.length && <p className="py-8 text-center text-sm text-muted-foreground">Aucun emoji pour « {query.trim()} »</p>}
      </div>

      {!hits && (
        <nav aria-label="Catégories" className="flex justify-between border-t pt-1.5">
          {catalog.groups.map((title, g) => (
            <button
              key={title}
              type="button"
              title={title}
              aria-label={title}
              aria-current={g === active || undefined}
              onClick={() => jump(g)}
              className={cn("grid size-8 place-items-center rounded-md text-base leading-none hover:bg-muted", g === active ? "bg-muted" : "opacity-60 grayscale-[.6]")}
            >
              {all.find((e) => e.group === g)?.emoji}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, Reorder } from "motion/react";
import { ArrowDown, ArrowUp, BellRing, ChevronRight, History, Inbox as InboxIcon, Loader2, Search, SquarePen, Star, StarOff, Timer, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu";
import { InitialsAvatar, spring } from "@/components/kit";
import { DiscussionView } from "@/components/DiscussionView";
import { NewConversation } from "@/components/NewConversation";
import { MessageSearchResults } from "@/components/MessageSearchResults";
import { ReflectionPanel } from "@/components/ReflectionPanel";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { Trame } from "@/api";
import { MessageText } from "@/components/MessageText";
import { QuickSwitcher } from "@/components/QuickSwitcher";
import { isFavoriteKey, isSwitcherKey, isTyping, overlayOpen, takeSwitcherRequest } from "@/lib/shortcuts";
import { DraftItem, MessageHit, WatchEntity } from "@/types";
import type { BriefTarget } from "@/components/BriefSheet";

const BriefSheet = lazy(() => import("@/components/BriefSheet").then((m) => ({ default: m.BriefSheet })));
const BRIEF_WIDTH = 420;

type GroupId = "favorites" | "review" | "followUp" | "unread" | "followed" | "others";
const GROUPS: { id: GroupId; label: string }[] = [
  { id: "favorites", label: "Favoris" },
  { id: "review", label: "À relire" },
  { id: "followUp", label: "À relancer" },
  { id: "unread", label: "Non lus" },
  { id: "followed", label: "Suivies" },
  { id: "others", label: "Autres" },
];
const KIND = { dm: "Conversation privée", group: "Groupe", channel: "Canal" } as const;

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const byRecent = (a: WatchEntity, b: WatchEntity) =>
  (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
  a.displayName.replace(/^#/, "").localeCompare(b.displayName.replace(/^#/, ""), "fr", { sensitivity: "base" });

/** Discussions : barre latérale regroupée par statut, discussion choisie à droite. */
export function Inbox({ trame, onBrief }: { trame: Trame; onBrief: (t: BriefTarget) => void }) {
  const { watchlist, drafts, followUps, favorites } = trame.state;
  // Pendant un glisser-déposer : l'ordre en cours, enregistré au lâcher.
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const favOrder = dragOrder ?? favorites;
  const favIndex = useMemo(() => new Map(favOrder.map((t, i) => [t, i])), [favOrder]);
  const isFavorite = (threadId: string) => favIndex.has(threadId);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // Message trouvé par la recherche : la discussion s'ouvre dessus.
  const [found, setFound] = useState<MessageHit | null>(null);
  const select = (threadId: string, hit: MessageHit | null = null) => {
    setSelected(threadId);
    setFound(hit);
  };
  const [collapsed, setCollapsed] = useState<Record<GroupId, boolean>>({ favorites: false, review: false, followUp: false, unread: false, followed: false, others: true });
  const [catching, setCatching] = useState(false);
  // Panneau ancré à droite : le résumé, ou la réflexion du modèle pendant une action.
  const [dock, setDock] = useState<"brief" | "reflection" | null>(null);
  const [starting, setStarting] = useState(false);
  const wide = useWide();

  // The engine lists the newest draft first: keep that one per conversation.
  const draftOf = useMemo(() => {
    const m = new Map<string, (typeof drafts)[number]>();
    for (const d of drafts) if (!m.has(d.threadId)) m.set(d.threadId, d);
    return m;
  }, [drafts]);
  // Relances proposées : la plus ancienne question par conversation.
  const followUpOf = useMemo(() => {
    const m = new Map<string, (typeof followUps)[number]>();
    for (const f of followUps) if (!m.has(f.threadId)) m.set(f.threadId, f);
    return m;
  }, [followUps]);

  const items = useMemo<WatchEntity[]>(() => {
    const known = new Set(watchlist.map((w) => w.threadId));
    const base: WatchEntity[] = [
      ...watchlist,
      ...[...draftOf.values()]
        .filter((d) => !known.has(d.threadId))
        .map((d) => ({ threadId: d.threadId, displayName: d.from, surface: d.surface, watch: true, mode: d.mode, namedPeople: [] })),
    ];
    const listed = new Set(base.map((c) => c.threadId));
    return [
      ...base,
      ...[...followUpOf.values()]
        .filter((f) => !listed.has(f.threadId))
        .map((f) => ({ threadId: f.threadId, displayName: f.conversation, surface: "dm" as const, watch: false, mode: "draft" as const, namedPeople: [] })),
    ];
  }, [watchlist, draftOf, followUpOf]);

  // Un favori n'apparaît qu'une fois, dans « Favoris » : ses indicateurs (à relire,
  // relance, non lu, présence) restent sur sa ligne.
  const groupOf = (c: WatchEntity): GroupId =>
    favIndex.has(c.threadId)
      ? "favorites"
      : draftOf.has(c.threadId)
      ? "review"
      : followUpOf.has(c.threadId)
        ? "followUp"
        : c.unread
          ? "unread"
          : c.watch
            ? "followed"
            : "others";

  const grouped = useMemo(() => {
    const out: Record<GroupId, WatchEntity[]> = { favorites: [], review: [], followUp: [], unread: [], followed: [], others: [] };
    for (const c of items) out[groupOf(c)].push(c);
    for (const g of Object.values(out)) g.sort(byRecent);
    // Les favoris gardent l'ordre choisi par l'utilisateur, pas l'activité.
    out.favorites.sort((a, b) => (favIndex.get(a.threadId) ?? 0) - (favIndex.get(b.threadId) ?? 0));
    return out;
  }, [items, draftOf, followUpOf, favIndex]);

  const groups = useMemo(() => {
    if (!query) return grouped;
    const q = norm(query);
    const keep = (list: WatchEntity[]) => list.filter((c) => norm(c.displayName).includes(q));
    return {
      favorites: keep(grouped.favorites),
      review: keep(grouped.review),
      followUp: keep(grouped.followUp),
      unread: keep(grouped.unread),
      followed: keep(grouped.followed),
      others: keep(grouped.others),
    };
  }, [grouped, query]);

  const all = GROUPS.flatMap((g) => groups[g.id]);
  // Pour Ctrl+K : toutes les conversations, même celles qu'une recherche cache ; favoris d'abord.
  const everything = useMemo(() => GROUPS.flatMap((g) => grouped[g.id]), [grouped]);
  // From every conversation, not the filtered ones: searching must not close the
  // open discussion and lose a reply being written.
  const current = items.find((c) => c.threadId === selected) ?? null;

  // Première ouverture : la première réponse à relire, sinon rien de choisi.
  useEffect(() => {
    if (!selected && groups.review[0]) select(groups.review[0].threadId);
  }, [groups.review.length]);

  // ── Clavier ────────────────────────────────────────────────────────────
  const [switching, setSwitching] = useState(takeSwitcherRequest);
  const sidebar = useRef<HTMLElement>(null);
  const discussion = useRef<HTMLElement>(null);
  const itemButton = (threadId: string) =>
    sidebar.current?.querySelector<HTMLButtonElement>(`[data-conv="${CSS.escape(threadId)}"]`) ?? null;

  /** Ouvre une conversation au clavier ; son groupe se déplie s'il était replié. */
  const goTo = (threadId: string, focus: "keep" | "composer") => {
    const target = items.find((c) => c.threadId === threadId);
    if (!target) return;
    const inList = sidebar.current?.contains(document.activeElement) ?? false;
    setCollapsed((s) => ({ ...s, [groupOf(target)]: false }));
    select(threadId);
    // Le focus suit : sur la conversation dans la liste si on y était, sinon dans la zone de réponse.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (focus === "composer") discussion.current?.querySelector<HTMLTextAreaElement>("textarea:not([disabled])")?.focus();
        else if (inList) itemButton(threadId)?.focus();
      })
    );
  };

  /** Alt+↓/↑ : non lue (ou à relire) suivante ; Alt+Maj+↓/↑ : suivante dans la liste. */
  const step = (dir: 1 | -1, anyConversation: boolean) => {
    const pool = anyConversation ? all : all.filter((c) => draftOf.has(c.threadId) || c.unread);
    if (!pool.length) {
      if (!anyConversation) toast.info("Aucune conversation non lue");
      return;
    }
    const here = current ? all.findIndex((c) => c.threadId === current.threadId) : -1;
    let next: WatchEntity | undefined;
    if (here < 0) next = dir === 1 ? pool[0] : pool[pool.length - 1];
    else {
      // Première de la réserve après (ou avant) la conversation ouverte, en bouclant.
      const pos = (c: WatchEntity) => all.indexOf(c);
      const after = pool.filter((c) => (dir === 1 ? pos(c) > here : pos(c) < here));
      next = after.length ? (dir === 1 ? after[0] : after[after.length - 1]) : dir === 1 ? pool[0] : pool[pool.length - 1];
    }
    if (next && next.threadId !== current?.threadId) goTo(next.threadId, "keep");
  };

  // ── Favoris ────────────────────────────────────────────────────────────
  const toggleFavorite = (c: WatchEntity) => {
    const adding = !isFavorite(c.threadId);
    trame.toggleFavorite(c.threadId).then((r) => {
      if (!r.ok) return toast.error("Modification impossible", { description: r.error });
      if (adding) setCollapsed((s) => ({ ...s, favorites: false }));
      toast.success(adding ? `${c.displayName} épinglée dans les favoris` : `${c.displayName} retirée des favoris`);
    });
  };
  /** Déplace un favori d'un cran (menu contextuel, Ctrl+Maj+↑/↓) ; le focus le suit. */
  const moveFavorite = (threadId: string, dir: 1 | -1) => {
    const order = [...favorites];
    const at = order.indexOf(threadId);
    const to = at + dir;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to], order[at]];
    const hadFocus = document.activeElement === itemButton(threadId);
    trame.reorderFavorites(order).then((r) => !r.ok && toast.error("Déplacement impossible", { description: r.error }));
    if (hadFocus) requestAnimationFrame(() => requestAnimationFrame(() => itemButton(threadId)?.focus()));
  };
  /** Conversation visée par un raccourci : celle qui a le focus dans la liste, sinon l'ouverte. */
  const targeted = () => {
    const id = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-conv]")?.dataset.conv;
    return (id && items.find((c) => c.threadId === id)) || current;
  };

  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  onKeyRef.current = (e) => {
    if (e.defaultPrevented) return;
    if (isSwitcherKey(e)) {
      if (overlayOpen() && !switching) return;
      e.preventDefault();
      setSwitching((o) => !o);
      return;
    }
    if (overlayOpen()) return;
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      // Échap dans la discussion : retour à la liste, sur la conversation ouverte.
      // La discussion reste ouverte : un brouillon en cours n'est jamais perdu.
      if (!current || sidebar.current?.contains(document.activeElement)) return;
      const button = itemButton(current.threadId) ?? sidebar.current?.querySelector<HTMLButtonElement>("[data-conv]");
      if (!button) return;
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
      button.focus();
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowDown" || e.key === "ArrowUp") && !isTyping(e)) {
      e.preventDefault();
      step(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
      return;
    }
    if (isFavoriteKey(e) && !isTyping(e)) {
      const target = targeted();
      if (!target) return;
      e.preventDefault();
      toggleFavorite(target);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** ↑/↓ dans la liste : d'une conversation à l'autre, sans l'ouvrir (Entrée l'ouvre). */
  const onListKey = (e: React.KeyboardEvent) => {
    // Ctrl+Maj+↑/↓ sur un favori : le monter ou le descendre.
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const id = (document.activeElement as HTMLElement | null)?.dataset.conv;
      if (id && isFavorite(id) && !query) {
        e.preventDefault();
        moveFavorite(id, e.key === "ArrowDown" ? 1 : -1);
      }
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const buttons = [...(sidebar.current?.querySelectorAll<HTMLButtonElement>("[data-conv]") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 || !buttons.length) return;
    e.preventDefault();
    const to = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : Math.min(Math.max(at + (e.key === "ArrowDown" ? 1 : -1), 0), buttons.length - 1);
    buttons[to].focus();
    buttons[to].scrollIntoView({ block: "nearest" });
  };

  // Le clic qui termine un glisser-déposer n'ouvre pas la conversation.
  const dragged = useRef(false);
  const commitDrag = () => {
    const next = dragOrder;
    setDragOrder(null);
    requestAnimationFrame(() => (dragged.current = false));
    if (next && next.join("\n") !== favorites.join("\n"))
      trame.reorderFavorites(next).then((r) => !r.ok && toast.error("Déplacement impossible", { description: r.error }));
  };

  /** Une ligne de la liste : la conversation, son étoile au survol et son menu contextuel. */
  const row = (c: WatchEntity) => {
    const fav = isFavorite(c.threadId);
    const at = favorites.indexOf(c.threadId);
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group/row relative">
            <SidebarItem
              c={c}
              draft={draftOf.get(c.threadId) ?? null}
              followUp={followUpOf.get(c.threadId)?.question ?? null}
              active={c.threadId === current?.threadId}
              onClick={() => !dragged.current && select(c.threadId)}
            />
            <FavoriteStar favorite={fav} name={c.displayName} onToggle={() => toggleFavorite(c)} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-64">
          <ContextMenuItem onSelect={() => toggleFavorite(c)}>
            {fav ? <StarOff /> : <Star />}
            {fav ? "Retirer des favoris" : "Ajouter aux favoris"}
            <ContextMenuShortcut>Alt+F</ContextMenuShortcut>
          </ContextMenuItem>
          {fav && favorites.length > 1 && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={at <= 0} onSelect={() => moveFavorite(c.threadId, -1)}>
                <ArrowUp />
                Monter
                <ContextMenuShortcut>Ctrl+Maj+↑</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem disabled={at >= favorites.length - 1} onSelect={() => moveFavorite(c.threadId, 1)}>
                <ArrowDown />
                Descendre
                <ContextMenuShortcut>Ctrl+Maj+↓</ContextMenuShortcut>
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const catchUp = async () => {
    setCatching(true);
    const res = await trame.catchUp();
    setCatching(false);
    if (!res.ok) return toast.error("Rattrapage impossible", { description: `${res.error} Aucun message n'a été perdu.` });
    const n = res.queued ?? 0;
    toast[n > 0 ? "success" : "info"](n > 0 ? `${n} réponse${n > 1 ? "s" : ""} à relire` : "Aucun message non lu");
  };

  return (
    <div className="flex h-full min-h-0">
      <QuickSwitcher
        open={switching}
        onOpenChange={setSwitching}
        items={everything}
        status={(c) => (draftOf.has(c.threadId) ? "review" : c.unread ? "unread" : null)}
        favorite={(c) => isFavorite(c.threadId)}
        onPick={(threadId) => {
          // Une recherche en cours pourrait cacher la conversation choisie dans la liste.
          if (query && !all.some((c) => c.threadId === threadId)) setQuery("");
          goTo(threadId, "composer");
        }}
      />
      <aside ref={sidebar} className="flex w-72 shrink-0 flex-col border-r">
        <div className="flex items-center gap-1.5 p-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher"
              aria-label="Rechercher une discussion ou un message"
              className="h-9 rounded-full pl-9"
            />
            {query && (
              <button
                type="button"
                aria-label="Effacer la recherche"
                onClick={() => setQuery("")}
                className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-accent"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-9 rounded-full" aria-label="Rattraper les non-lus" disabled={catching} onClick={catchUp}>
                {catching ? <Loader2 className="size-4 animate-spin" /> : <History className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Rattraper les non-lus</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-9 rounded-full" aria-label="Nouvelle conversation" onClick={() => setStarting(true)}>
                <SquarePen className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Nouvelle conversation</TooltipContent>
          </Tooltip>
          <NewConversation
            trame={trame}
            open={starting}
            onOpenChange={setStarting}
            onOpened={(threadId) => {
              // La conversation peut tomber dans un groupe replié (« Autres ») : on l'ouvre.
              setQuery("");
              setCollapsed({ favorites: false, review: false, followUp: false, unread: false, followed: false, others: false });
              setSelected(threadId);
            }}
          />
        </div>
        <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
          <nav aria-label="Discussions" onKeyDown={onListKey} className="flex flex-col gap-3 px-2 pb-3">
            {GROUPS.map((g) => {
              const list = groups[g.id];
              if (list.length === 0) return null;
              const closed = collapsed[g.id] && !query;
              return (
                <section key={g.id}>
                  <button
                    type="button"
                    aria-expanded={!closed}
                    onClick={() => setCollapsed((s) => ({ ...s, [g.id]: !s[g.id] }))}
                    className="flex w-full items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <ChevronRight className={cn("size-3.5 transition-transform", !closed && "rotate-90")} />
                    {g.label}
                    <span className="ml-auto tabular-nums">{list.length}</span>
                  </button>
                  <AnimatePresence initial={false}>
                    {!closed && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                      >
                        {g.id === "favorites" && !query ? (
                          // Glisser-déposer pour choisir l'ordre ; au clavier : Ctrl+Maj+↑/↓ ou le menu contextuel.
                          <Reorder.Group axis="y" values={favOrder} onReorder={setDragOrder} className="flex flex-col" aria-label="Favoris, dans l'ordre choisi">
                            {list.map((c) => (
                              <Reorder.Item
                                key={c.threadId}
                                value={c.threadId}
                                onDragStart={() => (dragged.current = true)}
                                onDragEnd={commitDrag}
                                className="relative"
                              >
                                {row(c)}
                              </Reorder.Item>
                            ))}
                          </Reorder.Group>
                        ) : (
                          <ul className="flex flex-col">
                            {list.map((c) => (
                              <li key={c.threadId} className="relative [content-visibility:auto] [contain-intrinsic-size:auto_56px]">
                                {row(c)}
                              </li>
                            ))}
                          </ul>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </section>
              );
            })}
            {all.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">{query ? "Aucune discussion à ce nom." : "Aucune discussion."}</p>
            )}
            <MessageSearchResults trame={trame} query={query} onOpen={(h) => h.threadId && select(h.threadId, h)} />
          </nav>
        </ScrollArea>
      </aside>

      <main ref={discussion} className="min-w-0 flex-1">
        {current ? (
          <DiscussionView
            key={current.threadId}
            trame={trame}
            conversation={current}
            draft={draftOf.get(current.threadId) ?? null}
            found={found?.threadId === current.threadId ? found : null}
            favorite={isFavorite(current.threadId)}
            onFavorite={() => toggleFavorite(current)}
            onBrief={(t) => (wide ? setDock((d) => (d === "brief" ? null : "brief")) : onBrief(t))}
            reflectionOpen={dock === "reflection"}
            onReflection={(open) => setDock((d) => (open ? "reflection" : d === "reflection" ? null : d))}
            autoReflection={wide}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <span className="grid size-12 place-items-center rounded-full bg-secondary text-muted-foreground">
              <InboxIcon className="size-5" />
            </span>
            <p className="font-medium">{groups.review.length ? "Choisis une discussion" : "Rien à relire"}</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              {groups.followed.length + groups.review.length > 0
                ? "Quand on t'écrit dans une discussion suivie, la réponse proposée apparaît en haut à gauche."
                : "Suis des discussions (interrupteur « Suivie ») pour que Trame prépare tes réponses."}
            </p>
          </div>
        )}
      </main>

      {/* Résumé ancré à droite : il pousse la discussion au lieu de la recouvrir, et suit
          la discussion choisie dans la barre latérale. */}
      <AnimatePresence initial={false}>
        {dock === "reflection" && wide && (
          <motion.aside
            key="reflection"
            aria-label="Réflexion du modèle"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: BRIEF_WIDTH, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={spring}
            className="shrink-0 overflow-hidden border-l bg-sidebar"
          >
            <div className="h-full" style={{ width: BRIEF_WIDTH }}>
              <ReflectionPanel trame={trame} onClose={() => setDock(null)} />
            </div>
          </motion.aside>
        )}
        {dock === "brief" && wide && current && trame.briefPrefs.enabled && (
          <motion.aside
            key="brief"
            aria-label="Résumé de la discussion"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: BRIEF_WIDTH, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={spring}
            className="shrink-0 overflow-hidden border-l bg-sidebar"
          >
            <div className="h-full" style={{ width: BRIEF_WIDTH }}>
              <Suspense fallback={null}>
                <BriefSheet
                  dock
                  trame={trame}
                  target={{ threadId: current.threadId, displayName: current.displayName }}
                  onClose={() => setDock(null)}
                />
              </Suspense>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
      {/* Fenêtre étroite : la réflexion s'ouvre en tiroir, seulement à la demande. */}
      <Sheet open={dock === "reflection" && !wide} onOpenChange={(o) => !o && setDock(null)}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-[420px] [&>button]:hidden" onOpenAutoFocus={(e) => e.preventDefault()}>
          <SheetTitle className="sr-only">Réflexion du modèle</SheetTitle>
          <ReflectionPanel trame={trame} onClose={() => setDock(null)} />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function SidebarItem({ c, draft, followUp, active, onClick }: { c: WatchEntity; draft: DraftItem | null; followUp: string | null; active: boolean; onClick: () => void }) {
  const preview = draft ? draft.incoming : followUp ? `Toi : ${followUp}` : c.namedPeople.length ? `réagit à ${c.namedPeople.join(", ")}` : KIND[c.surface];
  // Ouverte au clavier (Alt+↓, Ctrl+K), la conversation peut être hors de vue : on l'y ramène.
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      data-conv={c.threadId}
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "relative flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors",
        active ? "text-foreground" : "hover:bg-accent/60"
      )}
    >
      {active && <motion.span layoutId="inbox-active" transition={spring} className="absolute inset-0 rounded-xl bg-secondary" />}
      <InitialsAvatar name={c.displayName} presence={c.presence} className="relative size-8" />
      <span className="relative flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm", (c.unread || draft || followUp) && "font-semibold", !c.watch && !draft && !followUp && !c.unread && "text-muted-foreground")}>
            {c.displayName}
          </span>
          {c.lastActivity && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{c.lastActivity}</span>}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            <MessageText text={preview} interactive={false} />
          </span>
          {c.watch && c.mode === "auto" && <Timer className="size-3 shrink-0 text-warning" aria-label="Envoi auto" />}
          {draft ? (
            <span className="size-2 shrink-0 rounded-full bg-warning" aria-label="Réponse à relire" />
          ) : followUp ? (
            <BellRing className="size-3 shrink-0 text-warning" aria-label="Relance proposée" />
          ) : c.unread ? (
            <span className="size-2 shrink-0 rounded-full bg-link" aria-label="Non lu" />
          ) : null}
        </span>
      </span>
    </button>
  );
}

/** Étoile au survol d'une ligne (ou au focus) : épingle la conversation dans « Favoris ».
 *  Hors de l'ordre de tabulation : au clavier, Alt+F ou le menu contextuel. */
function FavoriteStar({ favorite, name, onToggle }: { favorite: boolean; name: string; onToggle: () => void }) {
  const label = favorite ? `Retirer ${name} des favoris` : `Ajouter ${name} aux favoris`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label={label}
          aria-pressed={favorite}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full bg-background/90 text-muted-foreground opacity-0 shadow-xs transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 hover:text-foreground focus-visible:opacity-100"
        >
          <Star className={cn("size-3.5", favorite && "fill-warning text-warning")} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{favorite ? "Retirer des favoris" : "Ajouter aux favoris"} · Alt+F</TooltipContent>
    </Tooltip>
  );
}

/** Fenêtre assez large pour le panneau de résumé à côté de la discussion. */
function useWide(query = "(min-width: 1024px)") {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return wide;
}

import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from "@dnd-kit/core";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, BellRing, Bot, CheckCheck, ChevronRight, Clock, EllipsisVertical, EyeOff, History, Inbox as InboxIcon, Loader2, MessagesSquare, PenLine, Search, SquarePen, Star, StarOff, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu";
import { AUTO_HINT, InitialsAvatar, spring } from "@/components/kit";
import { DiscussionView } from "@/components/DiscussionView";
import { NewConversation } from "@/components/NewConversation";
import { OlderConversations } from "@/components/OlderConversations";
import { MessageSearchResults } from "@/components/MessageSearchResults";
import { ReflectionPanel } from "@/components/ReflectionPanel";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useMedia } from "@/lib/useMedia";
import { Trame } from "@/api";
import { MessageText } from "@/components/MessageText";
import { QuickSwitcher } from "@/components/QuickSwitcher";
import { isFavoriteKey, isSwitcherKey, isTyping, overlayOpen, takeSwitcherRequest } from "@/lib/shortcuts";
import { DraftItem, MessageHit, WatchEntity } from "@/types";
import type { BriefTarget } from "@/components/BriefSheet";

const BriefSheet = lazy(() => import("@/components/BriefSheet").then((m) => ({ default: m.BriefSheet })));
const BRIEF_WIDTH = 420;

type GroupId = "favorites" | "review" | "followUp" | "unread" | "followed" | "others" | "archived";
const GROUPS: { id: GroupId; label: string }[] = [
  { id: "favorites", label: "Favoris" },
  { id: "review", label: "À relire" },
  { id: "followUp", label: "À relancer" },
  { id: "unread", label: "Non lus" },
  { id: "followed", label: "Suivies" },
  { id: "others", label: "Autres" },
  { id: "archived", label: "Archivées" },
];
const KIND = { dm: "Conversation privée", group: "Groupe", channel: "Canal" } as const;

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const byRecent = (a: WatchEntity, b: WatchEntity) =>
  (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
  a.displayName.replace(/^#/, "").localeCompare(b.displayName.replace(/^#/, ""), "fr", { sensitivity: "base" });

/** Discussions : barre latérale regroupée par statut, discussion choisie à droite. */
export function Inbox({ trame, onBrief }: { trame: Trame; onBrief: (t: BriefTarget) => void }) {
  const { watchlist, drafts, followUps, favorites, archived } = trame.state;
  const favIndex = useMemo(() => new Map(favorites.map((t, i) => [t, i])), [favorites]);
  const isFavorite = (threadId: string) => favIndex.has(threadId);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // Message trouvé par la recherche : la discussion s'ouvre dessus.
  const [found, setFound] = useState<MessageHit | null>(null);
  const select = (threadId: string, hit: MessageHit | null = null) => {
    setSelected(threadId);
    setFound(hit);
  };
  const [collapsed, setCollapsed] = useState<Record<GroupId, boolean>>({ favorites: false, review: false, followUp: false, unread: false, followed: false, others: true, archived: true });
  const [catching, setCatching] = useState(false);
  // Panneau ancré à droite : le résumé, ou la réflexion du modèle pendant une action.
  const [dock, setDock] = useState<"brief" | "reflection" | null>(null);
  const [starting, setStarting] = useState(false);
  const [browsingOlder, setBrowsingOlder] = useState(false);
  // Fenêtre assez large pour le panneau de résumé à côté de la discussion.
  const wide = useMedia("(min-width: 1024px)");

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
  // Archivée : seulement dans « Archivées », jusqu'au prochain message reçu (le moteur la ramène).
  const groupOf = (c: WatchEntity): GroupId =>
    c.threadId in archived
      ? "archived"
      : favIndex.has(c.threadId)
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
    const out: Record<GroupId, WatchEntity[]> = { favorites: [], review: [], followUp: [], unread: [], followed: [], others: [], archived: [] };
    for (const c of items) out[groupOf(c)].push(c);
    for (const g of Object.values(out)) g.sort(byRecent);
    // Les favoris gardent l'ordre choisi par l'utilisateur, pas l'activité.
    out.favorites.sort((a, b) => (favIndex.get(a.threadId) ?? 0) - (favIndex.get(b.threadId) ?? 0));
    return out;
  }, [items, draftOf, followUpOf, favIndex, archived]);

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
      archived: keep(grouped.archived),
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

  // ── Glisser-déposer entre sections ─────────────────────────────────────
  /**
   * Range une conversation dans Favoris (à une place donnée), Suivies ou Autres, avec les
   * mêmes actions que l'étoile et l'interrupteur « Suivie ». Un toast propose d'annuler.
   */
  const moveTo = async (c: WatchEntity, target: DropTarget, index?: number) => {
    const id = c.threadId;
    const prevFavs = [...favorites];
    const wasFav = prevFavs.includes(id);
    const prevWatch = c.watch;
    const fail = (r: { ok: boolean; error?: string }) => {
      if (!r.ok) toast.error("Déplacement impossible", { description: r.error });
      return !r.ok;
    };
    if (target === "archived") return archive(c, true);
    // Ranger une conversation archivée ailleurs la sort d'abord des archives.
    if (id in archived && fail(await trame.setArchived(id, false))) return;
    if (target === "favorites") {
      const order = prevFavs.filter((t) => t !== id);
      const at = index === undefined ? order.length : Math.max(0, Math.min(index, order.length));
      order.splice(at, 0, id);
      if (wasFav) {
        if (order.join("\n") !== prevFavs.join("\n") && fail(await trame.reorderFavorites(order))) return;
        return;
      }
      if (fail(await trame.toggleFavorite(id))) return;
      if (at < order.length - 1 && fail(await trame.reorderFavorites(order))) return;
      setCollapsed((st) => ({ ...st, favorites: false }));
    } else {
      const watch = target === "followed";
      if (!wasFav && prevWatch === watch && !(id in archived)) {
        toast.info(watch ? `${c.displayName} est déjà suivie` : `${c.displayName} n'est déjà plus suivie`);
        return;
      }
      if (wasFav && fail(await trame.toggleFavorite(id))) return;
      if (prevWatch !== watch && fail(await trame.setWatchMany([id], watch))) return;
      setCollapsed((st) => ({ ...st, [target]: false }));
    }
    // Annuler défait exactement ce qui vient d'être fait, avec les mêmes actions.
    const undo = async () => {
      if (c.threadId in archived) await trame.setArchived(id, true);
      if (target === "favorites") return void (await trame.toggleFavorite(id));
      if (wasFav) {
        await trame.toggleFavorite(id);
        await trame.reorderFavorites(prevFavs);
      }
      if (prevWatch !== (target === "followed")) await trame.setWatchMany([id], prevWatch);
    };
    const stays = draftOf.has(id) ? "À relire" : followUpOf.has(id) ? "À relancer" : c.unread ? "Non lus" : null;
    const text =
      target === "favorites" ? `${c.displayName} ajoutée aux favoris` : target === "followed" ? `${c.displayName} suivie` : `${c.displayName} n'est plus suivie`;
    toast.success(text, {
      description: target !== "favorites" && stays ? `Elle reste dans « ${stays} » tant que c'est le cas.` : undefined,
      action: { label: "Annuler", onClick: () => void undo() },
    });
  };

  /** Archiver (ou désarchiver) : la conversation quitte les sections, rien n'est supprimé. */
  const archive = async (c: WatchEntity, on: boolean) => {
    const res = await trame.setArchived(c.threadId, on);
    if (!res.ok) return void toast.error(on ? "Archivage impossible" : "Désarchivage impossible", { description: res.error });
    if (!on) return void toast.success(`${c.displayName} désarchivée`);
    if (c.threadId === selected) setSelected(null);
    toast.success(`${c.displayName} archivée`, {
      description: "Elle revient d'elle-même au prochain message reçu.",
      action: { label: "Annuler", onClick: () => void trame.setArchived(c.threadId, false) },
    });
  };
  const markRead = async (c: WatchEntity) => {
    const res = await trame.markRead(c.threadId);
    if (!res.ok) toast.error("Impossible de marquer comme lu", { description: res.error });
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragging, setDragging] = useState<WatchEntity | null>(null);
  const [overGroup, setOverGroup] = useState<GroupId | null>(null);
  // Place d'insertion dans Favoris (avant le favori d'indice n), pendant le survol.
  const [insertAt, setInsertAt] = useState<number | null>(null);
  // Le clic qui termine un glisser-déposer n'ouvre pas la conversation.
  const dragged = useRef(false);

  // Position réelle du pointeur pendant le glisser (voir livePointer).
  useEffect(() => {
    if (!dragging) return;
    const track = (e: PointerEvent) => (livePointer = { x: e.clientX, y: e.clientY });
    window.addEventListener("pointermove", track, true);
    return () => {
      window.removeEventListener("pointermove", track, true);
      livePointer = null;
    };
  }, [dragging]);

  const onDragStart = (e: DragStartEvent) => {
    dragged.current = true;
    const start = e.activatorEvent as PointerEvent;
    livePointer = { x: start.clientX, y: start.clientY };
    setDragging(items.find((c) => c.threadId === e.active.id) ?? null);
  };
  const onDragMove = (e: DragMoveEvent) => {
    const over = e.over;
    const group = (over?.data.current?.group as GroupId | undefined) ?? null;
    setOverGroup(group);
    if (group !== "favorites" || !over) return setInsertAt(null);
    const favId = over.data.current?.favId as string | undefined;
    if (!favId) return setInsertAt(grouped.favorites.length);
    const y = livePointer?.y ?? (e.activatorEvent as PointerEvent).clientY + e.delta.y;
    const i = grouped.favorites.findIndex((c) => c.threadId === favId);
    const rect = document.querySelector(`[data-drop="fav:${CSS.escape(favId)}"]`)?.getBoundingClientRect();
    if (!rect) return setInsertAt(null);
    setInsertAt(y < rect.top + rect.height / 2 ? i : i + 1);
  };
  const endDrag = () => {
    setDragging(null);
    setOverGroup(null);
    setInsertAt(null);
    requestAnimationFrame(() => (dragged.current = false));
  };
  const onDragEnd = (e: DragEndEvent) => {
    const c = dragging;
    const group = overGroup;
    const at = insertAt;
    endDrag();
    if (!c || !group || !e.over || !isDropTarget(group)) return;
    if (group === "favorites") {
      // L'indice compte la conversation déplacée elle-même : on la retire avant d'insérer.
      const from = favorites.indexOf(c.threadId);
      const index = at === null ? undefined : from >= 0 && from < at ? at - 1 : at;
      if (from >= 0 && index === from) return;
      return void moveTo(c, "favorites", index);
    }
    if (group === groupOf(c)) return;
    void moveTo(c, group);
  };

  /** Une ligne de la liste : la conversation, son étoile au survol et son menu contextuel. */
  const row = (c: WatchEntity) => {
    const fav = isFavorite(c.threadId);
    const at = favorites.indexOf(c.threadId);
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <DraggableRow id={c.threadId} name={c.displayName} group={groupOf(c)} favId={fav && !query ? c.threadId : undefined}>
            <SidebarItem
              c={c}
              draft={draftOf.get(c.threadId) ?? null}
              followUp={followUpOf.get(c.threadId)?.question ?? null}
              active={c.threadId === current?.threadId}
              onClick={() => !dragged.current && select(c.threadId)}
            />
            <RowMenuButton name={c.displayName} />
            <FavoriteStar favorite={fav} name={c.displayName} onToggle={() => toggleFavorite(c)} />
          </DraggableRow>
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
          {/* L'équivalent clavier du glisser-déposer : ranger la conversation ailleurs. */}
          <ContextMenuSeparator />
          {fav ? (
            <>
              <ContextMenuItem onSelect={() => void moveTo(c, "followed")}>
                <MessagesSquare />
                Déplacer vers Suivies
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void moveTo(c, "others")}>
                <EyeOff />
                Déplacer vers Autres (ne plus suivre)
              </ContextMenuItem>
            </>
          ) : c.watch ? (
            <ContextMenuItem onSelect={() => void moveTo(c, "others")}>
              <EyeOff />
              Ne plus suivre
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={() => void moveTo(c, "followed")}>
              <MessagesSquare />
              Suivre
            </ContextMenuItem>
          )}
          {c.unread && (
            <ContextMenuItem onSelect={() => void markRead(c)}>
              <CheckCheck />
              Marquer comme lu
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          {c.threadId in archived ? (
            <ContextMenuItem onSelect={() => void archive(c, false)}>
              <ArchiveRestore />
              Désarchiver
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={() => void archive(c, true)}>
              <Archive />
              Archiver
            </ContextMenuItem>
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
      <aside ref={sidebar} className="flex w-64 shrink-0 flex-col border-r lg:w-72 3xl:w-80">
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-9 rounded-full" aria-label="Anciennes conversations" onClick={() => setBrowsingOlder(true)}>
                <Clock className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Anciennes conversations</TooltipContent>
          </Tooltip>
          <OlderConversations
            trame={trame}
            open={browsingOlder}
            onOpenChange={setBrowsingOlder}
            onOpened={(threadId) => {
              setQuery("");
              setCollapsed({ favorites: false, review: false, followUp: false, unread: false, followed: false, others: false, archived: false });
              setSelected(threadId);
            }}
          />
          <NewConversation
            trame={trame}
            open={starting}
            onOpenChange={setStarting}
            onOpened={(threadId) => {
              // La conversation peut tomber dans un groupe replié (« Autres ») : on l'ouvre.
              setQuery("");
              setCollapsed({ favorites: false, review: false, followUp: false, unread: false, followed: false, others: false, archived: false });
              setSelected(threadId);
            }}
          />
        </div>
        {trame.connected && trame.state.readiness.page === "waiting" && (
          // Teams se charge dans sa fenêtre : rien n'est en erreur, les actions attendent leur tour.
          <p role="status" className="mx-3 mb-2 flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
            Teams se connecte… les nouveaux messages et les envois arrivent dans un instant.
          </p>
        )}
        <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
          <DndContext
            sensors={sensors}
            collisionDetection={innermost}
            onDragStart={onDragStart}
            onDragMove={onDragMove}
            // onDragMove part avant que dnd-kit ne change de cible : onDragOver donne la cible à jour.
            onDragOver={onDragMove}
            onDragEnd={onDragEnd}
            onDragCancel={endDrag}
            accessibility={{ announcements, screenReaderInstructions: { draggable: "" } }}
          >
          <nav aria-label="Discussions" onKeyDown={onListKey} className="flex flex-col px-2 pb-3">
            {GROUPS.map((g) => {
              const list = groups[g.id];
              // Pendant un glisser, Favoris, Suivies et Autres s'affichent même vides : on peut y déposer.
              const empty = list.length === 0;
              if (empty && !(dragging && isDropTarget(g.id) && !query)) return null;
              const closed = collapsed[g.id] && !query;
              const state = !dragging ? "idle" : overGroup !== g.id ? (isDropTarget(g.id) ? "target" : "idle") : isDropTarget(g.id) ? "over" : "refused";
              return (
                <DropSection key={g.id} group={g.id} state={state} label={g.label}>
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
                        {empty ? (
                          <p className="mx-2 mb-1 rounded-xl border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">Déposer ici</p>
                        ) : (
                          <ul className="flex flex-col" aria-label={g.id === "favorites" ? "Favoris, dans l'ordre choisi" : undefined}>
                            {list.map((c, i) => (
                              <li key={c.threadId} className="relative [content-visibility:auto] [contain-intrinsic-size:auto_56px]">
                                {g.id === "favorites" && insertAt === i && <InsertLine edge="top" />}
                                {row(c)}
                                {g.id === "favorites" && insertAt === list.length && i === list.length - 1 && <InsertLine edge="bottom" />}
                              </li>
                            ))}
                          </ul>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </DropSection>
              );
            })}
            {all.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">{query ? "Aucune discussion à ce nom." : "Aucune discussion."}</p>
            )}
            <MessageSearchResults trame={trame} query={query} onOpen={(h) => h.threadId && select(h.threadId, h)} />
          </nav>
          <DragOverlay dropAnimation={null}>
            {dragging && <DragPreview c={dragging} group={overGroup} />}
          </DragOverlay>
          </DndContext>
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
                : "Glisse des discussions dans Suivies pour que Trame prépare tes réponses."}
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
  const markers = rowMarkers(c, draft, followUp);
  const descId = useId();
  // Au clavier, la ligne ouvre l'infobulle de ses repères, comme le survol.
  const [keyboard, setKeyboard] = useState(false);
  return (
    <>
    <button
      ref={ref}
      type="button"
      data-conv={c.threadId}
      onClick={onClick}
      onFocus={(e) => setKeyboard(e.currentTarget.matches(":focus-visible"))}
      onBlur={() => setKeyboard(false)}
      aria-current={active ? "true" : undefined}
      aria-describedby={markers.length ? descId : undefined}
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
          {markers.length > 0 && <RowMarkers markers={markers} forceOpen={keyboard} />}
        </span>
      </span>
    </button>
    {markers.length > 0 && (
      <span id={descId} hidden>
        {markers.map((m) => m.tip).join(". ")}
      </span>
    )}
    </>
  );
}

type Marker = { id: "auto" | "draft" | "followUp" | "unread"; tip: string };

/**
 * Repères d'une ligne, dans un ordre fixe : le mode Auto (un réglage, en neutre), puis au plus
 * un état qui attend quelque chose de toi (orange : réponse à relire, relance) ou non lu (bleu).
 */
function rowMarkers(c: WatchEntity, draft: DraftItem | null, followUp: string | null): Marker[] {
  const out: Marker[] = [];
  if (c.watch && c.mode === "auto") out.push({ id: "auto", tip: AUTO_HINT });
  if (draft) out.push({ id: "draft", tip: "Réponse à relire : ouvre la conversation pour l'envoyer ou la modifier" });
  else if (followUp) out.push({ id: "followUp", tip: "Relance proposée : ta question est restée sans réponse" });
  else if (c.unread) out.push({ id: "unread", tip: "Non lu" });
  return out;
}

function RowMarkers({ markers, forceOpen }: { markers: Marker[]; forceOpen: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <Tooltip open={forceOpen || hover} onOpenChange={setHover}>
      <TooltipTrigger asChild>
        <span aria-hidden className="flex shrink-0 items-center gap-1.5">
          {markers.map((m) =>
            m.id === "auto" ? (
              <Bot key={m.id} className="size-3.5 text-muted-foreground" />
            ) : m.id === "draft" ? (
              <PenLine key={m.id} className="size-3.5 text-warning" />
            ) : m.id === "followUp" ? (
              <BellRing key={m.id} className="size-3.5 text-warning" />
            ) : (
              <span key={m.id} className="size-2 rounded-full bg-link" />
            )
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="flex max-w-64 flex-col items-start gap-0.5">
        {markers.map((m) => (
          <span key={m.id}>{m.tip}</span>
        ))}
      </TooltipContent>
    </Tooltip>
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


// ── Glisser-déposer ─────────────────────────────────────────────────────────

type DropTarget = "favorites" | "followed" | "others" | "archived";
/** Seules ces sections reçoivent une conversation : les autres suivent un état calculé par Trame. */
const isDropTarget = (g: GroupId | null): g is DropTarget => g === "favorites" || g === "followed" || g === "others" || g === "archived";
const REFUSED: Partial<Record<GroupId, string>> = {
  review: "« À relire » suit les réponses que Trame prépare",
  followUp: "« À relancer » suit les questions restées sans réponse",
  unread: "« Non lus » suit les messages que tu n'as pas lus",
};

/**
 * Position du pointeur à l'écran pendant un glisser. Les coordonnées de dnd-kit ajoutent
 * le défilement de la liste : une fois la liste défilée, elles visent une autre section.
 */
let livePointer: { x: number; y: number } | null = null;

/**
 * Cible sous le pointeur, lue dans la page telle qu'elle est : les sections vides qui paraissent
 * au début du glisser (et s'animent) décalent les autres, et les mesures de dnd-kit prises au
 * départ ne le voient pas. Le favori survolé l'emporte sur sa section (ligne d'insertion).
 */
const innermost: CollisionDetection = ({ pointerCoordinates, droppableContainers }) => {
  const at = livePointer ?? pointerCoordinates;
  if (!at) return [];
  const live = new Set(droppableContainers.filter((d) => !d.disabled).map((d) => String(d.id)));
  const hits = document
    .elementsFromPoint(at.x, at.y)
    .map((el) => (el as HTMLElement).dataset?.drop)
    .filter((id): id is string => !!id && live.has(id));
  return [...new Set(hits)]
    .sort((a, b) => Number(b.startsWith("fav:")) - Number(a.startsWith("fav:")))
    .map((id) => ({ id }));
};

const nameOf = (data: unknown) => (data as { name?: string } | undefined)?.name ?? "la conversation";
const announcements = {
  onDragStart: ({ active }: { active: { data: { current?: unknown } } }) => `${nameOf(active.data.current)} saisie.`,
  onDragOver: ({ over }: { over: { data: { current?: unknown } } | null }) => {
    const g = (over?.data.current as { group?: GroupId } | undefined)?.group;
    if (!g) return undefined;
    const label = GROUPS.find((x) => x.id === g)?.label;
    return isDropTarget(g) ? `Au-dessus de ${label}.` : `${label} : dépôt impossible.`;
  },
  onDragEnd: () => undefined,
  onDragCancel: () => "Déplacement annulé.",
};

/** Ligne déplaçable à la souris (au-delà de 6 px, pour qu'un clic reste un clic) ; au clavier, le menu contextuel. */
function DraggableRow({
  id,
  name,
  group,
  favId,
  children,
  ref,
  onPointerDown,
  ...rest
}: { id: string; name: string; group: GroupId; favId?: string; children: React.ReactNode } & React.ComponentProps<"div">) {
  const drag = useDraggable({ id, data: { group, name } });
  // Un favori est aussi une cible : il place la ligne d'insertion avant ou après lui.
  const drop = useDroppable({ id: `fav:${id}`, data: { group: "favorites", favId }, disabled: !favId });
  return (
    <div
      {...rest}
      data-drop={favId ? `fav:${id}` : undefined}
      ref={(node) => {
        drag.setNodeRef(node);
        drop.setNodeRef(node);
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      // Le menu contextuel (appui long au toucher) et le glisser écoutent tous deux le pointeur.
      onPointerDown={(e) => {
        onPointerDown?.(e);
        drag.listeners?.onPointerDown?.(e);
      }}
      className={cn("group/row relative touch-none", drag.isDragging && "opacity-40", rest.className)}
    >
      {children}
    </div>
  );
}

/** Section de la liste : cible de dépôt (Favoris, Suivies, Autres) ou refus visible (états calculés). */
function DropSection({ group, state, label, children }: { group: GroupId; state: "idle" | "target" | "over" | "refused"; label: string; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: `group:${group}`, data: { group } });
  return (
    <section
      ref={setNodeRef}
      data-drop={`group:${group}`}
      aria-label={label}
      className={cn(
        // Sections jointives (marge intérieure, pas d'espace entre elles) : aucun trou où le dépôt se perdrait.
        "relative -mx-1 rounded-2xl px-1 py-1.5 transition-colors duration-150",
        state === "target" && "bg-accent/30",
        state === "over" && "bg-primary/10 ring-1 ring-primary/40",
        state === "refused" && "bg-muted/60 opacity-60"
      )}
    >
      {children}
    </section>
  );
}

function InsertLine({ edge }: { edge: "top" | "bottom" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute right-2 left-2 z-10 h-0.5 rounded-full bg-primary",
        // Dans la ligne : content-visibility rogne tout ce qui dépasse.
        edge === "top" ? "top-0" : "bottom-0"
      )}
    />
  );
}

/** Aperçu sous le pointeur : la conversation, et ce que le dépôt va faire (ou pourquoi il est refusé). */
function DragPreview({ c, group }: { c: WatchEntity; group: GroupId | null }) {
  const hint =
    group === "favorites"
      ? "Favoris"
      : group === "followed"
        ? "Suivre"
        : group === "others"
          ? "Ne plus suivre"
          : group === "archived"
            ? "Archiver"
            : group
              ? REFUSED[group]
              : null;
  const refused = group !== null && !isDropTarget(group);
  return (
    <div className="flex w-72 cursor-grabbing items-center gap-3 rounded-xl border bg-popover px-2 py-2 shadow-lg">
      <InitialsAvatar name={c.displayName} className="size-8" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{c.displayName}</span>
        {hint && <span className={cn("text-xs", refused ? "line-clamp-2 text-muted-foreground" : "truncate text-link")}>{refused ? `Pas ici : ${hint}` : hint}</span>}
      </span>
    </div>
  );
}

/**
 * « … » au survol d'une ligne : ouvre le même menu que le clic droit, là où est le bouton.
 * Hors de l'ordre de tabulation comme l'étoile : au clavier, touche Menu ou Maj+F10.
 */
function RowMenuButton({ name }: { name: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Actions pour ${name}`}
          aria-haspopup="menu"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            e.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left, clientY: r.bottom + 2 }));
          }}
          className="absolute top-1.5 right-8 grid size-6 place-items-center rounded-full bg-background/90 text-muted-foreground opacity-0 shadow-xs transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 hover:text-foreground focus-visible:opacity-100"
        >
          <EllipsisVertical className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Actions · Maj+F10</TooltipContent>
    </Tooltip>
  );
}

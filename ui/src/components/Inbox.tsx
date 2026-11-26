import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, History, Inbox as InboxIcon, Loader2, Search, SquarePen, Timer, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InitialsAvatar, spring } from "@/components/kit";
import { DiscussionView } from "@/components/DiscussionView";
import { NewConversation } from "@/components/NewConversation";
import { MessageSearchResults } from "@/components/MessageSearchResults";
import { ReflectionPanel } from "@/components/ReflectionPanel";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { Trame } from "@/api";
import { DraftItem, MessageHit, WatchEntity } from "@/types";
import type { BriefTarget } from "@/components/BriefSheet";

const BriefSheet = lazy(() => import("@/components/BriefSheet").then((m) => ({ default: m.BriefSheet })));
const BRIEF_WIDTH = 420;

type GroupId = "review" | "unread" | "followed" | "others";
const GROUPS: { id: GroupId; label: string }[] = [
  { id: "review", label: "À relire" },
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
  const { watchlist, drafts } = trame.state;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // Message trouvé par la recherche : la discussion s'ouvre dessus.
  const [found, setFound] = useState<MessageHit | null>(null);
  const select = (threadId: string, hit: MessageHit | null = null) => {
    setSelected(threadId);
    setFound(hit);
  };
  const [collapsed, setCollapsed] = useState<Record<GroupId, boolean>>({ review: false, unread: false, followed: false, others: true });
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

  const items = useMemo<WatchEntity[]>(() => {
    const known = new Set(watchlist.map((w) => w.threadId));
    return [
      ...watchlist,
      ...[...draftOf.values()]
        .filter((d) => !known.has(d.threadId))
        .map((d) => ({ threadId: d.threadId, displayName: d.from, surface: d.surface, watch: true, mode: d.mode, namedPeople: [] })),
    ];
  }, [watchlist, draftOf]);

  const groups = useMemo(() => {
    const out: Record<GroupId, WatchEntity[]> = { review: [], unread: [], followed: [], others: [] };
    for (const c of items.filter((c) => !query || norm(c.displayName).includes(norm(query)))) {
      const id: GroupId = draftOf.has(c.threadId) ? "review" : c.unread ? "unread" : c.watch ? "followed" : "others";
      out[id].push(c);
    }
    for (const g of Object.values(out)) g.sort(byRecent);
    return out;
  }, [items, query, draftOf]);

  const all = [...groups.review, ...groups.unread, ...groups.followed, ...groups.others];
  // From every conversation, not the filtered ones: searching must not close the
  // open discussion and lose a reply being written.
  const current = items.find((c) => c.threadId === selected) ?? null;

  // Première ouverture : la première réponse à relire, sinon rien de choisi.
  useEffect(() => {
    if (!selected && groups.review[0]) select(groups.review[0].threadId);
  }, [groups.review.length]);

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
      <aside className="flex w-72 shrink-0 flex-col border-r">
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
              setCollapsed({ review: false, unread: false, followed: false, others: false });
              setSelected(threadId);
            }}
          />
        </div>
        <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
          <nav aria-label="Discussions" className="flex flex-col gap-3 px-2 pb-3">
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
                      <motion.ul
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="flex flex-col overflow-hidden"
                      >
                        {list.map((c) => (
                          <li key={c.threadId} className="[content-visibility:auto] [contain-intrinsic-size:auto_56px]">
                            <SidebarItem c={c} draft={draftOf.get(c.threadId) ?? null} active={c.threadId === current?.threadId} onClick={() => select(c.threadId)} />
                          </li>
                        ))}
                      </motion.ul>
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

      <main className="min-w-0 flex-1">
        {current ? (
          <DiscussionView
            key={current.threadId}
            trame={trame}
            conversation={current}
            draft={draftOf.get(current.threadId) ?? null}
            found={found?.threadId === current.threadId ? found : null}
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

function SidebarItem({ c, draft, active, onClick }: { c: WatchEntity; draft: DraftItem | null; active: boolean; onClick: () => void }) {
  const preview = draft ? draft.incoming : c.namedPeople.length ? `réagit à ${c.namedPeople.join(", ")}` : KIND[c.surface];
  return (
    <button
      type="button"
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
          <span className={cn("min-w-0 flex-1 truncate text-sm", (c.unread || draft) && "font-semibold", !c.watch && !draft && !c.unread && "text-muted-foreground")}>
            {c.displayName}
          </span>
          {c.lastActivity && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{c.lastActivity}</span>}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{preview}</span>
          {c.watch && c.mode === "auto" && <Timer className="size-3 shrink-0 text-warning" aria-label="Envoi auto" />}
          {draft ? (
            <span className="size-2 shrink-0 rounded-full bg-warning" aria-label="Réponse à relire" />
          ) : c.unread ? (
            <span className="size-2 shrink-0 rounded-full bg-link" aria-label="Non lu" />
          ) : null}
        </span>
      </span>
    </button>
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

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Search, Users } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InitialsAvatar } from "@/components/kit";
import { cn } from "@/lib/utils";
import { Trame } from "@/api";
import { WatchEntity } from "@/types";

const DEBOUNCE_MS = 250;

/** « Anciennes conversations » : celles que Teams connaît et que la liste ne montre pas, de la
 *  plus récente à la plus ancienne, filtrées par nom. Rien n'est ouvert dans Teams ; une
 *  conversation ne rejoint la liste (non suivie) que quand on la choisit. */
export function OlderConversations({
  trame,
  open,
  onOpenChange,
  onOpened,
}: {
  trame: Trame;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** La conversation est dans la liste : la sélectionner. */
  onOpened: (threadId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<WatchEntity[]>([]);
  const [total, setTotal] = useState(0);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = async (q: string, offset: number) => {
    const mine = ++seq.current;
    setLoading(true);
    const res = await trame.olderConversations(q, offset);
    if (mine !== seq.current) return;
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setSupported(res.supported);
    setTotal(res.total);
    setItems((prev) => (offset ? [...prev, ...res.conversations] : res.conversations));
  };

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setItems([]);
    setOpening(null);
    void load("", 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void load(query.trim(), 0), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const choose = async (c: WatchEntity) => {
    if (opening) return;
    setOpening(c.threadId);
    const res = await trame.openOlder(c.threadId);
    setOpening(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onOpened(res.conversation.threadId);
    onOpenChange(false);
    toast.success(`${res.conversation.displayName} est dans la liste`, { description: "Non suivie : tu peux la lire et y répondre." });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !opening && onOpenChange(o)}>
      <DialogContent className="flex max-h-[min(40rem,calc(100dvh-4rem))] flex-col gap-0 p-0 sm:max-w-md">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>Anciennes conversations</DialogTitle>
          <DialogDescription>Celles que Teams garde et que la liste ne montre pas, des plus récentes aux plus anciennes.</DialogDescription>
        </DialogHeader>
        <div className="px-5 pb-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Nom d'une personne ou d'un groupe"
              aria-label="Filtrer les anciennes conversations"
              className="h-10 rounded-full pl-9"
            />
          </div>
        </div>
        {!supported && (
          <p className="mx-5 mb-3 flex gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm" role="status">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>Le pilote Teams actuel ne sait pas lister les anciennes conversations.</span>
          </p>
        )}
        {error && (
          <p className="mx-5 mb-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" role="alert">
            {error}
          </p>
        )}
        <ul role="listbox" aria-label="Anciennes conversations" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {items.map((c) => (
            <li key={c.threadId} role="option" aria-selected={false}>
              <button
                type="button"
                onClick={() => void choose(c)}
                disabled={Boolean(opening)}
                className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-accent disabled:opacity-60")}
              >
                {opening === c.threadId ? (
                  <span className="grid size-8 place-items-center">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  </span>
                ) : c.surface === "dm" ? (
                  <InitialsAvatar name={c.displayName} className="size-8" />
                ) : (
                  <span className="grid size-8 place-items-center rounded-full bg-secondary text-muted-foreground">
                    <Users className="size-4" />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{c.displayName}</span>
                {c.lastActivity && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{c.lastActivity}</span>}
              </button>
            </li>
          ))}
          {loading && (
            <li className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Lecture de la liste de Teams…
            </li>
          )}
          {!loading && supported && !error && items.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              {query.trim() ? `Aucune ancienne conversation ne correspond à « ${query.trim()} ».` : "Toutes tes conversations sont déjà dans la liste."}
            </li>
          )}
          {!loading && items.length < total && (
            <li className="px-3 pt-2">
              <Button variant="ghost" className="w-full rounded-full" onClick={() => void load(query.trim(), items.length)}>
                Afficher plus ({total - items.length} restantes)
              </Button>
            </li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

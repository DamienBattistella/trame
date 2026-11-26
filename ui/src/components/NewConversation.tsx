import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Search, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InitialsAvatar } from "@/components/kit";
import { cn } from "@/lib/utils";
import { Trame } from "@/api";
import { PeopleSearch, PersonSuggestion } from "@/types";

const DEBOUNCE_MS = 200;

/** « Nouvelle conversation » : chercher quelqu'un par son nom (entourage, puis Teams quand le
 *  pilote le permet) et ouvrir la conversation privée avec lui, même s'il n'est pas encore dans
 *  la liste. Rien n'est écrit dans Teams : la conversation est seulement ouverte. */
export function NewConversation({
  trame,
  open,
  onOpenChange,
  onOpened,
}: {
  trame: Trame;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** La conversation est prête : la sélectionner dans la liste. */
  onOpened: (threadId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<PeopleSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResult(null);
    setError(null);
    setStarting(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const mine = ++seq.current;
    if (!q) {
      setSearching(false);
      setResult((r) => (r ? { ...r, people: [] } : r));
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      const res = await trame.searchPeople(q);
      if (mine !== seq.current) return;
      setSearching(false);
      setActive(0);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setResult(res);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, open]);

  const people = query.trim() ? result?.people ?? [] : [];
  const canStart = result?.canStart ?? true;
  // Pilote sans recherche de personnes : Teams résout lui-même le nom tapé.
  const askTeams = query.trim().length >= 3 && canStart && result !== null && !result.teamsSearch && !searching;
  const choices: (PersonSuggestion | "teams")[] = [...people, ...(askTeams ? (["teams"] as const) : [])];

  const choose = async (name: string, threadId: string | null) => {
    if (starting) return;
    if (threadId) {
      onOpened(threadId);
      onOpenChange(false);
      return;
    }
    setStarting(name);
    setError(null);
    const res = await trame.startConversation(name);
    setStarting(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onOpened(res.conversation.threadId);
    onOpenChange(false);
    toast.success(`Conversation avec ${res.conversation.displayName} ouverte`, {
      description: "Elle est dans la liste, non suivie. Tu peux y écrire comme dans les autres.",
    });
  };

  const pick = (c: PersonSuggestion | "teams" | undefined) => {
    if (!c) return;
    if (c === "teams") void choose(query.trim(), null);
    else if (c.threadId || canStart) void choose(c.name, c.threadId);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, choices.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(choices[active]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !starting && onOpenChange(o)}>
      <DialogContent className="flex max-h-[min(36rem,calc(100dvh-4rem))] flex-col gap-0 p-0 sm:max-w-md">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>Nouvelle conversation</DialogTitle>
          <DialogDescription>Cherche une personne par son nom : la conversation privée s'ouvre dans Teams.</DialogDescription>
        </DialogHeader>
        <div className="px-5 pb-3">
          <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            disabled={Boolean(starting)}
            placeholder="Nom, rôle ou équipe"
            aria-label="Chercher une personne"
            role="combobox"
            aria-expanded={choices.length > 0}
            aria-controls="new-conversation-results"
            className="h-10 rounded-full pl-9"
          />
          </div>
        </div>

        {result && !canStart && (
          <p className="mx-5 mb-3 flex gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm" role="status">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              Nouvelle conversation impossible : {result.unsupported ?? "le pilote Teams ne le permet pas"}. Écris-lui une première fois dans
              Teams, la conversation apparaîtra ici.
            </span>
          </p>
        )}
        {error && (
          <p className="mx-5 mb-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" role="alert">
            {error}
          </p>
        )}

        <ul id="new-conversation-results" role="listbox" aria-label="Personnes" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {choices.map((c, i) =>
            c === "teams" ? (
              <li key="teams" role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(c)}
                  disabled={Boolean(starting)}
                  className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left", i === active && "bg-accent")}
                >
                  <span className="grid size-8 place-items-center rounded-full bg-secondary text-muted-foreground">
                    {starting === query.trim() ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">Chercher « {query.trim()} » dans Teams</span>
                    <span className="truncate text-xs text-muted-foreground">Hors entourage : Teams doit trouver une seule personne de ce nom</span>
                  </span>
                </button>
              </li>
            ) : (
              <li key={c.name} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(c)}
                  disabled={Boolean(starting) || (!c.threadId && !canStart)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left disabled:opacity-60",
                    i === active && "bg-accent"
                  )}
                >
                  {starting === c.name ? (
                    <span className="grid size-8 place-items-center">
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    </span>
                  ) : (
                    <InitialsAvatar name={c.name} className="size-8" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{c.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {starting === c.name
                        ? "Ouverture dans Teams…"
                        : [c.role, c.team, c.manager && `rattaché à ${c.manager}`].filter(Boolean).join(" · ") ||
                          (c.source === "teams" ? "Trouvé dans Teams" : "Entourage")}
                    </span>
                  </span>
                  {c.threadId ? (
                    <span className="shrink-0 text-xs text-muted-foreground">Dans la liste</span>
                  ) : (
                    c.source === "teams" && <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">Teams</span>
                  )}
                </button>
              </li>
            )
          )}
          {query.trim() && !searching && result && choices.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">Personne ne correspond à « {query.trim()} ».</li>
          )}
          {searching && people.length === 0 && (
            <li className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Recherche…
            </li>
          )}
          {!query.trim() && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              Tape un nom, un rôle ou une équipe de ton entourage.
            </li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

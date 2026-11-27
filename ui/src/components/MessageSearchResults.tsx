import { useEffect, useRef, useState } from "react";
import { History, Loader2, MessageSquareText, Search } from "lucide-react";
import { Trame } from "@/api";
import { MessageText } from "@/components/MessageText";
import type { TextLink } from "@/lib/linkify";
import { fold } from "@/lib/textSearch";
import { cn } from "@/lib/utils";
import { MessageHit, SearchScope } from "@/types";

const DEBOUNCE_MS = 250;

/** Extrait avec la plage [début, fin) surlignée ; liens raccourcis, pas cliquables (la ligne entière l'est). */
export function Highlight({ text, range, links }: { text: string; range: [number, number] | null; links?: TextLink[] }) {
  return <MessageText text={text} range={range} links={links} interactive={false} />;
}

function since(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? `aujourd'hui à ${time}`
    : `le ${d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })} à ${time}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

function Heading({ icon: Icon, label, count }: { icon: React.ElementType; label: string; count: number | null }) {
  return (
    <div className="flex w-full items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground">
      <Icon className="size-3.5" />
      {label}
      <span className="ml-auto tabular-nums">
        {count ?? <Loader2 className="size-3 animate-spin" aria-label="Recherche en cours" />}
      </span>
    </div>
  );
}

function HitRow({ h, onOpen }: { h: MessageHit; onOpen: (hit: MessageHit) => void }) {
  const lost = h.threadId === null;
  return (
    <li>
      <button
        type="button"
        disabled={lost}
        title={lost ? "Conversation que Trame ne retrouve pas dans sa liste : ouvre-la dans Teams." : undefined}
        onClick={() => onOpen(h)}
        className={cn(
          "flex w-full flex-col gap-0.5 rounded-xl px-2 py-2 text-left transition-colors",
          lost ? "cursor-default opacity-70" : "hover:bg-accent/60"
        )}
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{h.conversation}</span>
          {h.at && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{h.at}</span>}
        </span>
        <span className="line-clamp-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">{h.mine ? "Toi" : h.sender} : </span>
          <Highlight text={h.excerpt} range={h.match} links={h.links} />
        </span>
      </button>
    </li>
  );
}

type TeamsSearch =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; results: MessageHit[]; scope: "recent" | "teams" }
  | { status: "error"; error: string };

/** Recherche dans le contenu des messages : d'abord ce que Trame a déjà lu ; puis, à la
 *  demande, les conversations récentes de Teams (service de chat, rien d'ouvert) ; puis, à la
 *  demande encore, la recherche de Teams sur tout l'historique (par la fenêtre Teams). */
export function MessageSearchResults({ trame, query, onOpen }: { trame: Trame; query: string; onOpen: (hit: MessageHit) => void }) {
  const [results, setResults] = useState<MessageHit[] | null>(null);
  const [scope, setScope] = useState<SearchScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamsSearch>({ status: "idle" });
  const [history, setHistory] = useState<TeamsSearch>({ status: "idle" });
  const q = query.trim();
  const live = useRef(q);
  live.current = q;
  const tooShort = fold(q).length < 2;

  useEffect(() => {
    setResults(null);
    setError(null);
    setTeams({ status: "idle" });
    setHistory({ status: "idle" });
    if (tooShort) return;
    let current = true;
    const timer = setTimeout(async () => {
      const res = await trame.searchMessages(q);
      if (!current) return;
      if (!res.ok) return setError(res.error);
      setResults(res.results);
      setScope(res.scope);
    }, DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [q]);

  const run = async (deep: boolean) => {
    const asked = q;
    const set = deep ? setHistory : setTeams;
    set({ status: "loading" });
    const res = await trame.searchTeams(asked, deep);
    if (live.current !== asked) return;
    set(res.ok ? { status: "done", results: res.results, scope: res.scope } : { status: "error", error: res.error });
  };

  if (tooShort) return null;

  // Un message n'est montré qu'une fois : déjà lu, puis récent, puis historique.
  const key = (h: MessageHit) => `${h.threadId}|${fold(h.text)}`;
  const known = new Set((results ?? []).map(key));
  const fresh = teams.status === "done" ? teams.results.filter((h) => !known.has(key(h))) : [];
  for (const h of fresh) known.add(key(h));
  const older = history.status === "done" ? history.results.filter((h) => !known.has(key(h))) : [];
  // Le service manquait : la première étape a déjà été la recherche de Teams.
  const firstWasTeams = teams.status === "done" && teams.scope === "teams";
  const WINDOW = "Recherche dans Teams… quelques secondes, dans la fenêtre Teams de Trame.";

  const block = (state: TeamsSearch, items: MessageHit[], label: string, loading: string, none: string, prefix: string) =>
    state.status === "idle" ? null : (
      <div className="mt-2 flex flex-col gap-1">
        <Heading icon={History} label={label} count={state.status === "loading" ? null : items.length} />
        {state.status === "loading" && <p className="px-3 py-1 text-xs text-muted-foreground">{loading}</p>}
        {state.status === "error" && <p className="px-3 py-1 text-xs text-muted-foreground">{state.error}</p>}
        {state.status === "done" && (
          <ul className="flex flex-col">
            {items.map((h, i) => (
              <HitRow key={`${prefix}-${i}`} h={h} onOpen={onOpen} />
            ))}
            {items.length === 0 && (
              <li className="px-3 py-1 text-xs text-muted-foreground">{state.results.length ? "Rien de plus que les messages déjà montrés." : none}</li>
            )}
          </ul>
        )}
      </div>
    );
  const button = (label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="mx-2 mt-2 flex items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium text-link transition-colors hover:bg-accent/60"
    >
      <Search className="size-3.5" /> {label}
    </button>
  );
  const hint =
    teams.status === "idle"
      ? "D'abord les derniers messages de tes conversations récentes, sans rien ouvrir dans Teams."
      : teams.status === "done" && !firstWasTeams && history.status === "idle"
        ? "Cherché dans les derniers messages des conversations récentes. Tout l'historique passe par la recherche de Teams : sa fenêtre s'ouvre quelques secondes, puis rouvre la conversation affichée."
        : "Recherche de Teams : tout l'historique que Teams garde, ses premiers résultats seulement (25 au plus).";

  return (
    <section aria-label="Messages trouvés" className="flex flex-col gap-1">
      <Heading icon={MessageSquareText} label="Dans les messages" count={results ? results.length : null} />
      {error ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{error}</p>
      ) : (
        results && (
          <ul className="flex flex-col">
            {results.map((h, i) => (
              <HitRow key={`${h.threadId}-${i}`} h={h} onOpen={onOpen} />
            ))}
            {results.length === 0 && (
              <li className="px-3 py-2 text-xs text-muted-foreground">Aucun message lu ne contient « {q} ».</li>
            )}
          </ul>
        )
      )}
      {scope && (
        <p className="px-3 pt-1 text-xs text-muted-foreground">
          Cherché dans les {plural(scope.messages, "message")} déjà lu{scope.messages > 1 ? "s" : ""} par Trame
          {" "}({plural(scope.conversations, "discussion")}) depuis son démarrage {since(scope.since)}.
        </p>
      )}

      {teams.status === "idle"
        ? button("Chercher aussi dans Teams", () => run(false))
        : block(
            teams,
            fresh,
            firstWasTeams ? "Dans Teams, tout l'historique" : "Dans Teams, conversations récentes",
            firstWasTeams ? WINDOW : "Recherche dans les conversations récentes…",
            firstWasTeams ? `Teams ne trouve aucun message contenant « ${q} ».` : `Aucun message récent ne contient « ${q} ».`,
            "teams",
          )}
      {teams.status === "done" && !firstWasTeams && history.status === "idle" && button("Chercher dans tout l'historique de Teams", () => run(true))}
      {block(history, older, "Dans Teams, tout l'historique", WINDOW, `Teams ne trouve aucun message contenant « ${q} ».`, "history")}
      <p className="px-3 pt-1 text-xs text-muted-foreground">{hint}</p>
    </section>
  );
}

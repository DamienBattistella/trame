import { useEffect, useRef, useState } from "react";
import { History, Loader2, MessageSquareText, Search } from "lucide-react";
import { Trame } from "@/api";
import { fold } from "@/lib/textSearch";
import { cn } from "@/lib/utils";
import { MessageHit, SearchScope } from "@/types";

const DEBOUNCE_MS = 250;

/** Texte avec la plage [début, fin) surlignée. */
export function Highlight({ text, range }: { text: string; range: [number, number] | null }) {
  if (!range) return <>{text}</>;
  const [s, e] = range;
  return (
    <>
      {text.slice(0, s)}
      <mark className="rounded-sm bg-warning/30 px-0.5 text-foreground">{text.slice(s, e)}</mark>
      {text.slice(e)}
    </>
  );
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
          <Highlight text={h.excerpt} range={h.match} />
        </span>
      </button>
    </li>
  );
}

type TeamsSearch = { status: "idle" } | { status: "loading" } | { status: "done"; results: MessageHit[] } | { status: "error"; error: string };

/** Recherche dans le contenu des messages : d'abord ce que Trame a déjà lu, puis, à la
 *  demande, la recherche de Teams pour les messages plus anciens. */
export function MessageSearchResults({ trame, query, onOpen }: { trame: Trame; query: string; onOpen: (hit: MessageHit) => void }) {
  const [results, setResults] = useState<MessageHit[] | null>(null);
  const [scope, setScope] = useState<SearchScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamsSearch>({ status: "idle" });
  const q = query.trim();
  const live = useRef(q);
  live.current = q;
  const tooShort = fold(q).length < 2;

  useEffect(() => {
    setResults(null);
    setError(null);
    setTeams({ status: "idle" });
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

  const searchTeams = async () => {
    const asked = q;
    setTeams({ status: "loading" });
    const res = await trame.searchTeams(asked);
    if (live.current !== asked) return;
    setTeams(res.ok ? { status: "done", results: res.results } : { status: "error", error: res.error });
  };

  if (tooShort) return null;

  // Un message que Trame a déjà lu n'est montré qu'une fois.
  const known = new Set((results ?? []).map((h) => `${h.threadId}|${fold(h.text)}`));
  const older = teams.status === "done" ? teams.results.filter((h) => !known.has(`${h.threadId}|${fold(h.text)}`)) : [];

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

      {teams.status === "idle" ? (
        <button
          type="button"
          onClick={searchTeams}
          className="mx-2 mt-2 flex items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium text-link transition-colors hover:bg-accent/60"
        >
          <Search className="size-3.5" /> Chercher aussi dans Teams
        </button>
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          <Heading icon={History} label="Dans Teams, plus anciens" count={teams.status === "loading" ? null : older.length} />
          {teams.status === "loading" && (
            <p className="px-3 py-1 text-xs text-muted-foreground">Recherche dans Teams… quelques secondes, dans la fenêtre Teams de Trame.</p>
          )}
          {teams.status === "error" && <p className="px-3 py-1 text-xs text-muted-foreground">{teams.error}</p>}
          {teams.status === "done" && (
            <ul className="flex flex-col">
              {older.map((h, i) => (
                <HitRow key={`teams-${i}`} h={h} onOpen={onOpen} />
              ))}
              {older.length === 0 && (
                <li className="px-3 py-1 text-xs text-muted-foreground">
                  {teams.results.length ? "Rien de plus que les messages déjà lus." : `Teams ne trouve aucun message contenant « ${q} ».`}
                </li>
              )}
            </ul>
          )}
        </div>
      )}
      <p className="px-3 pt-1 text-xs text-muted-foreground">
        {teams.status === "idle"
          ? "La recherche de Teams couvre tout l'historique que Teams garde. Elle passe par la fenêtre Teams de Trame quelques secondes, puis y rouvre la conversation affichée."
          : "Recherche de Teams : tout l'historique que Teams garde, ses premiers résultats seulement (25 au plus)."}
      </p>
    </section>
  );
}

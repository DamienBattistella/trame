import { useEffect, useState } from "react";
import { Loader2, MessageSquareText } from "lucide-react";
import { Trame } from "@/api";
import { fold } from "@/lib/textSearch";
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

/** Recherche dans le contenu des messages déjà lus par Trame, sous la liste des discussions. */
export function MessageSearchResults({ trame, query, onOpen }: { trame: Trame; query: string; onOpen: (hit: MessageHit) => void }) {
  const [results, setResults] = useState<MessageHit[] | null>(null);
  const [scope, setScope] = useState<SearchScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = query.trim();
  const tooShort = fold(q).length < 2;

  useEffect(() => {
    setResults(null);
    setError(null);
    if (tooShort) return;
    let live = true;
    const timer = setTimeout(async () => {
      const res = await trame.searchMessages(q);
      if (!live) return;
      if (!res.ok) return setError(res.error);
      setResults(res.results);
      setScope(res.scope);
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);

  if (tooShort) return null;

  return (
    <section aria-label="Messages trouvés">
      <div className="flex w-full items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground">
        <MessageSquareText className="size-3.5" />
        Dans les messages
        <span className="ml-auto tabular-nums">
          {results ? results.length : <Loader2 className="size-3 animate-spin" aria-label="Recherche en cours" />}
        </span>
      </div>
      {error ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{error}</p>
      ) : (
        results && (
          <ul className="flex flex-col">
            {results.map((h, i) => (
              <li key={`${h.threadId}-${i}`}>
                <button
                  type="button"
                  onClick={() => onOpen(h)}
                  className="flex w-full flex-col gap-0.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-accent/60"
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
            ))}
            {results.length === 0 && (
              <li className="px-3 py-2 text-xs text-muted-foreground">Aucun message lu ne contient « {q} ».</li>
            )}
          </ul>
        )
      )}
      {scope && (
        <p className="px-3 pt-2 text-xs text-muted-foreground">
          Cherché dans les {scope.messages} message{scope.messages > 1 ? "s" : ""} déjà lu{scope.messages > 1 ? "s" : ""} par Trame
          {" "}({scope.conversations} discussion{scope.conversations > 1 ? "s" : ""}) depuis son démarrage {since(scope.since)}.
          Les autres n'y sont pas : ouvrir une discussion en fait lire les 30 derniers messages.
        </p>
      )}
    </section>
  );
}

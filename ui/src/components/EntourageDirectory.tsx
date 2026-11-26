import { useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GroupList, InitialsAvatar } from "@/components/kit";
import { cn } from "@/lib/utils";
import { Person } from "@/types";

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Le ton le plus répandu est le ton par défaut de l'export : un ton différent a été écrit pour la personne. */
export function entourageStats(people: Person[]) {
  const tones = new Map<string, number>();
  for (const p of people) if (p.tone) tones.set(p.tone, (tones.get(p.tone) ?? 0) + 1);
  const [defaultTone, shared] = [...tones.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const common = shared > 1 ? defaultTone : null;
  return {
    defaultTone: common,
    teams: new Set(people.map((p) => p.team).filter(Boolean)).size,
    personalTone: people.filter((p) => p.tone && p.tone !== common).length,
    notes: people.filter((p) => p.note).length,
    personal: people.some((p) => p.tone || p.note),
    managed: people.filter((p) => p.manager).length,
    managers: new Set(people.map((p) => p.manager).filter(Boolean)).size,
  };
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-secondary px-3 py-2.5">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** Réglages › Entourage : ce que contient le fichier, et ce que Trame dit de chacun au cerveau. */
export function EntourageDirectory({ people }: { people: Person[] }) {
  const [query, setQuery] = useState("");
  const [facetValue, setFacetValue] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const stats = useMemo(() => entourageStats(people), [people]);
  // Filtre par relation si l'export en donne, sinon par équipe (organigramme livré avec Trame).
  const facet: "relation" | "team" = people.some((p) => p.relation) ? "relation" : "team";
  const facets = useMemo(() => {
    const count = new Map<string, number>();
    for (const p of people) {
      const v = p[facet];
      if (v) count.set(v, (count.get(v) ?? 0) + 1);
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1]);
  }, [people, facet]);
  const shown = useMemo(() => {
    const q = fold(query.trim());
    return people
      .filter((p) => !facetValue || p[facet] === facetValue)
      .filter((p) => !q || [p.name, p.role, p.team, p.manager, ...p.aliases].some((v) => v && fold(v).includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }, [people, query, facet, facetValue]);

  const filtered = Boolean(query.trim() || facetValue);
  const reset = () => {
    setQuery("");
    setFacetValue("");
  };

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Personnes" value={people.length} />
        <Tile label="Équipes" value={stats.teams} />
        {stats.personal ? (
          <>
            <Tile label="Ton personnalisé" value={stats.personalTone} />
            <Tile label="Avec une note" value={stats.notes} />
          </>
        ) : (
          <>
            <Tile label="Responsables" value={stats.managers} />
            <Tile label="Avec un responsable" value={stats.managed} />
          </>
        )}
      </div>

      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nom, rôle, équipe ou responsable"
            aria-label="Chercher une personne"
            className="rounded-full pl-9"
          />
        </div>
        <select
          value={facetValue}
          onChange={(e) => setFacetValue(e.target.value)}
          aria-label={facet === "relation" ? "Filtrer par relation" : "Filtrer par équipe"}
          className="h-9 max-w-[45%] rounded-full border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
        >
          <option value="">{facet === "relation" ? "Toutes les relations" : "Toutes les équipes"}</option>
          {facets.map(([name, n]) => (
            <option key={name} value={name}>
              {name} ({n})
            </option>
          ))}
        </select>
      </div>

      {shown.length === 0 ? (
        <GroupList>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm text-muted-foreground">Personne ne correspond à cette recherche.</span>
            <Button size="sm" variant="outline" className="rounded-full" onClick={reset}>
              Tout afficher
            </Button>
          </div>
        </GroupList>
      ) : (
        <GroupList className="max-h-[26rem] overflow-y-auto">
          {shown.map((p) => {
            const expanded = open === p.name;
            const label = [p.role, p.team].filter(Boolean).join(" · ");
            return (
              <div key={p.name}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : p.name)}
                  className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
                >
                  <InitialsAvatar name={p.name} className="size-8" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{p.name}</span>
                    {label && <span className="truncate text-xs text-muted-foreground">{label}</span>}
                  </span>
                  {p.relation && <Badge variant="secondary">{p.relation}</Badge>}
                  <ChevronRight
                    className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", expanded && "rotate-90")}
                    aria-hidden
                  />
                </button>
                {expanded && (
                  <dl className="flex flex-col gap-2 bg-secondary/40 py-3 pr-4 pl-15">
                    <Detail label={p.tone && p.tone !== stats.defaultTone ? "Ton, écrit pour cette personne" : "Ton, celui par défaut"}>
                      {p.tone ?? "Aucun ton indiqué : Trame garde ta voix habituelle."}
                    </Detail>
                    {p.manager && <Detail label="Rattaché à">{p.manager}</Detail>}
                    {p.note && <Detail label="Note">{p.note}</Detail>}
                    {p.aliases.length > 0 && <Detail label="Aussi connu comme">{p.aliases.join(", ")}</Detail>}
                  </dl>
                )}
              </div>
            );
          })}
        </GroupList>
      )}

      <p className="ml-1 text-xs text-muted-foreground">
        {filtered ? `${plural(shown.length, "personne", "personnes")} sur ${people.length}. ` : ""}
        Trame transmet cette fiche au cerveau quand la personne t'écrit, pour qu'il réponde sur le bon ton.
      </p>
    </div>
  );
}

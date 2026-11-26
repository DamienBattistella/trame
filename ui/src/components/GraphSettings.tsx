import { useEffect, useState } from "react";
import { LogIn, LogOut, Network } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GroupList } from "@/components/kit";
import { GraphStatus, Trame } from "@/api";

/** Libellés des actions suivies par le moteur (docs/teams-graph.md). */
const ACTIONS: Record<string, string> = {
  list: "Liste des conversations",
  presence: "Présence des autres",
  read: "Lecture d'une conversation",
  my_status: "Mon statut",
  search_people: "Recherche de personnes",
  search_messages: "Recherche dans les messages",
  mark_read: "Marquer comme lu",
  react: "Réactions",
  delete: "Supprimer mon message",
  set_status: "Changer mon statut",
  set_note: "Message de statut",
  send: "Envoi de messages",
  start_chat: "Nouvelle conversation",
};

/** Réglages › Général › Microsoft Graph : la voie supportée, une fois Trame enregistré par la DSI. */
export function GraphSettings({ trame }: { trame: Trame }) {
  const [graph, setGraph] = useState<GraphStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [tenantId, setTenantId] = useState("");

  useEffect(() => {
    let live = true;
    const tick = async () => {
      const res = await trame.graphStatus();
      if (!live || !res.ok) return;
      setGraph((prev) => {
        if (!prev) {
          setClientId(res.graph.client_id);
          setTenantId(res.graph.tenant_id);
        }
        return res.graph;
      });
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [trame.connected]);

  const apply = async (call: Promise<{ ok: boolean; error?: string; graph?: GraphStatus } & Record<string, unknown>>) => {
    const res = await call;
    if (res.ok && res.graph) setGraph(res.graph);
    else toast.error(res.error ?? "Microsoft Graph : action impossible");
  };

  const dirty = graph !== null && (clientId.trim() !== graph.client_id || tenantId.trim() !== graph.tenant_id);
  const line = !graph
    ? "Vérification…"
    : graph.signed_in
      ? `Connecté${graph.account ? ` · ${graph.account}` : ""}`
      : graph.pending
        ? "Connexion en cours dans ton navigateur…"
        : graph.configured
          ? "Application renseignée : connecte-toi pour l'utiliser."
          : "Pas encore enregistré par la DSI : tout passe par la page Teams.";
  const routes = Object.entries(graph?.routes ?? {}).filter(([k]) => ACTIONS[k]);

  return (
    <GroupList>
      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
          <Network className="size-4" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span>Microsoft Graph</span>
          <span className="truncate text-xs text-muted-foreground">{graph?.error ?? line}</span>
        </div>
        {graph?.configured &&
          (graph.signed_in ? (
            <Button variant="ghost" size="sm" className="rounded-full" onClick={() => apply(trame.graphLogout())}>
              <LogOut className="size-4" /> Se déconnecter
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="rounded-full" disabled={graph.pending} onClick={() => apply(trame.graphLogin())}>
              <LogIn className="size-4" /> Se connecter
            </Button>
          ))}
      </div>
      <form
        className="flex flex-wrap items-end gap-2 border-t px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          apply(trame.graphConfigure(clientId, tenantId));
        }}
      >
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
          ID de l'application
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="00000000-0000-…" spellCheck={false} />
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
          ID du tenant
          <Input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="00000000-0000-…" spellCheck={false} />
        </label>
        <Button type="submit" size="sm" variant="secondary" className="rounded-full" disabled={!dirty}>
          Enregistrer
        </Button>
      </form>
      {routes.length > 0 && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t px-4 py-3 text-xs">
          {routes.map(([key, r]) => (
            <div key={key} className="contents" title={r.reason ?? undefined}>
              <dt className="text-muted-foreground">{ACTIONS[key]}</dt>
              <dd className={r.via === "graph" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
                {r.via === "graph" ? "Graph" : "Page Teams"}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="border-t px-4 py-2.5 text-xs text-muted-foreground">
        Voie supportée par Microsoft, avec ta propre connexion et des droits délégués. Tant que Graph n'est pas connecté
        ou refuse une action, Trame passe par la page Teams comme avant.
      </div>
    </GroupList>
  );
}

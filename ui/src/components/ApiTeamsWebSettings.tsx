import { useEffect, useState } from "react";
import { Network } from "lucide-react";
import { GroupList } from "@/components/kit";
import { TeamsApiStatus, Trame } from "@/api";

/** Libellés des actions suivies, dans l'ordre d'affichage. */
const ACTIONS: Record<string, string> = {
  list: "Liste des conversations",
  read: "Lecture d'une conversation",
  watch: "Nouveaux messages",
  unread: "Rattrapage des non-lus",
  presence: "Présence des autres",
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
  meetings: "Réunions",
  transcript: "Transcriptions",
};

/** Réglages › Général › API Teams web : la session Teams déjà authentifiée, utilisée pour
 *  signer des appels API DANS la page (le jeton ne la quitte jamais). Remplace Microsoft Graph. */
export function ApiTeamsWebSettings({ trame }: { trame: Trame }) {
  const [api, setApi] = useState<TeamsApiStatus | null>(null);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      const res = await trame.teamsApiStatus();
      if (live && res.ok) setApi(res.api);
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [trame.connected]);

  const sign = api?.signing ?? null;
  const line = !api
    ? "Vérification…"
    : sign == null
      ? "Signature non encore mesurée (ouvre une conversation dans Teams)."
      : sign.ok
        ? "Signature des appels API vérifiée · le jeton reste dans la page."
        : sign.error
          ? `Signature indisponible : ${sign.error}`
          : `Signature refusée (HTTP ${sign.status ?? "?"}) : repli sur la page Teams.`;
  const tone = sign?.ok ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground";
  const routes = Object.entries(api?.routes ?? {}).filter(([k]) => ACTIONS[k]);

  return (
    <GroupList>
      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
          <Network className="size-4" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span>API Teams web</span>
          <span className={`truncate text-xs ${tone}`}>{line}</span>
        </div>
      </div>
      {routes.length > 0 && (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t px-4 py-3 text-xs">
          {routes.map(([key, r]) => (
            <div key={key} className="contents" title={r.reason ?? undefined}>
              <dt className="text-muted-foreground">{ACTIONS[key]}</dt>
              <dd className={r.via === "api" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
                {r.via === "api" ? "API page" : "Page Teams"}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="border-t px-4 py-2.5 text-xs text-muted-foreground">
        Trame utilise ta session Teams web déjà connectée : les appels API se font dans la page, signés
        avec son auth (le jeton ne sort jamais de la page). Aujourd'hui, lectures et écritures passent par
        la page ; les messages arrivent par le canal temps réel de Teams.
      </div>
    </GroupList>
  );
}

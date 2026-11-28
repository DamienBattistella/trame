import { useEffect, useState } from "react";
import { Network } from "lucide-react";
import { GroupList } from "@/components/kit";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiRoute, TeamsApiStatus, Trame } from "@/api";
import { cn } from "@/lib/utils";

/** Actions suivies, regroupées par nature et dans l'ordre d'affichage. */
const GROUPS: { label: string; actions: Record<string, string> }[] = [
  {
    label: "Lecture",
    actions: {
      list: "Conversations",
      read: "Lecture",
      watch: "Nouveaux messages",
      unread: "Non-lus",
      presence: "Présence",
      my_status: "Mon statut",
      search_people: "Personnes",
      search_messages: "Recherche",
      meetings: "Réunions",
      transcript: "Transcriptions",
    },
  },
  {
    label: "Écriture",
    actions: {
      send: "Envoi",
      start_chat: "Nouvelle conversation",
      hide: "Masquer dans Teams",
      react: "Réactions",
      mark_read: "Marquer comme lu",
      delete: "Suppression",
      edit: "Modification",
      set_status: "Changer mon statut",
      set_note: "Message de statut",
    },
  },
];

/** Câblée sur l'API mais pas encore servie depuis le démarrage : rien n'est prouvé. */
const untried = (route: ApiRoute) => route.via === "api" && route.tried === false;

function RouteChip({ label, route }: { label: string; route: ApiRoute }) {
  const api = route.via === "api";
  const wait = untried(route);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs",
            wait
              ? "border-dashed border-success/50 text-foreground"
              : api
                ? "border-success/40 bg-success/10 text-foreground"
                : "text-muted-foreground",
          )}
        >
          <span
            className={cn("size-1.5 rounded-full", wait ? "border border-success" : api ? "bg-success" : "bg-muted-foreground/40")}
            aria-hidden
          />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {route.reason || (api ? "Appel API signé dans la page" : "Via l'interface de la page Teams")}
        {route.at ? ` · ${route.at}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

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
      ? "Signature non mesurée : ouvre une conversation dans Teams."
      : sign.ok
        ? "Signature vérifiée · le jeton reste dans la page"
        : sign.error
          ? `Signature indisponible : ${sign.error}`
          : `Signature refusée (HTTP ${sign.status ?? "?"}) : repli sur la page`;
  const dot = !api || sign == null ? "bg-muted-foreground/40" : sign.ok ? "bg-success" : "bg-warning";
  // Session du service de chat (là où Teams lit et écrit les messages), ouverte dans la page.
  const chat = api?.chatsvc ?? null;
  const chatLine = !api || chat == null
    ? null
    : chat.ok
      ? `Service de chat connecté${chat.region ? ` (${chat.region})` : ""}`
      : chat.stage === "bearer"
        ? "Service de chat : en attente d'un jeton Teams"
        : `Service de chat indisponible${chat.status ? ` (HTTP ${chat.status})` : ""} : repli sur la page`;
  const chatDot = chat?.ok ? "bg-success" : "bg-warning";

  const routes = api?.routes ?? {};
  const groups = GROUPS.map((g) => ({
    label: g.label,
    items: Object.entries(g.actions).flatMap(([key, label]) => (routes[key] ? [{ key, label, route: routes[key] }] : [])),
  })).filter((g) => g.items.length > 0);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const viaApi = groups.reduce((n, g) => n + g.items.filter((i) => i.route.via === "api").length, 0);
  const waiting = groups.reduce((n, g) => n + g.items.filter((i) => untried(i.route)).length, 0);

  return (
    <GroupList>
      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
          <Network className="size-4" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span>API Teams web</span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-hidden />
            <span className="truncate">{line}</span>
          </span>
          {chatLine && (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn("size-1.5 shrink-0 rounded-full", chatDot)} aria-hidden />
              <span className="truncate">{chatLine}</span>
            </span>
          )}
        </div>
        {total > 0 && (
          <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            <span className={cn("text-sm font-medium", viaApi > 0 ? "text-foreground" : "text-muted-foreground")}>{viaApi}</span>
            /{total} via l'API
            {waiting > 0 && <span className="block">dont {waiting} pas encore essayée{waiting > 1 ? "s" : ""}</span>}
          </span>
        )}
      </div>
      {total > 0 && (
        <div className="flex flex-col gap-3 border-t px-4 py-3">
          {groups.map((g) => (
            <div key={g.label} className="flex flex-col gap-1.5">
              <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{g.label}</span>
              <div className="flex flex-wrap gap-1.5">
                {g.items.map((i) => (
                  <RouteChip key={i.key} label={i.label} route={i.route} />
                ))}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-success" aria-hidden /> API signée dans la page
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full border border-success" aria-hidden /> Câblée, pas encore essayée
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-muted-foreground/40" aria-hidden /> Interface de la page
            </span>
          </div>
        </div>
      )}
      <div className="border-t px-4 py-2.5 text-xs text-muted-foreground">
        Trame s'appuie sur ta session Teams web déjà connectée : les appels sont signés dans la page et le jeton
        n'en sort jamais. Les messages se lisent sur le service de chat de Teams, avec sa propre session ouverte dans la page.
      </div>
    </GroupList>
  );
}

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { GroupList } from "@/components/kit";
import { TeamsLogo } from "@/brands";
import { isDesktop, teamsWebHide, teamsWebOpen, teamsWebVisible } from "@/desktop";
import { Trame } from "@/api";
import { TeamsCheckRow } from "@/components/TeamsCheck";

type Status = { enabled: boolean; relay?: boolean; ready?: boolean; title?: string; error?: string };

/** Réglages › Général › Teams : la session Teams web de Trame (lecture et envoi). */
export function TeamsWebSettings({ trame }: { trame: Trame }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      const res = await trame.teamsWebStatus();
      if (live && res.ok) setStatus(res.status);
      // La fenêtre se masque aussi par sa croix : l'interrupteur suit l'état réel.
      if (isDesktop()) {
        const visible = await teamsWebVisible();
        if (live) setShown(visible);
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [trame.connected]);

  const toggle = async (show: boolean) => {
    setShown(show);
    if (show) await teamsWebOpen(true);
    else await teamsWebHide();
    setShown(await teamsWebVisible());
  };

  const line = !status
    ? "Vérification…"
    : !status.relay
      ? "Ouverture de la fenêtre Teams de Trame…"
      : status.ready
        ? `Connecté${status.title ? ` · ${status.title}` : ""}`
        : "Connexion requise : affiche Teams et connecte-toi.";

  return (
    <GroupList>
      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
          <TeamsLogo className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span>Teams</span>
          <span className="truncate text-xs text-muted-foreground">{line}</span>
        </div>
        {isDesktop() && (
          <label className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
            Afficher la fenêtre
            <Switch aria-label="Afficher la fenêtre Teams" checked={shown} onCheckedChange={toggle} />
          </label>
        )}
      </div>
      <div className="border-t">
        <TeamsCheckRow trame={trame} />
      </div>
      <div className="border-t px-4 py-2.5 text-xs text-muted-foreground">
        Trame lit et écrit dans sa propre fenêtre Teams, cachée. C'est une session de plus sur ton compte : ouvrir une
        conversation peut la marquer comme lue. L'envoi reste toujours ton clic ou le mode Auto.
      </div>
    </GroupList>
  );
}

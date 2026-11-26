import { Video } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { openExternal } from "@/desktop";
import { meetingUrl } from "@/lib/meeting";
import type { MeetingLink } from "@/types";

/** « Rejoindre dans Teams » d'une conversation de réunion. Trame ne gère ni appels ni
 *  réunions : le bouton ouvre le lien de la réunion, ce qui lance l'application Teams
 *  (ou le navigateur). Mis en avant quand la réunion est en cours. */
export function JoinMeeting({ meeting }: { meeting: MeetingLink | null | undefined }) {
  const url = meetingUrl(meeting?.url);
  if (!url) return null;
  const live = meeting?.live === true;
  const join = () =>
    openExternal(url).catch((e) => toast.error("Ouverture de la réunion impossible", { description: String(e) }));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="sm" variant={live ? "default" : "outline"} className="shrink-0 rounded-full" onClick={join}>
          {live ? (
            <span className="relative flex size-2" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-current" />
            </span>
          ) : (
            <Video className="size-4" aria-hidden />
          )}
          Rejoindre dans Teams
          {live && <span className="sr-only"> (réunion en cours)</span>}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{live ? "Réunion en cours : l'ouvrir dans Teams" : "Ouvrir la réunion dans Teams"}</TooltipContent>
    </Tooltip>
  );
}

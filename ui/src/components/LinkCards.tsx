import { Link2 } from "lucide-react";
import { GithubLogo, JiraLogo } from "@/brands";
import { openExternal } from "@/desktop";
import { cardView, type CardKind } from "@/lib/linkCards";
import { cn } from "@/lib/utils";
import type { LinkCard } from "@/types";

const ICON: Record<CardKind, React.ComponentType<{ className?: string }>> = {
  jira: JiraLogo,
  github: GithubLogo,
  gitlab: Link2,
  web: Link2,
};

/** Cartes d'aperçu sous un message (Jira, GitHub, un site), en petit : source, titre qui ouvre
 *  l'adresse dans le navigateur du système, un ou deux champs. Jamais les boutons de Teams. */
export function LinkCards({ cards, interactive = true }: { cards?: LinkCard[]; interactive?: boolean }) {
  if (!cards?.length) return null;
  return (
    <div className="flex flex-col gap-1.5 whitespace-normal">
      {cards.map((card, i) => {
        const v = cardView(card);
        const Icon = ICON[v.kind];
        const open = (e: React.MouseEvent) => {
          e.preventDefault();
          if (v.url) void openExternal(v.url);
        };
        return (
          <div key={i} className="flex min-w-0 items-start gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 py-1.5 text-xs">
            <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-col">
              {v.url && interactive ? (
                <a
                  href={v.url}
                  title={`${v.source}\n${v.title}\n${v.url}`}
                  onClick={open}
                  onAuxClick={open}
                  className="truncate font-medium text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
                >
                  {v.title}
                </a>
              ) : (
                <span className={cn("truncate font-medium", v.url && "text-link")}>{v.title}</span>
              )}
              <span className="truncate text-muted-foreground">
                {v.source}
                {v.detail && ` · ${v.detail}`}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

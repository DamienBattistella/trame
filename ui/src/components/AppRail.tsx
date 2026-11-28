import { AnimatePresence, motion } from "motion/react";
import { CalendarDays, Captions, MessagesSquare, Pause, Play, ScrollText, Settings } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { OwnStatus } from "@/components/OwnStatus";
import { UpdateLed } from "@/components/UpdateLed";
import { spring } from "@/components/kit";
import type { Trame } from "@/api";
import type { PanelTab } from "@/panel/Panel";
import { cn } from "@/lib/utils";

const SECTIONS: { id: Exclude<PanelTab, "settings">; label: string; icon: React.ElementType; key: string }[] = [
  { id: "inbox", label: "Discussions", icon: MessagesSquare, key: "1" },
  { id: "meetings", label: "Réunions", icon: Captions, key: "2" },
  { id: "calendar", label: "Calendrier", icon: CalendarDays, key: "3" },
  { id: "logs", label: "Journal", icon: ScrollText, key: "4" },
];

const iconButton =
  "relative grid size-10 place-items-center rounded-xl text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60";

/** Infobulle du rail : à droite, avec le raccourci en touches. */
function Tip({ label, keys, children }: { label: React.ReactNode; keys?: string[]; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-2">
        {label}
        {keys && (
          <span className="flex items-center gap-0.5">
            {keys.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Navigation principale, toujours à gauche, sur tous les écrans. En haut les sections
 * (icône et libellé, libellé en infobulle sous 1024 px) ; en bas, comme la zone de profil
 * de Teams ou Slack, ce qui règle l'application : mise à jour, pause, Réglages et
 * ton statut Teams. Les sections portent aria-current, jamais un rôle d'onglet.
 */
export function AppRail({
  trame,
  tab,
  onTab,
  onTogglePause,
}: {
  trame: Trame;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onTogglePause: (paused: boolean) => void;
}) {
  const drafts = trame.state.drafts.length;
  const paused = trame.state.paused;
  return (
    <nav aria-label="Navigation principale" className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2 lg:w-[4.5rem]">
      <ul className="flex w-full flex-col items-center gap-1 px-1.5">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          const active = tab === s.id;
          const count = s.id === "inbox" ? drafts : 0;
          return (
            <li key={s.id} className="w-full">
              <Tip label={s.label} keys={["Ctrl", s.key]}>
                <button
                  type="button"
                  data-nav={s.id}
                  aria-current={active ? "page" : undefined}
                  aria-label={count ? `${s.label}, ${count} réponse${count > 1 ? "s" : ""} à relire` : s.label}
                  onClick={() => onTab(s.id)}
                  className={cn(
                    "group relative flex h-11 w-full flex-col items-center justify-center gap-1 rounded-xl outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 lg:h-14",
                    active ? "text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  {active && <motion.span layoutId="rail-active" transition={spring} className="absolute inset-0 rounded-xl bg-secondary" />}
                  <span className="relative">
                    <Icon className={cn("size-5 transition-colors", active && "text-link")} strokeWidth={active ? 2.25 : 1.75} />
                    <AnimatePresence initial={false}>
                      {count > 0 && (
                        <motion.span
                          key="count"
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          exit={{ scale: 0 }}
                          transition={spring}
                          aria-hidden
                          className="absolute -top-1.5 -right-2.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-3xs font-semibold tabular-nums text-primary-foreground ring-2 ring-sidebar"
                        >
                          {count > 99 ? "99+" : count}
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </span>
                  <span aria-hidden className={cn("relative hidden text-2xs leading-none lg:block", active && "font-medium")}>
                    {s.label}
                  </span>
                </button>
              </Tip>
            </li>
          );
        })}
      </ul>

      <div className="flex-1" />

      <div className="flex w-full flex-col items-center gap-1 px-1.5">
        <UpdateLed side="right" />
        {/* Interrupteur global : vert quand Trame lit Teams, orange en pause (le bandeau du panneau le redit). */}
        <Tip label={paused ? "Trame est en pause : reprendre" : "Trame est actif : mettre en pause"}>
          <button
            type="button"
            role="switch"
            aria-checked={!paused}
            aria-label="Trame actif"
            onClick={() => onTogglePause(!paused)}
            className={cn(
              iconButton,
              "lg:flex lg:h-14 lg:w-full lg:flex-col lg:items-center lg:justify-center lg:gap-1",
              paused && "bg-warning/15 text-warning hover:bg-warning/25 hover:text-warning"
            )}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={paused ? "p" : "a"}
                initial={{ scale: 0, rotate: -90 }}
                animate={{ scale: 1, rotate: 0 }}
                exit={{ scale: 0, rotate: 90 }}
                transition={{ type: "spring", stiffness: 500, damping: 25 }}
              >
                {paused ? <Pause className="size-4" /> : <Play className="size-4 text-success" />}
              </motion.span>
            </AnimatePresence>
            {/* Un état, pas une commande de lecture : dès qu'il y a la place, il s'écrit. */}
            <span aria-hidden className={cn("hidden text-2xs leading-none lg:block", paused && "font-medium")}>
              {paused ? "En pause" : "Actif"}
            </span>
          </button>
        </Tip>
        <Tip label="Réglages" keys={["Ctrl", ","]}>
          <button
            type="button"
            data-nav="settings"
            aria-current={tab === "settings" ? "page" : undefined}
            aria-label="Réglages"
            onClick={() => onTab("settings")}
            className={cn(iconButton, tab === "settings" && "bg-secondary text-foreground hover:bg-secondary")}
          >
            <Settings className={cn("size-4", tab === "settings" && "text-link")} />
          </button>
        </Tip>
        {trame.state.capabilities.ownStatus && (
          <div className="mt-1 flex w-full justify-center border-t pt-2">
            <OwnStatus trame={trame} />
          </div>
        )}
      </div>
    </nav>
  );
}

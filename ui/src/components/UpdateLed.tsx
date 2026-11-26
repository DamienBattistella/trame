import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChangelogDialog, type Release } from "@/components/Changelog";
import { appVersion, getAvailableUpdate, installUpdate, onDesktopEvent, setAvailableUpdate, subscribeAvailableUpdate, type UpdateInfo } from "@/desktop";

/** Changelog publié dans latest.json ; null si les notes ne sont pas du JSON (anciennes versions). */
function parseNotes(notes: string | null): Release[] | null {
  if (!notes) return null;
  try {
    const list = JSON.parse(notes);
    return Array.isArray(list) ? (list as Release[]) : null;
  } catch {
    return null;
  }
}

/**
 * En-tête, à droite : LED allumée quand une nouvelle version est publiée (vérifiée
 * toutes les 15 minutes par l'application de bureau). Un clic montre ce qui a changé
 * et propose de l'installer.
 */
export function UpdateLed() {
  const update = useSyncExternalStore(subscribeAvailableUpdate, getAvailableUpdate);
  const [current, setCurrent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    appVersion().then(setCurrent);
    return onDesktopEvent<UpdateInfo>("update-ready", (u) => setAvailableUpdate(u));
  }, []);

  const releases = useMemo(() => parseNotes(update?.notes ?? null) ?? [], [update?.notes]);

  const install = async () => {
    setInstalling(true);
    const error = await installUpdate();
    setInstalling(false);
    if (error) toast.error("Mise à jour impossible", { description: `${error} Trame reste en version ${current ?? "actuelle"}.` });
  };

  return (
    <>
      <AnimatePresence>
        {update && (
          <motion.div
            key="led"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 25 }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Trame ${update.version} est disponible`} onClick={() => setOpen(true)}>
                  <span className="relative grid size-2.5 place-items-center">
                    <span className="absolute inset-0 animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
                    <span className="relative size-2.5 rounded-full bg-primary shadow-[0_0_6px_var(--color-primary)]" />
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Trame {update.version} est disponible</TooltipContent>
            </Tooltip>
          </motion.div>
        )}
      </AnimatePresence>

      {update && (
        <ChangelogDialog
          open={open}
          onOpenChange={(o) => !installing && setOpen(o)}
          title={`Trame ${update.version} est disponible`}
          since={current}
          upTo={update.version}
          releases={releases}
          emptyText="Le détail de cette version n'est pas disponible."
          footer={
            <>
              <Button variant="outline" className="rounded-full" disabled={installing} onClick={() => setOpen(false)}>
                Plus tard
              </Button>
              <Button className="rounded-full px-6" disabled={installing} onClick={install}>
                {installing && <Loader2 className="size-4 animate-spin" />}
                {installing ? "Installation…" : "Installer et redémarrer"}
              </Button>
            </>
          }
        />
      )}
    </>
  );
}

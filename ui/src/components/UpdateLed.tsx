import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChangelogDialog, type Release } from "@/components/Changelog";
import { appVersion, getAvailableUpdate, installUpdate, isDesktop, onDesktopEvent, setAvailableUpdate, subscribeAvailableUpdate, type UpdateInfo } from "@/desktop";

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

/** Mode démo navigateur : `?update` (ou `?update=0.9.0`) simule une mise à jour disponible. */
function demoUpdate(): UpdateInfo | null {
  if (isDesktop()) return null;
  const v = new URLSearchParams(window.location.search).get("update");
  return v === null ? null : { version: v || "0.99.0", notes: null };
}

/**
 * Bas du rail (en-tête pendant le wizard) : icône de téléchargement avec une pastille LED, affichée seulement
 * quand une nouvelle version est publiée (vérifiée toutes les 15 minutes par l'application
 * de bureau) : l'en-tête reste calme le reste du temps. Un clic montre ce qui a changé et
 * propose de l'installer ; pendant l'installation, l'icône tourne et la pastille ne pulse plus.
 */
export function UpdateLed({ side }: { side?: "right" | "bottom" } = {}) {
  const update = useSyncExternalStore(subscribeAvailableUpdate, getAvailableUpdate);
  const [current, setCurrent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    appVersion().then(setCurrent);
    const demo = demoUpdate();
    if (demo) setAvailableUpdate(demo);
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
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative size-10 rounded-xl"
                  aria-label={installing ? `Installation de Trame ${update.version} en cours` : `Mise à jour ${update.version} disponible — installer`}
                  aria-busy={installing || undefined}
                  onClick={() => setOpen(true)}
                >
                  {installing ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                  {/* Pastille LED en coin : pulse tant que la mise à jour attend, fixe pendant l'installation. */}
                  <span aria-hidden className="pointer-events-none absolute top-1.5 right-1.5 grid size-2 place-items-center">
                    {!installing && <span className="absolute inset-0 animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />}
                    <span className="relative size-2 rounded-full bg-primary shadow-[0_0_6px_var(--color-primary)] ring-2 ring-sidebar" />
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side={side}>
                {installing ? `Installation de Trame ${update.version}…` : `Mise à jour ${update.version} disponible — installer`}
              </TooltipContent>
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

import { Fragment, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { SHORTCUTS, isHelpKey } from "@/lib/shortcuts";

/** Aide des raccourcis : Ctrl+/ partout, ou ? hors d'un champ. */
export function ShortcutsHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isHelpKey(e)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[min(40rem,calc(100dvh-4rem))] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Raccourcis clavier</DialogTitle>
          <DialogDescription>Hors d'un champ de saisie, sauf Ctrl+K, Échap et cette aide qui marchent partout.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          {SHORTCUTS.map((g) => (
            <section key={g.title} className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">{g.title}</h3>
              <dl className="flex flex-col gap-1.5">
                {g.items.map((s) => (
                  <div key={s.label} className="flex items-center gap-3 text-sm">
                    <dt className="flex shrink-0 items-center gap-1">
                      {s.keys.map((combo, i) => (
                        <Fragment key={combo.join("+")}>
                          {i > 0 && <span className="px-0.5 text-xs text-muted-foreground">ou</span>}
                          {combo.map((k, j) => (
                            <Fragment key={k}>
                              {j > 0 && <span className="text-xs text-muted-foreground">+</span>}
                              <Kbd>{k}</Kbd>
                            </Fragment>
                          ))}
                        </Fragment>
                      ))}
                    </dt>
                    <dd className="min-w-0 flex-1 text-right text-muted-foreground">{s.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

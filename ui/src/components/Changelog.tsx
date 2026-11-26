import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Gauge, Sparkles, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { appVersion } from "@/desktop";
import changelog from "@/changelog.json";

type Entry = { title: string; details: string[] };
export type Release = { version: string; date: string; feat: Entry[]; fix: Entry[]; perf: Entry[] };

const RELEASES = changelog as Release[];
const SEEN_KEY = "trame.seenVersion";

const KINDS = [
  { key: "feat", label: "Nouveautés", icon: Sparkles, tone: "text-primary" },
  { key: "fix", label: "Corrections", icon: Wrench, tone: "text-success" },
  { key: "perf", label: "Performances", icon: Gauge, tone: "text-warning" },
] as const;

const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
export const newer = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

const longDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
};

/** Versions publiées, de la plus récente à la plus ancienne ; `since` exclu. */
export function releasesAfter(since?: string | null, upTo?: string | null, releases: Release[] = RELEASES) {
  return releases.filter((r) => (!since || newer(r.version, since)) && (!upTo || !newer(r.version, upTo)));
}

function ReleaseBlock({ release }: { release: Release }) {
  return (
    <section className="flex flex-col gap-3">
      <header className="sticky top-0 z-10 flex items-baseline justify-between gap-3 bg-background/95 py-1 backdrop-blur">
        <h3 className="font-semibold tabular-nums">Trame {release.version}</h3>
        <time dateTime={release.date} className="text-xs text-muted-foreground">
          {longDate(release.date)}
        </time>
      </header>
      {KINDS.map(({ key, label, icon: Icon, tone }) =>
        release[key].length ? (
          <div key={key} className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              <Icon className={`size-3.5 ${tone}`} /> {label}
            </p>
            <ul className="flex flex-col gap-2.5">
              {release[key].map((e, i) => (
                <li key={i} className="rounded-xl bg-secondary/60 px-3.5 py-2.5">
                  <p className="text-sm font-medium">{e.title}</p>
                  {e.details.length > 0 && (
                    <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground marker:text-muted-foreground/60">
                      {e.details.map((d, j) => (
                        <li key={j}>{d}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null
      )}
    </section>
  );
}

export function ChangelogDialog({
  open,
  onOpenChange,
  since,
  upTo,
  releases,
  title = "Nouveautés",
  emptyText = "Rien de nouveau à afficher.",
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  since?: string | null;
  upTo?: string | null;
  /** Autre changelog que celui embarqué (celui d'une version pas encore installée). */
  releases?: Release[];
  title?: string;
  emptyText?: string;
  /** Remplace le bouton « Continuer ». */
  footer?: ReactNode;
}) {
  const list = useMemo(() => releasesAfter(since, upTo, releases), [since, upTo, releases]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(44rem,calc(100dvh-4rem))] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {since ? `Ce qui a changé depuis la version ${since}.` : "Toutes les versions de Trame, la plus récente en premier."}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1 border-y">
          <div className="flex flex-col gap-8 px-6 py-5">
            {list.length ? list.map((r) => <ReleaseBlock key={r.version} release={r} />) : (
              <p className="py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
            )}
          </div>
        </ScrollArea>
        <DialogFooter className="px-6 py-4">
          {footer ?? (
            <Button className="rounded-full px-6" onClick={() => onOpenChange(false)}>
              Continuer
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Au lancement après une mise à jour : les nouveautés depuis la dernière version vue. */
export function WhatsNew() {
  const [current, setCurrent] = useState<string | null>(null);
  const [since, setSince] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    appVersion().then((v) => {
      if (!v) return;
      let seen: string | null = null;
      try {
        seen = localStorage.getItem(SEEN_KEY);
      } catch {
        return;
      }
      setCurrent(v);
      if (!seen) {
        try {
          localStorage.setItem(SEEN_KEY, v);
        } catch {
          /* stockage indisponible */
        }
        return;
      }
      if (newer(v, seen) && releasesAfter(seen, v).length) {
        setSince(seen);
        setOpen(true);
      }
    });
  }, []);

  const close = (o: boolean) => {
    setOpen(o);
    if (!o && current) {
      try {
        localStorage.setItem(SEEN_KEY, current);
      } catch {
        /* stockage indisponible */
      }
    }
  };

  return <ChangelogDialog open={open} onOpenChange={close} since={since} upTo={current} title={`Trame ${current ?? ""} est installé`} />;
}

/** Réglages › Général : toutes les nouveautés. */
export function ChangelogRow() {
  const [open, setOpen] = useState(false);
  const latest = RELEASES[0];
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
        <Sparkles className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">Nouveautés</span>
        <span className="truncate text-xs text-muted-foreground">
          {latest ? `Dernière version : ${latest.version}, ${longDate(latest.date)}` : "Historique des versions"}
        </span>
      </div>
      <Button variant="outline" size="sm" className="rounded-full" onClick={() => setOpen(true)}>
        Tout voir
      </Button>
      <ChangelogDialog open={open} onOpenChange={setOpen} title="Historique des versions" />
    </div>
  );
}

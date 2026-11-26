import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, Loader2, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { HealthReport, Trame } from "@/api";

const ICON = {
  ok: { Icon: CheckCircle2, tone: "text-success", label: "OK" },
  warn: { Icon: AlertTriangle, tone: "text-warning", label: "À surveiller" },
  error: { Icon: XCircle, tone: "text-destructive", label: "Problème" },
  unknown: { Icon: CircleHelp, tone: "text-muted-foreground", label: "Inconnu" },
} as const;

const uptime = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

/** Santé de Trame en un écran : Teams, page Teams, file d'envoi, cerveau, veille, disque.
 *  Relue toutes les 30 s tant que le volet est ouvert. */
export function HealthPane({ trame }: { trame: Trame }) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    const res = await trame.health();
    setLoading(false);
    if (res.ok) {
      setReport(res);
      setError(null);
    } else setError(res.error);
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const overall = report ? ICON[report.status] : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3">
        {overall ? <overall.Icon className={cn("size-5", overall.tone)} /> : <Loader2 className="size-5 animate-spin text-muted-foreground" />}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">
            {error ? "Moteur injoignable" : report ? (report.status === "ok" ? "Tout va bien" : overall!.label) : "Contrôle…"}
          </span>
          <span className="text-xs text-muted-foreground">
            {error ?? (report ? `Version ${report.version} · moteur lancé depuis ${uptime(report.uptimeS)}` : "Lecture de l'état de Trame")}
          </span>
        </div>
        <Button variant="outline" size="sm" className="rounded-full" disabled={loading} onClick={load}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} Actualiser
        </Button>
      </div>
      {report && (
        <ul className="divide-y rounded-xl border bg-card">
          {report.items.map((i) => {
            const s = ICON[i.status];
            return (
              <li key={i.key} className="flex items-start gap-3 px-4 py-3">
                <s.Icon className={cn("mt-0.5 size-4 shrink-0", s.tone)} aria-label={s.label} />
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm">{i.label}</span>
                  <span className="text-xs text-muted-foreground">{i.detail}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

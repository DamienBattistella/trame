import { useState } from "react";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Trame } from "@/api";
import { isFiltered } from "@/lib/logFilters";
import { LogFilters } from "@/types";

/** Copier ou enregistrer les journaux (Journal, backend.log, traces OpenTelemetry) ;
 *  avec des filtres actifs, seulement les lignes d'Activité qu'ils gardent. */
export function LogExportButtons({ trame, filters }: { trame: Trame; filters?: LogFilters }) {
  const [busy, setBusy] = useState<"copy" | "save" | null>(null);
  const [copied, setCopied] = useState(false);
  const filtered = !!filters && isFiltered(filters);
  const scope = filtered ? " (vue filtrée)" : "";

  const fetchText = async () => {
    const res = await trame.exportLogs(filters);
    if (!res.ok) toast.error("Export des journaux impossible", { description: res.error });
    return res.ok ? res : null;
  };

  const copy = async () => {
    setBusy("copy");
    const res = await fetchText();
    setBusy(null);
    if (!res) return;
    try {
      await navigator.clipboard.writeText(res.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast.success(filtered ? "Activité filtrée copiée" : "Journaux copiés", { description: "Colle-les où tu veux, par exemple dans la conversation avec Claude." });
    } catch {
      toast.error("Copie impossible", { description: "Le presse-papiers est indisponible : utilise « Exporter »." });
    }
  };

  const save = async () => {
    setBusy("save");
    const res = await fetchText();
    setBusy(null);
    if (!res) return;
    const url = URL.createObjectURL(new Blob([res.text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = res.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast.success(filtered ? "Activité filtrée exportée" : "Journaux exportés", { description: `${res.filename}, dans ton dossier Téléchargements.` });
  };

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" className="rounded-full" disabled={busy !== null} onClick={copy} title={`Copier les journaux${scope}`}>
        {busy === "copy" ? <Loader2 className="size-4 animate-spin" /> : copied ? <Check className="size-4 text-success" strokeWidth={3} /> : <Copy className="size-4" />}
        {copied ? "Copiés" : "Copier"}
      </Button>
      <Button variant="outline" size="sm" className="rounded-full" disabled={busy !== null} onClick={save} title={`Exporter les journaux${scope}`}>
        {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        Exporter
      </Button>
    </div>
  );
}

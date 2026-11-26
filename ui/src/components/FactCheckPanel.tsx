import { motion } from "motion/react";
import { CircleCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FactCheck, FactClaim, FactVerdict } from "@/types";

const VERDICT: Record<FactVerdict, { label: string; className: string }> = {
  contredit: { label: "Contredit", className: "bg-destructive/10 text-destructive" },
  non_verifiable: { label: "Non vérifiable", className: "bg-warning/15 text-warning-foreground dark:text-warning" },
  ok: { label: "Vérifié", className: "bg-success/10 text-success" },
};

function sourcesLine(s: FactCheck["sources"]): string {
  const parts = [`${s.messages} message${s.messages > 1 ? "s" : ""} du fil`];
  if (s.people) parts.push(`${s.people} fiche${s.people > 1 ? "s" : ""} de l'entourage`);
  if (s.github) parts.push("GitHub");
  return parts.join(", ");
}

/** Résultat de « Vérifier » : chaque affirmation douteuse, sa source et une correction en un clic.
 *  Ne bloque pas l'envoi : c'est un avis, le message reste à toi. */
export function FactCheckPanel({
  check,
  text,
  stale,
  onFix,
  onClose,
}: {
  check: FactCheck;
  /** Texte actuel de la zone de réponse : une correction ne s'applique que si l'extrait y est encore. */
  text: string;
  /** Le message a changé depuis la vérification. */
  stale: boolean;
  onFix: (claim: FactClaim) => void;
  onClose: () => void;
}) {
  const doubtful = check.claims.filter((c) => c.verdict !== "ok");
  return (
    <motion.div
      key="factcheck"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="overflow-hidden"
    >
      <section aria-label="Vérification du message" className="rounded-xl border bg-muted/40 px-3 py-2 text-sm">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Vérification</span>
          <span className="truncate">
            {check.checkedAt} · {sourcesLine(check.sources)}
            {stale && " · le message a changé depuis"}
          </span>
          <Button variant="ghost" size="icon" className="ml-auto size-6 shrink-0 rounded-full" aria-label="Fermer la vérification" onClick={onClose}>
            <X className="size-3.5" />
          </Button>
        </div>
        {doubtful.length === 0 && (
          <p className="flex items-center gap-1.5 py-1 text-success">
            <CircleCheck className="size-4" /> Rien à signaler
            {check.claims.length > 0 && (
              <span className="text-xs text-muted-foreground">
                ({check.claims.length} affirmation{check.claims.length > 1 ? "s" : ""} confirmée{check.claims.length > 1 ? "s" : ""})
              </span>
            )}
          </p>
        )}
        {check.claims.length > 0 && (
          <ul className="mt-1 flex max-h-56 flex-col gap-2 overflow-y-auto">
            {check.claims.map((c, i) => {
              const v = VERDICT[c.verdict];
              const fixable = c.verdict !== "ok" && c.fix && c.fix !== c.excerpt && text.includes(c.excerpt);
              const fixed = c.verdict !== "ok" && c.fix && !text.includes(c.excerpt) && text.includes(c.fix);
              return (
                <li key={`${i}-${c.excerpt}`} className={cn("flex flex-col gap-0.5", c.verdict === "ok" && "opacity-70")}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", v.className)}>{v.label}</span>
                    <span className="font-medium">« {c.excerpt} »</span>
                    {fixable && (
                      <Button variant="outline" size="sm" className="ml-auto h-6 rounded-full px-2 text-xs" onClick={() => onFix(c)}>
                        Remplacer par « {c.fix} »
                      </Button>
                    )}
                    {fixed && <span className="ml-auto text-xs text-success">Corrigé</span>}
                  </div>
                  {c.source ? (
                    <p className="text-xs text-muted-foreground">
                      <span className="sr-only">Source : </span>
                      {c.source}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">Aucune source connue de Trame n'en parle.</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </motion.div>
  );
}

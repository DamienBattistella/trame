import { useEffect, useRef, useState } from "react";
import { motion, useAnimationControls } from "motion/react";
import { Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GroupList, SectionLabel, shake } from "@/components/kit";
import { Trame } from "@/api";
import { PeopleSummary } from "@/types";

const dateFr = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
};

/** Réglages › Entourage : qui est qui au travail (ENTOURAGE.json exporté d'Orbite). */
export function EntourageSection({ trame }: { trame: Trame }) {
  const [people, setPeople] = useState<PeopleSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const controls = useAnimationControls();

  useEffect(() => {
    trame.getPeople().then((res) => res.ok && setPeople(res.people));
  }, [trame.connected]);

  const fail = (title: string, error: string) => {
    controls.start(shake);
    toast.error(title, { description: error });
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const res = await trame.uploadPeople(file.name, await file.text());
    setBusy(false);
    if (input.current) input.current.value = "";
    if (!res.ok) return fail("Entourage non importé", `${res.error} L'entourage précédent est conservé.`);
    setPeople(res.people);
    toast.success(`${res.people.count} personne${res.people.count > 1 ? "s" : ""} dans ton entourage`);
  };

  const remove = async () => {
    setBusy(true);
    const res = await trame.removePeople();
    setBusy(false);
    if (!res.ok) return fail("Entourage non retiré", res.error);
    setPeople({ loaded: false, count: 0, source: null, generatedAt: null });
  };

  const when = dateFr(people?.generatedAt ?? null);

  return (
    <motion.div animate={controls}>
      <SectionLabel>Entourage</SectionLabel>
      <GroupList>
        <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
            <Users className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            {people?.loaded ? (
              <>
                <span className="text-sm font-medium">
                  {people.count} personne{people.count > 1 ? "s" : ""}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {[people.source && `Exporté de ${people.source}`, when && `le ${when}`].filter(Boolean).join(" ")}
                </span>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">Aucun entourage importé</span>
            )}
          </div>
          {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {people?.loaded && (
            <Button size="sm" variant="ghost" className="rounded-full" disabled={busy} onClick={remove}>
              Retirer
            </Button>
          )}
          <Button size="sm" variant="outline" className="rounded-full" disabled={busy} onClick={() => input.current?.click()}>
            {people?.loaded ? "Remplacer" : "Importer"}
          </Button>
          <input
            ref={input}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0])}
          />
        </div>
        <div className="px-4 py-2.5 text-xs text-muted-foreground">
          Le fichier ENTOURAGE.json exporté d'Orbite : rôle, équipe et ton de chaque collègue. Trame l'ajoute au brouillon
          pour répondre juste à chacun ; rien d'autre n'en sort.
        </div>
      </GroupList>
    </motion.div>
  );
}

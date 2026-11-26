import { useEffect, useRef, useState } from "react";
import { motion, useAnimationControls } from "motion/react";
import { Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GroupList, shake } from "@/components/kit";
import { Trame } from "@/api";
import { cn } from "@/lib/utils";
import { EntourageDirectory } from "@/components/EntourageDirectory";
import { PeopleSummary, Person } from "@/types";

const dateFr = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
};

/** Réglages › Entourage : qui est qui au travail (ENTOURAGE.json exporté d'Orbite). */
export function EntourageSection({ trame }: { trame: Trame }) {
  const [people, setPeople] = useState<PeopleSummary | null>(null);
  const [list, setList] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const controls = useAnimationControls();

  // Un moteur plus ancien ne connaît pas la liste : l'annuaire reste simplement absent.
  const loadList = () => trame.listPeople().then((res) => setList(res.ok ? res.list : []));

  useEffect(() => {
    trame.getPeople().then((res) => res.ok && setPeople(res.people));
    loadList();
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
    loadList();
    toast.success(`${res.people.count} personne${res.people.count > 1 ? "s" : ""} dans ton entourage`);
  };

  const remove = async () => {
    setBusy(true);
    const res = await trame.removePeople();
    setBusy(false);
    if (!res.ok) return fail("Entourage non retiré", res.error);
    setPeople({ loaded: false, count: 0, source: null, generatedAt: null });
    setList([]);
  };

  const when = dateFr(people?.generatedAt ?? null);

  return (
    <motion.div animate={controls}>
      <GroupList
        className={cn("transition-colors duration-200", drag && "border-primary bg-primary/5")}
        onDragOver={(e) => {
          e.preventDefault();
          if (!drag) setDrag(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          pick(e.dataTransfer.files[0]);
        }}
      >
        <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary">
            <Users className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            {people?.loaded ? (
              <>
                <span className="text-sm font-medium">
                  {drag ? "Lâche le nouveau fichier ici" : `${people.count} personne${people.count > 1 ? "s" : ""}`}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {[people.source && `Exporté de ${people.source}`, when && `le ${when}`].filter(Boolean).join(" ")}
                </span>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">
                {drag ? "Lâche ENTOURAGE.json ici" : "Glisse ENTOURAGE.json ici, ou importe-le"}
              </span>
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
      {people?.loaded && list.length > 0 && <EntourageDirectory people={list} />}
    </motion.div>
  );
}

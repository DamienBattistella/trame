import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { analyzeSoul, Quality } from "@/lib/soulInsight";
import { cn } from "@/lib/utils";
import { Trame } from "@/api";

const QUALITY: Record<Quality, { label: string; className: string }> = {
  complet: { label: "Complet", className: "bg-success/15 text-success" },
  correct: { label: "Correct", className: "bg-link/10 text-link" },
  "a-completer": { label: "À compléter", className: "bg-warning/15 text-warning" },
};

/** Éditeur Markdown du SOUL.md : modèle pré-rempli avec ce que Teams sait déjà, qualité en direct. */
export function SoulEditor({
  trame,
  initial,
  onUse,
  onCancel,
}: {
  trame: Trame;
  initial: string | null;
  onUse: (content: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial ?? "");
  const [loading, setLoading] = useState(initial === null);

  useEffect(() => {
    if (initial !== null) return;
    trame.getSoulTemplate().then((res) => {
      setText(res.ok ? res.content : "# SOUL\n");
      setLoading(false);
    });
  }, []);

  const { score, quality, aspects } = useMemo(() => analyzeSoul(text), [text]);
  const q = QUALITY[quality];
  const lines = text.split("\n").length;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="w-full overflow-hidden rounded-2xl border bg-card text-left">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <FileText className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">SOUL.md</span>
        <span className="text-xs text-muted-foreground tabular-nums">{lines} lignes</span>
        <span className={cn("ml-auto rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums", q.className)}>
          {q.label} · {score}/{aspects.length}
        </span>
      </div>
      {loading ? (
        <div className="flex h-[clamp(10rem,calc(100dvh-30rem),22rem)] items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Préparation à partir de Teams…
        </div>
      ) : (
        <MarkdownEditor
          label="Contenu du SOUL.md"
          value={text}
          onChange={setText}
          className="h-[clamp(12rem,calc(100dvh-28rem),26rem)]"
        />
      )}
      <div className="flex items-center gap-2 border-t px-4 py-2.5">
        <span className="text-xs text-muted-foreground">Pré-rempli avec ton nom, tes groupes actifs et tes derniers messages Teams.</span>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" className="rounded-full" onClick={onCancel}>
            Annuler
          </Button>
          <Button size="sm" className="rounded-full" disabled={loading || !text.trim()} onClick={() => onUse(text)}>
            Utiliser ce texte
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

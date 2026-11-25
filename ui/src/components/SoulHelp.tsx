import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, HelpCircle } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { pop } from "@/components/kit";

const TEMPLATE = `# Ma voix

## Style
- Direct et cordial, tutoiement entre collègues, vouvoiement avec l'extérieur.
- Réponses courtes : 2 à 4 phrases. Pas d'emojis sauf si on m'en envoie.

## Mon rôle
- Développeur sur l'interopérabilité (HL7, FHIR) chez Dedalus.

## Ce que Trame me laisse
- Les délais, les budgets et les engagements fermes.
- Les sujets RH, contractuels ou confidentiels.
- Quand il n'est pas sûr : « Je regarde et je reviens vers toi ».

## Exemples de mes messages
- « Ça marche pour moi, je t'envoie l'invit. »
- « Bien vu, je corrige ça dans la journée. »
`;

export function SoulHelp() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(TEMPLATE);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Impossible de copier le modèle", { description: "Sélectionne-le à la main dans l'exemple." });
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          <HelpCircle className="size-4" /> C'est quoi, un SOUL.md ?
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[22rem] text-left" side="right" align="end" collisionPadding={16}>
        <div className="flex flex-col gap-3 text-sm">
          <div>
            <p className="font-semibold">Un fichier qui décrit ta voix</p>
            <p className="mt-1 text-muted-foreground">
              Un simple fichier texte (Markdown) que Trame relit avant chaque réponse, pour écrire comme toi.
            </p>
          </div>
          <ul className="flex flex-col gap-1 text-muted-foreground">
            <li><span className="text-foreground">Ton style</span> : tutoiement, longueur, ton.</li>
            <li><span className="text-foreground">Ton rôle</span> : équipe, projets, sujets que tu maîtrises.</li>
            <li><span className="text-foreground">Ce qu'il te laisse</span> : délais, RH, sujets sensibles.</li>
            <li><span className="text-foreground">Des exemples</span> de messages que tu as écrits.</li>
          </ul>
          <pre className="max-h-32 overflow-auto rounded-lg bg-muted/60 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
{`# Ma voix
Direct et cordial, tutoiement.
Réponses courtes, pas d'emojis.

## Ce que Trame me laisse
Délais, budgets, sujets RH.`}
          </pre>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">Sans fichier, Trame garde un ton neutre.</span>
            <button
              onClick={copy}
              className="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent"
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={copied ? "ok" : "copy"}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0 }}
                  transition={pop}
                  className="flex"
                >
                  {copied ? <Check className="size-3.5 text-success" strokeWidth={3} /> : <Copy className="size-3.5" />}
                </motion.span>
              </AnimatePresence>
              {copied ? "Modèle copié" : "Copier un modèle"}
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

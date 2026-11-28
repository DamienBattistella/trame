import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Input } from "@/components/ui/input";
import { GroupList, Segment, SelectCircle } from "@/components/kit";
import { cn } from "@/lib/utils";
import { Brain, Effort, Settings } from "@/types";

type ModelTile = { value: string; name: string; line: string; speed?: number; depth?: number; badge?: string };

/** Vitesse et finesse sur 4 : un repère relatif entre modèles, pas une mesure. */
const CLAUDE_MODELS: ModelTile[] = [
  { value: "haiku", name: "Haiku", line: "Réponses courtes, quasi instantanées.", speed: 4, depth: 2, badge: "Recommandé" },
  { value: "sonnet", name: "Sonnet", line: "Équilibré, pour la plupart des échanges.", speed: 3, depth: 3 },
  { value: "opus", name: "Opus", line: "Sujets délicats et techniques.", speed: 2, depth: 4 },
  { value: "fable", name: "Fable", line: "Le plus capable, le plus lent.", speed: 1, depth: 4 },
  { value: "", name: "Claude Code", line: "Le modèle réglé dans ton Claude Code." },
  { value: "custom", name: "Autre", line: "Un nom de modèle complet." },
];
const PRESETS = CLAUDE_MODELS.map((m) => m.value).filter((v) => v !== "custom");

const EFFORTS = [
  { value: "", label: "Auto" },
  { value: "low", label: "Faible" },
  { value: "medium", label: "Moyen" },
  { value: "high", label: "Élevé" },
  { value: "xhigh", label: "Très élevé" },
  { value: "max", label: "Max" },
] as const;

const EFFORT_HINT: Record<Effort, string> = {
  "": "Le réglage de l'outil.",
  low: "Réponse en quelques secondes, pour les échanges simples.",
  medium: "Bon équilibre entre vitesse et soin.",
  high: "Plus réfléchi, un peu plus lent.",
  xhigh: "Pour les sujets délicats : nettement plus lent.",
  max: "Le plus réfléchi : peut prendre plusieurs minutes.",
};

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex items-center gap-1.5" aria-label={`${label} ${value} sur 4`}>
      <span className="text-2xs text-muted-foreground">{label}</span>
      <span className="flex gap-0.5" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cn("h-1.5 w-3 rounded-full", i <= value ? "bg-primary" : "bg-muted-foreground/20")} />
        ))}
      </span>
    </span>
  );
}

/** Champ texte validé à la sortie : un nom de modèle complet, ou vide pour le défaut. */
function ModelInput({ value, placeholder, onCommit }: { value: string; placeholder: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const v = text.trim();
    if (v !== value) onCommit(v);
  };
  return (
    <Input
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      aria-label="Nom du modèle"
      className="h-10 rounded-xl font-mono text-sm"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

function EffortRow({ value, onChange, withMax }: { value: Effort; onChange: (v: Effort) => void; withMax: boolean }) {
  return (
    <div className="flex flex-col gap-2.5 px-4 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">Effort</span>
        <span className="text-xs text-muted-foreground">{EFFORT_HINT[value]}</span>
      </div>
      <Segment fill label="Effort" value={value} options={withMax ? EFFORTS : EFFORTS.filter((e) => e.value !== "max")} onChange={onChange} />
      <div className="flex justify-between px-1 text-2xs text-muted-foreground">
        <span>Plus rapide</span>
        <span>Plus réfléchi</span>
      </div>
    </div>
  );
}

/** Réglages › Cerveau : modèle et effort du cerveau choisi. */
export function ModelPicker({
  brain,
  value,
  onChange,
}: {
  brain: Brain;
  value: Settings["models"];
  onChange: (p: Partial<Settings["models"]>) => void;
}) {
  const [custom, setCustom] = useState(!PRESETS.includes(value.claudeModel));
  useEffect(() => {
    if (!PRESETS.includes(value.claudeModel)) setCustom(true);
  }, [value.claudeModel]);

  if (brain === "copilot") {
    return (
      <GroupList>
        <div className="flex flex-col gap-2 px-4 py-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">Modèle</span>
            <span className="text-xs text-muted-foreground">GPT-6 Luna par défaut</span>
          </div>
          <ModelInput value={value.copilotModel} placeholder="Réglage de Copilot" onCommit={(copilotModel) => onChange({ copilotModel })} />
          <span className="text-xs text-muted-foreground">
            Le nom exact listé par <code className="font-mono">/model</code> dans <code className="font-mono">copilot</code> ; vide
            reprend le réglage de Copilot.
          </span>
        </div>
        <EffortRow value={value.copilotEffort} onChange={(copilotEffort) => onChange({ copilotEffort })} withMax={false} />
      </GroupList>
    );
  }

  const selected = custom ? "custom" : value.claudeModel;
  const pick = (v: string) => {
    if (v === "custom") return setCustom(true);
    setCustom(false);
    if (v !== value.claudeModel) onChange({ claudeModel: v });
  };

  return (
    <GroupList>
      <div className="flex flex-col gap-3 px-4 py-4">
        <span className="text-sm font-medium">Modèle</span>
        <div role="radiogroup" aria-label="Modèle Claude" className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {CLAUDE_MODELS.map((m) => {
            const on = selected === m.value;
            return (
              <motion.button
                key={m.value || "default"}
                type="button"
                role="radio"
                aria-checked={on}
                whileTap={{ scale: 0.98 }}
                onClick={() => pick(m.value)}
                className={cn(
                  "flex min-h-[5.25rem] flex-col gap-1.5 rounded-xl border p-3 text-left transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                  on ? "border-primary bg-primary/5" : "hover:bg-accent"
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{m.name}</span>
                  {m.badge && <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-3xs font-medium text-link">{m.badge}</span>}
                  <span className="ml-auto">
                    <SelectCircle checked={on} />
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">{m.line}</span>
                {m.speed !== undefined && m.depth !== undefined && (
                  <span className="mt-auto flex flex-wrap gap-x-3 gap-y-1">
                    <Meter label="Vitesse" value={m.speed} />
                    <Meter label="Finesse" value={m.depth} />
                  </span>
                )}
              </motion.button>
            );
          })}
        </div>
        <AnimatePresence initial={false}>
          {custom && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <ModelInput
                value={PRESETS.includes(value.claudeModel) ? "" : value.claudeModel}
                placeholder="Nom complet, ex. claude-opus-5-5"
                onCommit={(claudeModel) => onChange({ claudeModel })}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <EffortRow value={value.claudeEffort} onChange={(claudeEffort) => onChange({ claudeEffort })} withMax />
    </GroupList>
  );
}

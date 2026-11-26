import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { GroupList, Segment } from "@/components/kit";
import { Brain, Effort, Settings } from "@/types";

const CLAUDE_MODELS = [
  { value: "", label: "Par défaut" },
  { value: "fable", label: "Fable" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "custom", label: "Autre" },
] as const;

const EFFORTS = [
  { value: "", label: "Auto" },
  { value: "low", label: "Faible" },
  { value: "medium", label: "Moyen" },
  { value: "high", label: "Élevé" },
  { value: "xhigh", label: "Très élevé" },
  { value: "max", label: "Max" },
] as const;

const EFFORT_HINT: Record<Effort, string> = {
  "": "Le réglage de Claude Code.",
  low: "Réponses les plus rapides, pour les échanges simples.",
  medium: "Bon équilibre entre vitesse et soin.",
  high: "Plus réfléchi, un peu plus lent.",
  xhigh: "Pour les sujets délicats : nettement plus lent.",
  max: "Le plus réfléchi : peut prendre plusieurs minutes.",
};

const PRESETS: readonly string[] = CLAUDE_MODELS.map((m) => m.value).filter((v) => v !== "custom");

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
      className="h-9 rounded-xl font-mono text-xs"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
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
        <div className="flex flex-col gap-2 px-4 py-3">
          <span className="text-sm font-medium">Modèle Copilot</span>
          <ModelInput value={value.copilotModel} placeholder="Par défaut (réglage de Copilot)" onCommit={(copilotModel) => onChange({ copilotModel })} />
          <span className="text-xs text-muted-foreground">
            Le nom exact tel que Copilot le liste (commande <code className="font-mono">/model</code> dans <code className="font-mono">copilot</code>).
          </span>
        </div>
      </GroupList>
    );
  }

  const segment = custom ? "custom" : value.claudeModel;
  return (
    <GroupList>
      <div className="flex flex-col gap-2.5 px-4 py-3">
        <span className="text-sm font-medium">Modèle</span>
        <Segment
          label="Modèle Claude"
          value={segment}
          options={CLAUDE_MODELS}
          onChange={(v) => {
            if (v === "custom") {
              setCustom(true);
              return;
            }
            setCustom(false);
            onChange({ claudeModel: v });
          }}
        />
        {custom && (
          <ModelInput value={PRESETS.includes(value.claudeModel) ? "" : value.claudeModel} placeholder="Nom complet, ex. claude-opus-5-5" onCommit={(claudeModel) => onChange({ claudeModel })} />
        )}
        <span className="text-xs text-muted-foreground">
          Les alias suivent toujours la dernière version. « Par défaut » reprend le modèle de ton Claude Code.
        </span>
      </div>
      <div className="flex flex-col gap-2.5 px-4 py-3">
        <span className="text-sm font-medium">Effort</span>
        <Segment label="Effort" value={value.claudeEffort} options={EFFORTS} onChange={(claudeEffort) => onChange({ claudeEffort })} />
        <span className="text-xs text-muted-foreground">{EFFORT_HINT[value.claudeEffort]}</span>
      </div>
    </GroupList>
  );
}

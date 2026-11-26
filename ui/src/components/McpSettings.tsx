import { useState } from "react";
import { Check, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { GroupList } from "@/components/kit";
import { Settings } from "@/types";

const URL = "http://127.0.0.1:8731/mcp";
const TOOLS = [
  ["list_conversations", "discussions, statut, non-lus"],
  ["read_conversation", "derniers messages d'une discussion"],
  ["summarize_conversation", "résumé, points ouverts, liens GitHub"],
  ["list_drafts", "réponses à relire"],
  ["propose_reply", "dépose une réponse dans « À relire », sans l'envoyer"],
] as const;

function CopyField({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(!secret);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Copie impossible", { description: "Sélectionne le texte et copie-le à la main." });
    }
  };
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 rounded-lg bg-muted px-3 py-2 font-mono text-xs break-all select-all">
          {shown ? value : "•".repeat(24)}
        </code>
        {secret && (
          <Button variant="ghost" size="icon" className="size-8 rounded-full" aria-label={shown ? "Masquer" : "Afficher"} onClick={() => setShown((v) => !v)}>
            {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        )}
        <Button variant="ghost" size="icon" className="size-8 rounded-full" aria-label={`Copier ${label.toLowerCase()}`} onClick={copy}>
          {copied ? <Check className="size-4 text-success" strokeWidth={3} /> : <Copy className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

/** Réglages › MCP : Trame comme serveur MCP local pour Claude Code, Copilot ou Jarvis. */
export function McpSettings({ value, onChange }: { value: Settings["mcp"]; onChange: (p: { enabled?: boolean; regenerateToken?: boolean }) => void }) {
  const command = `claude mcp add --transport http trame ${URL} --header "Authorization: Bearer ${value.token}"`;
  return (
    <div className="flex flex-col gap-3">
      <GroupList>
        <div className="flex items-center justify-between px-4 py-3">
          <Label htmlFor="mcp-enabled" className="font-normal">Serveur MCP local</Label>
          <Switch id="mcp-enabled" checked={value.enabled} onCheckedChange={(enabled) => onChange({ enabled })} />
        </div>
        {value.enabled && value.token && (
          <>
            <CopyField label="Adresse" value={URL} />
            <CopyField label="Jeton" value={value.token} secret />
            <CopyField label="Commande Claude Code" value={command} secret />
            <div className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="text-xs text-muted-foreground">Un jeton régénéré coupe l'accès aux clients configurés avec l'ancien.</span>
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => onChange({ regenerateToken: true })}>
                <RefreshCw className="size-4" /> Régénérer
              </Button>
            </div>
          </>
        )}
      </GroupList>
      <GroupList>
        {TOOLS.map(([name, desc]) => (
          <div key={name} className="flex items-baseline gap-3 px-4 py-2.5">
            <code className="shrink-0 font-mono text-xs">{name}</code>
            <span className="text-xs text-muted-foreground">{desc}</span>
          </div>
        ))}
        <div className="px-4 py-2.5 text-xs text-muted-foreground">
          Accessible seulement depuis ce poste, avec le jeton. Aucun outil n'envoie de message : une réponse proposée attend
          toujours ton clic dans « À relire ». Le texte des messages est présenté aux assistants comme une donnée, pas comme
          une instruction.
        </div>
      </GroupList>
    </div>
  );
}

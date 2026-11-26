import { useState } from "react";
import { AlertTriangle, Check, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { GroupList } from "@/components/kit";
import { cn } from "@/lib/utils";
import { Settings } from "@/types";
import { ENGINE } from "@/api";

const URL = `http://${ENGINE}/mcp`;
const GROUPS: { title: string; send?: boolean; tools: [string, string][] }[] = [
  {
    title: "Lire",
    tools: [
      ["list_conversations", "discussions, statut, non-lus"],
      ["read_conversation", "derniers messages d'une discussion (par nom ou identifiant)"],
      ["summarize_conversation", "résumé, points ouverts, éléments GitHub"],
      ["list_drafts", "réponses à relire"],
      ["lookup_person", "fiche de l'entourage : rôle, équipe, ton"],
      ["get_persona", "ton SOUL.md"],
      ["get_my_status", "ton statut Teams et ton message de statut"],
    ],
  },
  {
    title: "Préparer, sans envoyer",
    tools: [
      ["suggest_reply", "réponse rédigée par le cerveau de Trame"],
      ["propose_reply", "dépose une réponse dans « À relire »"],
      ["edit_draft · dismiss_draft", "modifie ou écarte une réponse à relire"],
      ["type_in_teams", "écrit la réponse dans Teams sans l'envoyer"],
      ["follow_conversation", "suivre une discussion, mode Brouillon"],
      ["catch_up · set_paused", "rattrapage des non-lus, pause"],
      ["set_my_status", "change ton statut Teams ou ton message de statut"],
    ],
  },
  {
    title: "Diagnostiquer",
    tools: [
      ["get_status · get_settings", "état de Trame et de Teams, réglages (sans jeton)"],
      ["get_logs · get_telemetry", "journal, export complet, traces OpenTelemetry"],
      ["diagnose_teams", "structure de la page Teams, sans texte de message"],
      ["list_skills", "skills chargés, actifs ou non, sans leur texte"],
    ],
  },
  {
    title: "Envoyer",
    send: true,
    tools: [
      ["send_draft", "envoie une réponse à relire"],
      ["send_message", "envoie un message dans une discussion"],
    ],
  },
];


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
export function McpSettings({
  value,
  onChange,
}: {
  value: Settings["mcp"];
  onChange: (p: { enabled?: boolean; regenerateToken?: boolean; allowSend?: boolean }) => void;
}) {
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
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 flex-col">
                <Label htmlFor="mcp-send" className="font-normal">Autoriser l'envoi par les assistants</Label>
                <span className="text-xs text-muted-foreground">
                  {value.allowSend
                    ? "Les assistants peuvent envoyer en ton nom et passer une discussion en Auto."
                    : "Désactivé : les assistants préparent, tu envoies."}
                </span>
              </div>
              <Switch id="mcp-send" checked={value.allowSend} onCheckedChange={(allowSend) => onChange({ allowSend })} />
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="text-xs text-muted-foreground">Un jeton régénéré coupe l'accès aux clients configurés avec l'ancien.</span>
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => onChange({ regenerateToken: true })}>
                <RefreshCw className="size-4" /> Régénérer
              </Button>
            </div>
          </>
        )}
      </GroupList>
      {GROUPS.map((g) => (
        <div key={g.title} className="flex flex-col gap-1.5">
          <span className="px-1 text-xs font-medium text-muted-foreground">
            {g.title}
            {g.send && !value.allowSend && " · désactivé"}
          </span>
          <GroupList className={cn(g.send && !value.allowSend && "opacity-50")}>
            {g.tools.map(([name, desc]) => (
              <div key={name} className="flex items-baseline gap-3 px-4 py-2.5">
                <code className="shrink-0 font-mono text-xs">{name}</code>
                <span className="text-xs text-muted-foreground">{desc}</span>
              </div>
            ))}
          </GroupList>
        </div>
      ))}
      <p className="flex gap-2 px-1 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <span>
          Accessible seulement depuis ce poste, avec le jeton. Le texte des messages est présenté aux assistants comme une
          donnée, jamais comme une instruction. Un envoi n'est confirmé que si le message apparaît dans Teams. Trois prompts
          sont fournis : trier mes messages, répondre à une discussion, diagnostiquer Trame.
        </span>
      </p>
    </div>
  );
}

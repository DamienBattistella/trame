import { useState } from "react";
import { Check, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PRESENCE, PresenceBadge } from "@/components/kit";
import type { Trame } from "@/api";
import type { StatusChoice } from "@/types";
import { cn } from "@/lib/utils";

/** Ce que Teams propose dans son menu de statut, dans le même ordre. */
const CHOICES: { value: Exclude<StatusChoice, "reset">; label: string }[] = [
  { value: "available", label: "Disponible" },
  { value: "busy", label: "Occupé" },
  { value: "dnd", label: "Ne pas déranger" },
  { value: "brb", label: "De retour bientôt" },
  { value: "away", label: "Apparaître absent" },
  { value: "offline", label: "Apparaître hors ligne" },
];
const MESSAGE_MAX = 280;

/**
 * En-tête : son propre statut Teams (la pastille), et au clic de quoi le changer sans
 * rouvrir Teams, ainsi que le message de statut. Chaque changement est vérifié dans
 * Teams par le moteur : un statut que Teams n'affiche pas est signalé, jamais montré.
 */
export function OwnStatus({ trame }: { trame: Trame }) {
  const presence = trame.state.myPresence;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<StatusChoice | "message" | null>(null);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const label = presence ? PRESENCE[presence].label : "Statut inconnu";

  const onOpenChange = async (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setSaved(null);
    const res = await trame.getMyStatus();
    if (res.ok) {
      setMessage(res.message);
      setSaved(res.message);
    } else toast.error("Statut Teams illisible", { description: res.error });
  };

  const choose = async (choice: StatusChoice) => {
    setBusy(choice);
    const res = await trame.setMyStatus(choice);
    setBusy(null);
    if (!res.ok) return toast.error("Statut non changé", { description: res.error });
    setOpen(false);
    toast.success(choice === "reset" ? "Statut réinitialisé" : `Statut : ${PRESENCE[choice].label}`);
  };

  const saveMessage = async (text: string) => {
    setBusy("message");
    const res = await trame.setStatusMessage(text);
    setBusy(null);
    if (!res.ok) return toast.error("Message de statut non changé", { description: res.error });
    setMessage(res.message);
    setSaved(res.message);
    toast.success(res.message ? "Message de statut mis à jour" : "Message de statut effacé");
  };

  const working = busy !== null;
  const dirty = saved !== null && message.replace(/\s+/g, " ").trim() !== saved;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-2 rounded-full px-2.5 text-xs" aria-label={`Ton statut Teams : ${label}. Changer`}>
          {presence ? (
            <PresenceBadge presence={presence} className="ring-0" />
          ) : (
            <span className="size-3 rounded-full border-2 border-dashed border-muted-foreground/60" />
          )}
          <span className="hidden max-w-28 truncate sm:inline">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1.5">
        <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">Ton statut dans Teams</div>
        <div role="menu" aria-label="Choisir son statut">
          {CHOICES.map((c) => (
            <button
              key={c.value}
              role="menuitemradio"
              aria-checked={presence === c.value}
              disabled={working}
              onClick={() => choose(c.value)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-60",
                presence === c.value && "font-medium"
              )}
            >
              <PresenceBadge presence={c.value} className="ring-0" />
              <span className="flex-1">{c.label}</span>
              {busy === c.value ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                presence === c.value && <Check className="size-3.5 text-primary" />
              )}
            </button>
          ))}
          <button
            role="menuitem"
            disabled={working}
            onClick={() => choose("reset")}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent disabled:opacity-60"
          >
            {busy === "reset" ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
            <span className="flex-1">Réinitialiser le statut</span>
          </button>
        </div>
        <div className="mt-1.5 border-t px-1 pb-1 pt-2.5">
          <label htmlFor="trame-status-message" className="px-1 text-xs font-medium text-muted-foreground">
            Message de statut
          </label>
          <form
            className="mt-1.5 flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty) saveMessage(message);
            }}
          >
            <Input
              id="trame-status-message"
              value={message}
              maxLength={MESSAGE_MAX}
              disabled={working || saved === null}
              placeholder={saved === null ? "Lecture dans Teams…" : "Aucun message"}
              onChange={(e) => setMessage(e.target.value)}
              className="h-8 text-xs"
            />
            <Button type="submit" size="sm" className="h-8" disabled={working || !dirty}>
              {busy === "message" ? <Loader2 className="size-3.5 animate-spin" /> : "OK"}
            </Button>
          </form>
          {saved ? (
            <button
              type="button"
              disabled={working}
              onClick={() => saveMessage("")}
              className="mt-1.5 px-1 text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-60"
            >
              Effacer le message
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

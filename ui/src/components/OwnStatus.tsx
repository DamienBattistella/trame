import { useState } from "react";
import { Check, Dices, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PRESENCE, PresenceBadge } from "@/components/kit";
import type { Trame } from "@/api";
import type { StatusChoice, StatusDuration } from "@/types";
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
/** « Rétablir le statut après » de Teams : libellé de la liste, et fin de phrase pour la notification. */
const DURATIONS: { value: StatusDuration | ""; label: string; phrase: string }[] = [
  { value: "", label: "Jusqu'à ce que je le change", phrase: "" },
  { value: "30m", label: "Pendant 30 minutes", phrase: "pendant 30 minutes" },
  { value: "1h", label: "Pendant 1 heure", phrase: "pendant 1 heure" },
  { value: "2h", label: "Pendant 2 heures", phrase: "pendant 2 heures" },
  { value: "today", label: "Jusqu'à ce soir", phrase: "jusqu'à ce soir" },
  { value: "week", label: "Jusqu'à la fin de la semaine", phrase: "jusqu'à la fin de la semaine" },
];

/**
 * En-tête : son propre statut Teams (la pastille), et au clic de quoi le changer sans
 * rouvrir Teams, ainsi que le message de statut. Chaque changement est vérifié dans
 * Teams par le moteur : un statut que Teams n'affiche pas est signalé, jamais montré.
 */
export function OwnStatus({ trame }: { trame: Trame }) {
  const presence = trame.state.myPresence;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<StatusChoice | "message" | "suggest" | null>(null);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [duration, setDuration] = useState<StatusDuration | "">("");

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
    const until = choice !== "reset" && duration ? duration : null;
    const res = await trame.setMyStatus(choice, until);
    setBusy(null);
    if (!res.ok) return toast.error("Statut non changé", { description: res.error });
    setOpen(false);
    const forHow = until ? ` ${DURATIONS.find((d) => d.value === until)!.phrase}` : "";
    toast.success(choice === "reset" ? "Statut réinitialisé" : `Statut : ${PRESENCE[choice].label}${forHow}`);
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

  // Un message proposé dans ta voix : il remplit la zone, OK l'envoie à Teams.
  const suggest = async () => {
    setBusy("suggest");
    const res = await trame.suggestStatusMessage(message);
    setBusy(null);
    if (!res.ok) return toast.error("Aucun message proposé", { description: res.error });
    setMessage(res.text.slice(0, MESSAGE_MAX));
    if (res.source === "fallback") toast.info("Message tout prêt", { description: "Le cerveau n'a pas répondu : voici une proposition simple." });
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
      <PopoverContent align="end" className="w-80 p-1.5">
        <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">Ton statut dans Teams</div>
        {/* Durée : Teams remet le statut d'avant à la fin (« Rétablir le statut après »). */}
        <label className="mb-1 flex items-center gap-2 px-2 text-xs text-muted-foreground">
          Durée
          <select
            aria-label="Durée du statut"
            value={duration}
            disabled={working}
            onChange={(e) => setDuration(e.target.value as StatusDuration | "")}
            className="h-7 flex-1 rounded-md border bg-background px-1.5 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            {DURATIONS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
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
          <div className="flex items-center justify-between px-1">
            <label htmlFor="trame-status-message" className="text-xs font-medium text-muted-foreground">
              Message de statut
            </label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground"
              disabled={working || saved === null}
              onClick={suggest}
              title="Proposer un message dans ta voix (rien n'est envoyé avant OK)"
            >
              {busy === "suggest" ? <Loader2 className="size-3.5 animate-spin" /> : <Dices className="size-3.5" />}
              Proposer
            </Button>
          </div>
          <form
            className="mt-1.5 flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty) saveMessage(message);
            }}
          >
            {/* Tout le message se lit : la zone grandit avec le texte (jusqu'à six lignes
                environ, puis défile). Entrée enregistre, comme dans Teams. */}
            <Textarea
              id="trame-status-message"
              value={message}
              maxLength={MESSAGE_MAX}
              rows={1}
              disabled={working || saved === null}
              placeholder={saved === null ? "Lecture dans Teams…" : "Aucun message"}
              onChange={(e) => setMessage(e.target.value.replace(/\r?\n/g, " "))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (dirty && !working) saveMessage(message);
                }
              }}
              className="field-sizing-content max-h-32 min-h-8 resize-none py-1.5 text-xs leading-relaxed break-words"
            />
            <div className="flex items-center gap-2 px-1">
              {saved ? (
                <button
                  type="button"
                  disabled={working}
                  onClick={() => saveMessage("")}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-60"
                >
                  Effacer le message
                </button>
              ) : null}
              <span className={cn("ml-auto text-[11px] tabular-nums text-muted-foreground", message.length >= MESSAGE_MAX && "text-warning")}>
                {message.length}/{MESSAGE_MAX}
              </span>
              <Button type="submit" size="sm" className="h-7 px-3" disabled={working || !dirty}>
                {busy === "message" ? <Loader2 className="size-3.5 animate-spin" /> : "OK"}
              </Button>
            </div>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  );
}

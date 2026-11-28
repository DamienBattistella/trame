/* Kit partagé : mêmes primitives visuelles et mêmes micro-animations d'état
   pour le wizard ET le panneau. */
import { useId } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bot, Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { usePhoto } from "@/lib/photos";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Presence } from "@/types";

export const spring = { type: "spring", stiffness: 500, damping: 32 } as const;
export const pop = { type: "spring", stiffness: 520, damping: 17 } as const;

/** Initiales lisibles : lettres seulement (emojis, crochets et tirets ignorés). */
export function initials(name: string) {
  const words = name.split(/[\s_-]+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0]!.toUpperCase());
  return letters.join("") || "?";
}

/** Teintes des avatars à initiales. */
const AVATAR_HUES = [258, 200, 160, 130, 85, 50, 25, 340, 300, 230] as const;

/** Teinte stable par nom : la même personne garde sa couleur partout (wizard, panneau, brief). */
export function avatarHue(name: string): number {
  let h = 0;
  for (const ch of name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()) {
    h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return AVATAR_HUES[h % AVATAR_HUES.length];
}

/** Ton d'un statut : la couleur de sa pastille (jetons --presence-* de index.css). */
export type PresenceTone = "available" | "busy" | "away" | "ooo" | "offline";

/** Pictogramme posé dans la pastille, comme dans Teams : le statut se lit sans la couleur. */
type PresenceGlyph = "check" | "minus" | "clock" | "arrow" | "screen" | "phone" | "cross" | null;

/** Libellé, ton et pictogramme de chaque statut Teams. */
export const PRESENCE: Record<Presence, { label: string; tone: PresenceTone; glyph: PresenceGlyph }> = {
  available: { label: "Disponible", tone: "available", glyph: "check" },
  busy: { label: "Occupé", tone: "busy", glyph: null },
  in_call: { label: "En appel", tone: "busy", glyph: "phone" },
  in_meeting: { label: "En réunion", tone: "busy", glyph: null },
  presenting: { label: "En présentation", tone: "busy", glyph: "screen" },
  dnd: { label: "Ne pas déranger", tone: "busy", glyph: "minus" },
  brb: { label: "De retour bientôt", tone: "away", glyph: "clock" },
  away: { label: "Absent", tone: "away", glyph: "clock" },
  ooo: { label: "Absent du bureau", tone: "ooo", glyph: "arrow" },
  offline: { label: "Hors ligne", tone: "offline", glyph: "cross" },
};

const TONE_TEXT: Record<PresenceTone, string> = {
  available: "text-presence-available",
  busy: "text-presence-busy",
  away: "text-presence-away",
  ooo: "text-presence-ooo",
  offline: "text-presence-offline",
};

const TONE_BG: Record<PresenceTone, string> = {
  available: "bg-presence-available",
  busy: "bg-presence-busy",
  away: "bg-presence-away",
  ooo: "bg-presence-ooo",
  offline: "bg-presence-offline",
};

/** Tracés sur 16 × 16, en blanc sur la pastille pleine (hors ligne : dans la couleur). */
const GLYPHS: Record<Exclude<PresenceGlyph, null>, React.ReactNode> = {
  check: <path d="M4.9 8.2 7 10.3l4.1-4.4" />,
  minus: <path d="M4.9 8h6.2" />,
  clock: <path d="M8 4.7v3.5l2.3 1.4" />,
  arrow: <path d="M11 8H5.3m2.4-2.5L5.2 8l2.5 2.5" />,
  screen: <path d="M4.6 5.4h6.8v4.4H4.6zM6.6 11.4h2.8" />,
  phone: <path stroke="none" fill="white" d="M5.6 4.8 7 6.4l-.7 1a5.2 5.2 0 0 0 2.3 2.3l1-.7 1.6 1.4-.7 1a1.5 1.5 0 0 1-1.6.4 7 7 0 0 1-4-4 1.5 1.5 0 0 1 .4-1.6z" />,
  cross: <path d="m6.2 6.2 3.6 3.6m0-3.6-3.6 3.6" />,
};

/** Pastille de présence posée sur le coin d'un avatar : rond du ton du statut et son
 *  pictogramme. size md (14 px) sur un avatar de 32 px et plus, sm (12 px) en dessous. */
export function PresenceBadge({ presence, className, size = "md" }: { presence: Presence; className?: string; size?: "sm" | "md" }) {
  const p = PRESENCE[presence];
  if (!p) return null;
  const hollow = p.tone === "offline";
  return (
    <span
      role="img"
      aria-label={p.label}
      title={p.label}
      data-presence={presence}
      className={cn(
        "inline-grid shrink-0 rounded-full bg-background ring-2 ring-background transition-colors duration-300",
        size === "sm" ? "size-3" : "size-3.5",
        TONE_TEXT[p.tone],
        className
      )}
    >
      <svg viewBox="0 0 16 16" className="size-full" aria-hidden fill="none" strokeLinecap="round" strokeLinejoin="round">
        {hollow ? (
          <circle cx="8" cy="8" r="6.6" stroke="currentColor" strokeWidth="2.2" />
        ) : (
          <circle cx="8" cy="8" r="8" fill="currentColor" />
        )}
        {p.glyph && (
          <g stroke={hollow ? "currentColor" : "white"} strokeWidth="1.8">
            {GLYPHS[p.glyph]}
          </g>
        )}
      </svg>
    </span>
  );
}

/** Le statut en toutes lettres, précédé de son point coloré (en-têtes de conversation). */
export function PresenceLabel({ presence, className }: { presence: Presence; className?: string }) {
  const p = PRESENCE[presence];
  if (!p) return null;
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full transition-colors duration-300", TONE_BG[p.tone])} />
      {p.label}
    </span>
  );
}

/** Fragments d'une ligne de détails, séparés par « · » ; les vides sont sautés. */
export function Dotted({ parts }: { parts: React.ReactNode[] }) {
  const shown = parts.filter((p) => p !== null && p !== undefined && p !== false && p !== "");
  return (
    <>
      {shown.map((p, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden> · </span>}
          {p}
        </span>
      ))}
    </>
  );
}

/** Avatar shadcn teinté selon le nom : la photo Teams de la personne quand le moteur l'a
 *  lue (lib/photos), ses initiales sinon. Avec une présence connue, la pastille Teams en
 *  bas à droite et son libellé au survol. */
export function InitialsAvatar({ name, className, presence }: { name: string; className?: string; presence?: Presence | null }) {
  const avatar = <PlainAvatar name={name} className={className} />;
  if (!presence || !PRESENCE[presence]) return avatar;
  const small = /\bsize-[5-7]\b/.test(className ?? "");
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="relative inline-flex shrink-0">
            {avatar}
            <PresenceBadge presence={presence} size={small ? "sm" : "md"} className="absolute -right-0.5 -bottom-0.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{PRESENCE[presence].label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PlainAvatar({ name, className }: { name: string; className?: string }) {
  const photo = usePhoto(name);
  return (
    <Avatar className={cn("size-9 shrink-0", className)} aria-hidden>
      {photo ? <AvatarImage src={photo} alt="" className="object-cover" /> : null}
      <AvatarFallback
        className="bg-[oklch(0.93_0.045_var(--avatar-h))] text-xs font-semibold text-[oklch(0.4_0.12_var(--avatar-h))] dark:bg-[oklch(0.33_0.07_var(--avatar-h))] dark:text-[oklch(0.9_0.06_var(--avatar-h))]"
        style={{ "--avatar-h": avatarHue(name) } as React.CSSProperties}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

export function GroupList({ children, className, ...rest }: React.ComponentProps<"div">) {
  return (
    <div {...rest} className={cn("w-full divide-y divide-border overflow-hidden rounded-2xl border bg-card text-left", className)}>
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 ml-1 text-sm font-medium text-muted-foreground">{children}</h2>;
}

type SegmentOption<T> = { value: T; label: string };

/** Choix segmenté : le curseur glisse sous l'option choisie. */
export function Segment<T extends string>({
  value,
  onChange,
  disabled,
  label,
  options,
  fill = false,
}: {
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  label?: string;
  options: readonly SegmentOption<T>[];
  /** Pleine largeur : chaque option prend une part égale, cibles plus grandes. */
  fill?: boolean;
}) {
  const id = useId();
  // Contrôle segmenté accessible : groupe de boutons radio, flèches pour changer.
  const move = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = options[(i + d + options.length) % options.length];
    onChange(next.value);
    (e.currentTarget.parentElement?.children[(i + d + options.length) % options.length] as HTMLElement | undefined)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "flex rounded-full bg-secondary p-0.5 font-medium transition-opacity",
        fill ? "w-full p-1 text-sm" : "text-xs",
        disabled && "opacity-40"
      )}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          disabled={disabled}
          onKeyDown={(e) => move(e, i)}
          onClick={() => onChange(o.value)}
          className={cn(
            "relative rounded-full px-3 py-1 transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            fill && "min-w-0 flex-1 truncate py-1.5 text-center",
            value === o.value ? "text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {value === o.value && (
            <motion.span
              layoutId={`segment-${id}`}
              transition={spring}
              className="absolute inset-0 rounded-full bg-background shadow-sm"
            />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export const AUTO_HINT = "Mode Auto : Trame répond automatiquement aux messages";

/**
 * Mode Auto d'une conversation, en un seul état actif / inactif. Inactif, Trame prépare
 * des brouillons à relire : c'est le comportement de base de toute conversation suivie.
 */
export function AutoToggle({ mode, onChange, name, className }: { mode: "draft" | "auto"; onChange: (mode: "draft" | "auto") => void; name?: string; className?: string }) {
  const on = mode === "auto";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={on}
          aria-label={name ? `Mode Auto pour ${name}` : "Mode Auto"}
          onClick={() => onChange(on ? "draft" : "auto")}
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            on ? "bg-warning/15 text-warning ring-1 ring-warning/40" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            className
          )}
        >
          <Bot className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        {on ? `${AUTO_HINT}. Clique pour revenir aux brouillons.` : "Mode Auto inactif : Trame prépare des brouillons à relire. Clique pour qu'il réponde automatiquement."}
      </TooltipContent>
    </Tooltip>
  );
}

export type Status = "idle" | "run" | "ok" | "error";

/** Pastille d'état : attente → en cours → OK (rebond) / erreur. */
export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return (
    <span className={cn("relative grid size-6 shrink-0 place-items-center", className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        {status === "idle" && (
          <motion.span key="idle" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }}
            className="size-6 rounded-full border border-muted-foreground/30" />
        )}
        {status === "run" && (
          <motion.span key="run" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Loader2 className="size-5 animate-spin text-link" />
          </motion.span>
        )}
        {status === "ok" && (
          <motion.span key="ok" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={pop}
            className="grid size-6 place-items-center rounded-full bg-success text-success-foreground">
            <Check className="size-3.5" strokeWidth={3} />
          </motion.span>
        )}
        {status === "error" && (
          <motion.span key="error" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={pop}
            className="grid size-6 place-items-center rounded-full bg-destructive text-destructive-foreground">
            <X className="size-3.5" strokeWidth={3} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/** Cercle de sélection : la coche apparaît avec un rebond. */
export function SelectCircle({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full border transition-colors duration-200",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
      )}
    >
      <AnimatePresence initial={false}>
        {checked && (
          <motion.span key="c" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={pop}>
            <Check className="size-3.5" strokeWidth={3} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/** Compteur qui rebondit quand sa valeur change. */
export function CountBadge({ n }: { n: number }) {
  return (
    <AnimatePresence initial={false}>
      {n > 0 && (
        <motion.span
          key={n}
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.4, opacity: 0 }}
          transition={pop}
          className="ml-1.5 inline-block rounded-full bg-primary/15 px-1.5 text-xs tabular-nums text-link"
        >
          {n}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/** Secousse d'erreur : à passer en `animate` quand l'action échoue. */
export const shake = { x: [0, -7, 7, -5, 5, -2, 0], transition: { duration: 0.4 } };

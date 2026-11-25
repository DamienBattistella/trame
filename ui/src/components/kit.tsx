/* Kit partagé : mêmes primitives visuelles et mêmes micro-animations d'état
   pour le wizard ET le panneau. */
import { useId } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export const spring = { type: "spring", stiffness: 500, damping: 32 } as const;
export const pop = { type: "spring", stiffness: 520, damping: 17 } as const;

export function initials(name: string) {
  return name
    .replace(/[#]/g, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

export function InitialsAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium transition-opacity",
        className
      )}
    >
      {initials(name)}
    </div>
  );
}

export function GroupList({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("w-full divide-y divide-border overflow-hidden rounded-2xl border bg-card text-left", className)}>
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 ml-1 text-sm font-medium text-muted-foreground">{children}</h2>;
}

/** Brouillon / Auto : le curseur glisse sous l'option choisie. */
export function Segment({
  value,
  onChange,
  disabled,
}: {
  value: "draft" | "auto";
  onChange: (v: "draft" | "auto") => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={cn("flex rounded-full bg-secondary p-0.5 text-xs font-medium transition-opacity", disabled && "opacity-40")}>
      {(["draft", "auto"] as const).map((v) => (
        <button
          key={v}
          disabled={disabled}
          onClick={() => onChange(v)}
          className={cn(
            "relative rounded-full px-3 py-1 transition-colors",
            value === v ? "text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {value === v && (
            <motion.span layoutId={`segment-${id}`} transition={spring} className="absolute inset-0 rounded-full bg-background shadow-sm" />
          )}
          <span className="relative">{v === "draft" ? "Brouillon" : "Auto"}</span>
        </button>
      ))}
    </div>
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
            <Loader2 className="size-5 animate-spin text-primary" />
          </motion.span>
        )}
        {status === "ok" && (
          <motion.span key="ok" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={pop}
            className="grid size-6 place-items-center rounded-full bg-success text-white">
            <Check className="size-3.5" strokeWidth={3} />
          </motion.span>
        )}
        {status === "error" && (
          <motion.span key="error" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={pop}
            className="grid size-6 place-items-center rounded-full bg-destructive text-white">
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
          className="ml-1.5 inline-block rounded-full bg-primary/15 px-1.5 text-xs tabular-nums text-primary"
        >
          {n}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/** Secousse d'erreur : à passer en `animate` quand l'action échoue. */
export const shake = { x: [0, -7, 7, -5, 5, -2, 0], transition: { duration: 0.4 } };

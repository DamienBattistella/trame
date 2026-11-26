import { AnimatePresence, motion } from "motion/react";
import { Check } from "lucide-react";
import { BRAINS } from "@/brands";
import { pop } from "@/components/kit";
import { cn } from "@/lib/utils";

export type BrainId = (typeof BRAINS)[number]["id"];

/** État de connexion affiché dans la carte : prêt, à faire, ou en cours de vérification. */
export type BrainState = { tone: "ok" | "todo" | "wait"; text: string };

export function BrainPicker({
  value,
  onChange,
  size = "lg",
  states,
}: {
  value: BrainId;
  onChange: (v: BrainId) => void;
  size?: "lg" | "md";
  states?: Partial<Record<BrainId, BrainState>>;
}) {
  return (
    <div role="radiogroup" aria-label="Cerveau" className="grid w-full grid-cols-2 gap-3">
      {BRAINS.map(({ id, name, desc, Logo }) => {
        const selected = value === id;
        return (
          <motion.button
            key={id}
            whileTap={{ scale: 0.97 }}
            onClick={() => onChange(id)}
            role="radio"
            aria-checked={selected}
            className={cn(
              "relative flex min-w-0 flex-col items-center gap-1 rounded-2xl border-2 transition-colors duration-200",
              size === "lg" ? "p-5" : "p-4",
              selected ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
            )}
          >
            <AnimatePresence initial={false}>
              {selected && (
                <motion.span
                  key="check"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0 }}
                  transition={pop}
                  className="absolute right-2.5 top-2.5 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground"
                >
                  <Check className="size-3" strokeWidth={3} />
                </motion.span>
              )}
            </AnimatePresence>
            <Logo className={cn(size === "lg" ? "mb-2 size-9" : "mb-1.5 size-7")} />
            <span className={cn("font-semibold", size === "lg" && "text-base")}>{name}</span>
            {states?.[id] ? (
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={`${states[id]!.tone}-${states[id]!.text}`}
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={{ duration: 0.15 }}
                  className={cn(
                    "flex max-w-full items-center gap-1.5 truncate text-xs",
                    states[id]!.tone === "ok" ? "text-success" : "text-muted-foreground"
                  )}
                  title={states[id]!.text}
                >
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      states[id]!.tone === "ok" ? "bg-success" : states[id]!.tone === "todo" ? "bg-warning" : "bg-muted-foreground/50"
                    )}
                  />
                  <span className="truncate">{states[id]!.text}</span>
                </motion.span>
              </AnimatePresence>
            ) : (
              <span className="text-xs text-muted-foreground">{desc}</span>
            )}
          </motion.button>
        );
      })}
    </div>
  );
}

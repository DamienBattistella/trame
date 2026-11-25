import { AnimatePresence, motion } from "motion/react";
import { Check } from "lucide-react";
import { BRAINS } from "@/brands";
import { pop } from "@/components/kit";
import { cn } from "@/lib/utils";

export type BrainId = (typeof BRAINS)[number]["id"];

export function BrainPicker({
  value,
  onChange,
  size = "lg",
}: {
  value: BrainId;
  onChange: (v: BrainId) => void;
  size?: "lg" | "md";
}) {
  return (
    <div className="grid w-full grid-cols-2 gap-3">
      {BRAINS.map(({ id, name, desc, Logo }) => {
        const selected = value === id;
        return (
          <motion.button
            key={id}
            whileTap={{ scale: 0.97 }}
            onClick={() => onChange(id)}
            className={cn(
              "relative flex flex-col items-center gap-1 rounded-2xl border-2 transition-colors duration-200",
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
            <span className="text-xs text-muted-foreground">{desc}</span>
          </motion.button>
        );
      })}
    </div>
  );
}

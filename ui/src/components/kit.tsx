/* Kit partagé : mêmes primitives visuelles pour le wizard ET le panneau. */
import { cn } from "@/lib/utils";

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
        "flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium",
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

export function Segment({
  value,
  onChange,
  disabled,
}: {
  value: "draft" | "auto";
  onChange: (v: "draft" | "auto") => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex rounded-full bg-secondary p-0.5 text-xs font-medium", disabled && "opacity-40")}>
      {(["draft", "auto"] as const).map((v) => (
        <button
          key={v}
          disabled={disabled}
          onClick={() => onChange(v)}
          className={cn(
            "rounded-full px-3 py-1 transition-colors",
            value === v ? "bg-background shadow-sm" : "text-muted-foreground"
          )}
        >
          {v === "draft" ? "Brouillon" : "Auto"}
        </button>
      ))}
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 ml-1 text-sm font-medium text-muted-foreground">{children}</h2>;
}

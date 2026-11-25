import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";

/* L'âme de Trame : un petit fantôme au trait qui porte l'état du dépôt du SOUL.md.
   idle : il flotte et cligne des yeux · drag : il s'approche, yeux grands ouverts ·
   ok : la page tombe en lui et il est content · error : il secoue la tête. */

export type GhostState = "idle" | "drag" | "ok" | "error";

const BODY =
  "M9 27 C9 15.5 15.7 8 24 8 C32.3 8 39 15.5 39 27 V44 Q36.5 49 34 44 Q31.5 49 29 44 Q26.5 49 24 44 Q21.5 49 19 44 Q16.5 49 14 44 Q11.5 49 9 44 Z";

const COLOR: Record<GhostState, string> = {
  idle: "text-link",
  drag: "text-link",
  ok: "text-success",
  error: "text-destructive",
};

const center = { transformBox: "fill-box", transformOrigin: "center" } as const;

export function SoulGhost({ state, size = 76 }: { state: GhostState; size?: number }) {
  const body = {
    idle: { y: [0, -4, 0], rotate: 0, scale: 1, transition: { y: { duration: 3, repeat: 2, ease: "easeInOut" as const } } },
    drag: { y: [-6, -10, -6], rotate: 0, scale: 1.12, transition: { y: { duration: 1.1, repeat: Infinity, ease: "easeInOut" as const }, scale: { type: "spring" as const, stiffness: 300, damping: 15 } } },
    ok: { y: [0, -12, 0, -3, 0], rotate: 0, scale: 1, transition: { y: { duration: 0.9, delay: 0.45, ease: "easeOut" as const } } },
    error: { y: 0, rotate: [0, -12, 10, -7, 4, 0], scale: 1, transition: { rotate: { duration: 0.6 } } },
  }[state];

  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 48 56"
      fill="none"
      aria-hidden="true"
      className={cn("overflow-visible transition-colors duration-300", COLOR[state])}
      animate={body}
      style={center}
    >
      <AnimatePresence>
        {state === "ok" && (
          <motion.g
            key="page"
            initial={{ y: -22, opacity: 1, scale: 1 }}
            animate={{ y: 6, opacity: 0, scale: 0.3 }}
            transition={{ duration: 0.5, ease: "easeIn" }}
            style={center}
          >
            <rect x="19" y="14" width="10" height="13" rx="1.6" fill="var(--background)" stroke="currentColor" strokeWidth="1.6" />
            <path d="M21.5 18.5h5M21.5 21.5h5M21.5 24.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </motion.g>
        )}
      </AnimatePresence>

      <motion.path
        d={BODY}
        fill="currentColor"
        fillOpacity={0.12}
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinejoin="round"
        animate={{ skewX: state === "error" ? 0 : [0, 2.5, 0, -2.5, 0] }}
        transition={{ duration: state === "drag" ? 1.2 : 3.2, repeat: state === "drag" ? Infinity : 2, ease: "easeInOut" }}
        style={{ transformBox: "fill-box", transformOrigin: "50% 0%" }}
      />

      <AnimatePresence mode="popLayout" initial={false}>
        {(state === "idle" || state === "drag") && (
          <motion.g key="open" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {[19, 29].map((cx) => (
              <motion.ellipse
                key={cx}
                cx={cx}
                cy={24}
                fill="currentColor"
                animate={{
                  rx: state === "drag" ? 2.7 : 2,
                  ry: state === "drag" ? 3.4 : 2.7,
                  scaleY: state === "idle" ? [1, 1, 0.12, 1] : 1,
                }}
                transition={{
                  rx: { type: "spring", stiffness: 400, damping: 18 },
                  ry: { type: "spring", stiffness: 400, damping: 18 },
                  scaleY: { duration: 4, times: [0, 0.9, 0.95, 1], repeat: 2 },
                }}
                style={center}
              />
            ))}
            {state === "drag" && (
              <motion.ellipse key="mouth" cx={24} cy={32} rx={2} ry={2.4} fill="currentColor" initial={{ scale: 0 }} animate={{ scale: 1 }} style={center} />
            )}
          </motion.g>
        )}

        {state === "ok" && (
          <motion.g key="happy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ delay: 0.45 }}>
            <path d="M16.5 25 q2.5 -3.4 5 0 M26.5 25 q2.5 -3.4 5 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M20.5 30.5 q3.5 3.2 7 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <circle cx="14.5" cy="29.5" r="1.8" fill="#f472b6" fillOpacity="0.55" />
            <circle cx="33.5" cy="29.5" r="1.8" fill="#f472b6" fillOpacity="0.55" />
          </motion.g>
        )}

        {state === "error" && (
          <motion.g key="cross" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <path d="M17 22 l4 4 M21 22 l-4 4 M27 22 l4 4 M31 22 l-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M20.5 33 q3.5 -2.6 7 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </motion.g>
        )}
      </AnimatePresence>
    </motion.svg>
  );
}

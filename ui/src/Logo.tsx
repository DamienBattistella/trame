import { useId } from "react";
import { motion } from "motion/react";

/* Logo Trame : le T de Trame tracé d'un seul fil, sur fond transparent.
   Le dégradé suit le fil (bleu → cyan). Le cadre est recadré sur le dessin
   pour qu'il reste lisible à 16 px. En mode `animated` (écran de chargement),
   le fil s'écrit d'un seul geste puis son bout se tend et se pose. */

export const LOGO_PATH =
  "M15 19.5 H43 C48.5 19.5 48.5 28.5 43 28.5 H37.5 C34.5 28.5 32 31 32 34 V44.5 C32 48.8 35.3 51 39.5 49.8";

export function Logo({
  size = 32,
  className,
  animated = false,
}: {
  size?: number;
  className?: string;
  animated?: boolean;
}) {
  const grad = `trame-${useId().replace(/:/g, "")}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="9 13.5 44 44"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Trame"
      className={className}
    >
      <defs>
        <linearGradient id={grad} x1="15" y1="19" x2="40" y2="51" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2563eb" />
          <stop offset="1" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
      <motion.g
        {...(animated
          ? { animate: { y: [0, 0, 1.2, 0] }, transition: { duration: 1.6, times: [0, 0.76, 0.87, 1], ease: "easeOut" as const } }
          : {})}
      >
        <motion.path
          d={LOGO_PATH}
          stroke={`url(#${grad})`}
          strokeWidth={7.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          {...(animated
            ? {
                initial: { pathLength: 0, opacity: 0 },
                animate: { pathLength: 1, opacity: 1 },
                transition: {
                  pathLength: { duration: 1.15, ease: "easeInOut" as const, delay: 0.05 },
                  opacity: { duration: 0.01, delay: 0.05 },
                },
              }
            : {})}
        />
      </motion.g>
    </svg>
  );
}

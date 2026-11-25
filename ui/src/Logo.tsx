import { useId } from "react";
import { motion } from "motion/react";

/* Logo Trame : un T tissé. La trame du haut passe PAR-DESSUS la chaîne verticale,
   une seconde trame plus claire passe PAR-DESSOUS — le dessus-dessous du tissage.
   Les « halos » couleur de fond découpent les croisements pour lire l'entrelacs.
   En mode `animated`, les fils se tracent l'un après l'autre (écran de chargement). */

const FROM = "#2563eb";
const TO = "#38bdf8";

type Strand = { d: string; width: number; opacity?: number; halo?: boolean; delay: number };

const STRANDS: Strand[] = [
  { d: "M18 41 H46", width: 5, opacity: 0.75, delay: 0.15 },
  { d: "M32 23 V48", width: 7.5, halo: true, delay: 0.45 },
  { d: "M16 23 H48", width: 7.5, halo: true, delay: 0.8 },
];

export function Logo({
  size = 32,
  className,
  animated = false,
}: {
  size?: number;
  className?: string;
  animated?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const grad = `trame-${id}`;
  const draw = (delay: number) =>
    animated
      ? {
          initial: { pathLength: 0, opacity: 0 },
          animate: { pathLength: 1, opacity: 1 },
          transition: { pathLength: { duration: 0.55, ease: "easeInOut" as const, delay }, opacity: { duration: 0.01, delay } },
        }
      : {};

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Trame"
      className={className}
    >
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop stopColor={FROM} />
          <stop offset="1" stopColor={TO} />
        </linearGradient>
      </defs>
      <motion.rect
        width="64"
        height="64"
        rx="15"
        fill={`url(#${grad})`}
        {...(animated
          ? { initial: { scale: 0.6, opacity: 0 }, animate: { scale: 1, opacity: 1 }, transition: { type: "spring", stiffness: 260, damping: 20 } }
          : {})}
        style={{ transformOrigin: "32px 32px" }}
      />
      {STRANDS.map((s, i) => (
        <g key={i}>
          {s.halo && (
            <motion.path d={s.d} stroke={`url(#${grad})`} strokeWidth={s.width + 3.5} strokeLinecap="round" {...draw(s.delay)} />
          )}
          <motion.path d={s.d} stroke="#fff" strokeOpacity={s.opacity ?? 1} strokeWidth={s.width} strokeLinecap="round" {...draw(s.delay)} />
        </g>
      ))}
    </svg>
  );
}

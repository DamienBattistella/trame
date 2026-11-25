export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Trame"
    >
      <defs>
        <linearGradient id="dta-grad" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2563eb" />
          <stop offset="1" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#dta-grad)" />
      {/* speech bubble (Teams) with a tail bottom-left */}
      <path
        d="M14 14h36a6 6 0 0 1 6 6v18a6 6 0 0 1-6 6H26l-9 8v-8h-3a6 6 0 0 1-6-6V20a6 6 0 0 1 6-6z"
        fill="#ffffff"
      />
      {/* Greek meander / labyrinth (Dedalus) inside the bubble */}
      <path
        d="M20 36V21h24v15h-9v-9h-6v6"
        fill="none"
        stroke="url(#dta-grad)"
        strokeWidth="3.4"
        strokeLinejoin="miter"
        strokeLinecap="butt"
      />
    </svg>
  );
}

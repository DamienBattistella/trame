/* Jeu d'icônes sur-mesure (duotone, pleines) pour Trame. currentColor hérite de
   l'accent du conteneur. Deux niveaux d'opacité pour la profondeur. */
type P = { className?: string };
const SVG = ({ children, className }: P & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    {children}
  </svg>
);

// Choix du cerveau — étincelle IA
export const BrainIcon = ({ className }: P) => (
  <SVG className={className}>
    <path
      opacity="0.3"
      d="M11.2 2.6a.9.9 0 0 1 1.6 0l1.5 3.4a3 3 0 0 0 1.7 1.7l3.4 1.5a.9.9 0 0 1 0 1.6l-3.4 1.5a3 3 0 0 0-1.7 1.7l-1.5 3.4a.9.9 0 0 1-1.6 0l-1.5-3.4a3 3 0 0 0-1.7-1.7L4.6 10.8a.9.9 0 0 1 0-1.6l3.4-1.5a3 3 0 0 0 1.7-1.7l1.5-3.4Z"
      fill="currentColor"
    />
    <circle cx="18.5" cy="5.5" r="2.2" fill="currentColor" />
  </SVG>
);

// Test — bulle avec lignes de texte (lecture)
export const ScanIcon = ({ className }: P) => (
  <SVG className={className}>
    <path opacity="0.3" d="M3 6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-4.3 3.4A1 1 0 0 1 3 18.6V6Z" fill="currentColor" />
    <path d="M7 8h10M7 11.5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </SVG>
);

// Watchlist — deux personnes
export const PeopleIcon = ({ className }: P) => (
  <SVG className={className}>
    <circle opacity="0.3" cx="9" cy="8" r="4" fill="currentColor" />
    <path opacity="0.3" d="M2.5 19.5a6.5 6.5 0 0 1 13 0 1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" fill="currentColor" />
    <circle cx="17.5" cy="9" r="3" fill="currentColor" />
    <path d="M16 14.2a5.5 5.5 0 0 1 5.5 5.3 1 1 0 0 1-1 1H18" fill="currentColor" />
  </SVG>
);

// Modes — crayon (brouillon)
export const PencilIcon = ({ className }: P) => (
  <SVG className={className}>
    <path opacity="0.3" d="M3 17.3V21h3.7l9.1-9.1-3.7-3.7L3 17.3Z" fill="currentColor" />
    <path d="M18.7 9.1a1.5 1.5 0 0 0 0-2.1l-1.7-1.7a1.5 1.5 0 0 0-2.1 0l-1.6 1.6 3.7 3.7 1.7-1.5Z" fill="currentColor" />
  </SVG>
);

// Persona — ondes de voix dans une bulle
export const VoiceIcon = ({ className }: P) => (
  <SVG className={className}>
    <path opacity="0.3" d="M3 6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-4.3 3.4A1 1 0 0 1 3 18.6V6Z" fill="currentColor" />
    <path d="M8 8.5v4M11 6.5v8M14 8v3M17 9.5v1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </SVG>
);

// GitHub — branche
export const BranchIcon = ({ className }: P) => (
  <SVG className={className}>
    <circle cx="6" cy="5" r="2.4" fill="currentColor" />
    <circle cx="6" cy="19" r="2.4" fill="currentColor" />
    <circle cx="18" cy="7" r="2.4" fill="currentColor" />
    <path opacity="0.5" d="M6 7.4v9.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path opacity="0.5" d="M18 9.4c0 4-4 3.6-6 5.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
  </SVG>
);

// Prêt — coche dans un cercle
export const ReadyIcon = ({ className }: P) => (
  <SVG className={className}>
    <circle opacity="0.3" cx="12" cy="12" r="9.5" fill="currentColor" />
    <path d="M8 12.3l2.6 2.6 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </SVG>
);

/* Jeu d'icônes sur-mesure (duotone, pleines) pour Trame. currentColor hérite de
   l'accent du conteneur. Deux niveaux d'opacité pour la profondeur. */
type P = { className?: string };
const SVG = ({ children, className }: P & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    {children}
  </svg>
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

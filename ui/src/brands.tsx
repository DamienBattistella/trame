import { siClaude, siGithub, siGithubcopilot } from "simple-icons";

type Props = { className?: string };

function Mark({ path, title, color, className }: Props & { path: string; title: string; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label={title} className={className} fill={color ?? "currentColor"}>
      <path d={path} />
    </svg>
  );
}

export const ClaudeLogo = ({ className }: Props) => (
  <Mark path={siClaude.path} title={siClaude.title} color={`#${siClaude.hex}`} className={className} />
);

export const CopilotLogo = ({ className }: Props) => (
  <Mark path={siGithubcopilot.path} title={siGithubcopilot.title} className={className} />
);

export const GithubLogo = ({ className }: Props) => (
  <Mark path={siGithub.path} title={siGithub.title} className={className} />
);

/** Marque Microsoft Teams simplifiée (simple-icons ne la fournit plus) : carré violet, T blanc, deux têtes. */
export const TeamsLogo = ({ className }: Props) => (
  <svg viewBox="0 0 24 24" role="img" aria-label="Microsoft Teams" className={className}>
    <circle cx="19.2" cy="5.6" r="2.4" fill="#5059C9" />
    <path d="M16.4 9.2h5.1c.8 0 1.5.7 1.5 1.5v4.6a3.6 3.6 0 0 1-3.6 3.6h-.2a3.6 3.6 0 0 1-2.8-1.4z" fill="#5059C9" />
    <circle cx="13.2" cy="4.6" r="3.2" fill="#7B83EB" />
    <path d="M8.4 9.2h8.4c.7 0 1.2.5 1.2 1.2v6a5.8 5.8 0 0 1-11.2 2z" fill="#7B83EB" />
    <rect x="1" y="6.4" width="12" height="12" rx="2" fill="#4B53BC" />
    <path d="M10.2 9.4H3.8v1.7h2.3v6.2h1.8v-6.2h2.3z" fill="#fff" />
  </svg>
);

export const BRAINS = [
  { id: "claude", name: "Claude", desc: "via ton abonnement", Logo: ClaudeLogo },
  { id: "copilot", name: "Copilot", desc: "via GitHub", Logo: CopilotLogo },
] as const;

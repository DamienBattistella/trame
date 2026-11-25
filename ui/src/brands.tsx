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

export const BRAINS = [
  { id: "claude", name: "Claude", desc: "via ton abonnement", Logo: ClaudeLogo },
  { id: "copilot", name: "Copilot", desc: "via GitHub", Logo: CopilotLogo },
] as const;

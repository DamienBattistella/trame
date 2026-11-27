import type { SkillsSummary } from "@/types";

/** Mode démo : skills fictifs, écrits pour l'exemple. Rien n'est lu sur le disque. */
export const demoSkills = (): SkillsSummary => ({
  ownDir: String.raw`C:\Users\vous\AppData\Roaming\Trame\skills`,
  dirs: ["~/.agents/skills"],
  repos: [],
  autoUpdateHours: 6,
  sources: [
    { label: "Trame", path: String.raw`C:\Users\vous\AppData\Roaming\Trame\skills`, exists: true, defaultOn: true },
    { label: "~/.agents/skills", path: String.raw`C:\Users\vous\.agents\skills`, exists: true, defaultOn: false },
  ],
  skills: [
    {
      name: "relecture-pr",
      description:
        "Répondre à une demande de relecture de pull request : s'engager sur un créneau précis et citer le numéro de la PR. À utiliser quand un message demande une review, une relecture ou un avis sur une PR.",
      source: "Trame",
      path: "",
      version: "1.0.0",
      size: 1840,
      enabled: true,
      hasScripts: false,
      scripts: [],
      references: [],
    },
    {
      name: "typographie-francaise",
      description:
        "Règles de typographie française pour les messages : espaces insécables, guillemets « », apostrophe typographique. À utiliser pour corriger ou relire un texte en français.",
      source: "Trame",
      path: "",
      version: "1.2.0",
      size: 2310,
      enabled: true,
      hasScripts: false,
      scripts: [],
      references: ["reference/exemples.md"],
    },
    {
      name: "compte-rendu-reunion",
      description:
        "Rédige un compte-rendu de réunion à partir d'une transcription (.vtt) : décisions, actions, responsables. À utiliser quand on demande un compte-rendu ou un résumé de réunion.",
      source: "~/.agents/skills",
      path: "",
      version: "0.3.0",
      size: 5120,
      enabled: false,
      hasScripts: true,
      scripts: ["scripts/extraire_participants.py"],
      references: ["reference/modele.md"],
    },
  ],
  ignored: [{ folder: "brouillon-sans-nom", source: "~/.agents/skills", reason: "champ name manquant" }],
  limits: { skillKb: 64, fileKb: 64, maxActive: 40 },
});

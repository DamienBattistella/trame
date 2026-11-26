/** Ce qu'un SOUL.md apporte réellement à Trame : analyse locale, instantanée, sans appel au cerveau. */
export type Aspect = { id: string; label: string; found: boolean; hint: string };
export type Quality = "complet" | "correct" | "a-completer";

const RULES: { id: string; label: string; re: RegExp; hint: string }[] = [
  { id: "role", label: "Ton rôle", re: /\b(r[ôo]le|poste|m[ée]tier|fonction|je suis|je travaille|job|role)\b/i, hint: "Dis qui tu es et ce que tu fais." },
  { id: "tone", label: "Ton et style", re: /\b(ton|style|registre|voix|tone|voice|direct|chaleureu|formel|familier)/i, hint: "Décris ta façon d'écrire." },
  { id: "address", label: "Tu ou vous", re: /\b(tutoi|vouvoi|tutoyer|vouvoyer)|\btu\b[^.\n]{0,40}\bvous\b/i, hint: "Précise quand tu tutoies ou vouvoies." },
  { id: "length", label: "Longueur", re: /\b(court|courte|concis|bref|br[èe]ve|longueur|phrases?|lignes?|mots|short|concise)\b/i, hint: "Indique la longueur visée des réponses." },
  { id: "limits", label: "Limites", re: /\b(refus|jamais|ne (?:jamais|pas)|interdit|[ée]vite|never|avoid|limite|pas de|sans)\b/i, hint: "Liste ce que Trame doit refuser ou éviter." },
  { id: "examples", label: "Exemples", re: /(exemple|example|^\s*>\s|```)/im, hint: "Ajoute 2 ou 3 messages types écrits par toi." },
];

export function analyzeSoul(content: string): { aspects: Aspect[]; score: number; quality: Quality; words: number } {
  const aspects = RULES.map((r) => ({ id: r.id, label: r.label, found: r.re.test(content), hint: r.hint }));
  const score = aspects.filter((a) => a.found).length;
  const quality: Quality = score >= 5 ? "complet" : score >= 3 ? "correct" : "a-completer";
  const words = (content.match(/\S+/g) ?? []).length;
  return { aspects, score, quality, words };
}

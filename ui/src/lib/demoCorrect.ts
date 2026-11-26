// Correction de démonstration (sans moteur) : quelques fautes courantes et la
// typographie française, sans toucher aux liens, mentions, code et emoji.
const NBSP = " ";
const PROTECTED = /```[\s\S]*?```|`[^`\n]+`|(?:https?:\/\/|www\.)\S+|@[\w-]+(?:\.[\w-]+)*|:[a-z0-9_+-]+:|\p{Extended_Pictographic}️?|[:;]-?[)(DPp](?!\w)/gu;
const TYPOS: Record<string, string> = {
  ca: "ça", Ca: "Ça", "sa va": "ça va", demian: "demain", biensur: "bien sûr", bientot: "bientôt", deja: "déjà",
  apres: "après", tres: "très", probleme: "problème", reunion: "réunion", voila: "voilà", "peut etre": "peut-être",
  jai: "j’ai", Jai: "J’ai", quil: "qu’il",
};
const TYPO = new RegExp(`(?<![\\p{L}'’])(${Object.keys(TYPOS).sort((x, y) => y.length - x.length).join("|")})(?![\\p{L}'’])`, "gu");

const plain = (s: string) =>
  s
    .replace(TYPO, (w) => TYPOS[w])
    .replace(/\s*"([^"\n]+)"/g, (_m, inner: string) => ` «${NBSP}${inner.trim()}${NBSP}»`)
    .replace(/(?<=\p{L})'(?=\p{L})/gu, "’")
    .replace(/[ \t]+([;:!?])(?=\s|$|[;:!?])/g, `${NBSP}$1`)
    .replace(/(?<=[^\s;:!? ])([;:!?])(?=\s|$)/g, `${NBSP}$1`)
    .replace(/([.!?]\s+|\n)(\p{Ll})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase());

export function demoCorrect(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(PROTECTED)) {
    out += plain(text.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  out = (out + plain(text.slice(last))).trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// Catalogue d'emoji : tout Unicode, avec la clé de réaction Teams quand Teams en a une.
// Données : src/data/emoji.json, généré par scripts/teams-emoji-keys.py.

/** Une ligne du catalogue : [groupe, emoji, nom, mots-clés, clé Teams ou "", version Unicode,
 *  clé Teams qui prend une teinte ou "", teintes de peau 1 à 5 si l'emoji en a]. */
export type EmojiRow = [number, string, string, string, string, number, string, string[]?];

export interface EmojiCatalogData {
  groups: string[];
  emoji: EmojiRow[];
}

export interface Emoji {
  group: number;
  emoji: string;
  name: string;
  /** Nom et mots-clés pliés (sans accents ni casse), pour la recherche. */
  search: string;
  /** Nom seul, plié : un emoji dont le nom répond passe avant ceux trouvés par mot-clé. */
  nameFold: string;
  /** Clé de réaction Teams ; "" quand Teams ne l'accepte pas en réaction. */
  teamsKey: string;
  version: number;
  /** La clé Teams qui prend une teinte (« yes » pour 👍, dont la clé simple est « like »). */
  toneKey: string;
  skins?: string[];
}

/** 0 : sans teinte ; 1 à 5 : de la plus claire à la plus foncée (🏻 à 🏿). */
export type SkinTone = 0 | 1 | 2 | 3 | 4 | 5;
export const SKIN_TONES: { tone: SkinTone; swatch: string; label: string }[] = [
  { tone: 0, swatch: "✋", label: "Sans teinte" },
  { tone: 1, swatch: "✋🏻", label: "Peau claire" },
  { tone: 2, swatch: "✋🏼", label: "Peau moyennement claire" },
  { tone: 3, swatch: "✋🏽", label: "Peau légèrement mate" },
  { tone: 4, swatch: "✋🏾", label: "Peau mate" },
  { tone: 5, swatch: "✋🏿", label: "Peau foncée" },
];

export const foldText = (s: string) =>
  s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

export function decodeCatalog(data: EmojiCatalogData): { groups: string[]; emoji: Emoji[] } {
  return {
    groups: data.groups,
    emoji: data.emoji.map(([group, emoji, name, keywords, teamsKey, version, tones, skins]) => ({
      group,
      emoji,
      name,
      search: foldText(`${name} ${keywords}`),
      nameFold: foldText(name),
      teamsKey,
      version,
      toneKey: tones,
      ...(skins ? { skins } : {}),
    })),
  };
}

const startsWord = (text: string, w: string) => text.startsWith(w) || text.includes(` ${w}`);

/** Les emoji dont chaque mot de la requête commence un mot du nom ou des mots-clés : ceux dont
 *  le nom commence par la requête d'abord, puis ceux dont le nom la contient, puis les autres. */
export function searchEmoji(list: Emoji[], query: string): Emoji[] {
  const q = foldText(query);
  const words = q.split(" ").filter(Boolean);
  if (!words.length) return list;
  const rank = (e: Emoji) => (e.nameFold.startsWith(q) ? 0 : words.every((w) => startsWord(e.nameFold, w)) ? 1 : 2);
  return list
    .filter((e) => words.every((w) => startsWord(e.search, w)))
    .map((e, i) => ({ e, r: rank(e), i }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.e);
}

/** Le caractère à insérer, avec la teinte choisie quand l'emoji en prend une. */
export const withTone = (e: Emoji, tone: SkinTone) => (tone && e.skins?.[tone - 1]) || e.emoji;

/** La clé de réaction Teams, avec la teinte (« yes-tone1 ») quand Teams la prend ; null si Teams
 *  n'accepte pas cet emoji en réaction. */
export function reactionKey(e: Emoji, tone: SkinTone): string | null {
  if (!e.teamsKey) return null;
  return tone && e.toneKey && e.skins ? `${e.toneKey}-tone${tone}` : e.teamsKey;
}

/** Les emoji que la police du système sait dessiner : un emoji trop récent pour elle
 *  s'afficherait en carré vide ou en glyphes séparés. Seuls les emoji récents (Emoji 13 et
 *  plus) sont testés ; les drapeaux, que Windows écrit en deux lettres, restent. */
export function drawable(list: Emoji[], flagsGroup: number, canDraw: (emoji: string) => boolean): Emoji[] {
  return list.filter((e) => e.version < 13 || e.group === flagsGroup || canDraw(e.emoji));
}

/** Test de dessin sur canvas pour drawable (navigateur uniquement). Un emoji couleur dessine
 *  des pixels colorés ; un caractère inconnu, un carré monochrome ; une séquence inconnue,
 *  plusieurs glyphes côte à côte, donc plus large. */
export function canvasCanDraw(): (emoji: string) => boolean {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return () => true;
  ctx.font = "24px 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif";
  ctx.textBaseline = "top";
  const ref = ctx.measureText("😀").width;
  return (emoji) => {
    if (ctx.measureText(emoji).width > ref * 1.5) return false;
    ctx.clearRect(0, 0, 32, 32);
    ctx.fillStyle = "#000";
    ctx.fillText(emoji, 0, 0);
    const px = ctx.getImageData(0, 0, 32, 32).data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] > 0 && (px[i] !== px[i + 1] || px[i + 1] !== px[i + 2])) return true;
    }
    return false;
  };
}

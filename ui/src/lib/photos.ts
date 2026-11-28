/* Photos des personnes (data URL), lues par le moteur sur la liste de Teams et servies
   par /api/photos. Chaque avatar les retrouve par le nom affiché, où qu'il soit : liste,
   fil, auteurs d'un groupe, réunions. */
import { useSyncExternalStore } from "react";

/** Clé d'un nom : sans accents ni casse, sans précision entre parenthèses ou crochets
 *  (« (Externe) »), mots triés : « Martin, Ana », « MARTIN Ana » et « Ana Martin » sont
 *  la même personne. */
export function photoKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[([][^)\]]*[)\]]/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .sort()
    .join(" ");
}

let photos = new Map<string, string>();
const listeners = new Set<() => void>();

/** Remplace toutes les photos connues (nom affiché -> data URL). */
export function setPhotos(byName: Record<string, string>) {
  const next = new Map<string, string>();
  for (const [name, url] of Object.entries(byName)) {
    const key = photoKey(name);
    if (key && typeof url === "string" && /^data:image\/(png|jpeg);base64,/.test(url)) next.set(key, url);
  }
  photos = next;
  for (const l of listeners) l();
}

export function photoOf(name: string): string | null {
  return photos.get(photoKey(name)) ?? null;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** La photo d'une personne, mise à jour dès que le moteur en lit une. */
export function usePhoto(name: string): string | null {
  return useSyncExternalStore(subscribe, () => photoOf(name), () => null);
}

import type { AttachmentLimits, PendingFile } from "@/types";

/** Limites par défaut, identiques à celles du moteur (backend/attachments.py). */
export const DEFAULT_LIMITS: AttachmentLimits = {
  canAttach: true,
  unsupported: null,
  maxFiles: 3,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 15 * 1024 * 1024,
  extensions: ["pdf", "txt", "md", "csv", "log", "json", "xml", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "png", "jpg", "jpeg", "gif", "webp", "zip"],
};

export function humanSize(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "").replace(".", ",")} Mo`;
}

const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

/** Résumé des limites, affiché sous les fichiers et dans l'infobulle de « Joindre ». */
export function limitsText(l: AttachmentLimits): string {
  return `${l.maxFiles} fichiers au plus, ${humanSize(l.maxFileBytes)} chacun (${humanSize(l.maxTotalBytes)} au total) · ${l.extensions.join(", ")}`;
}

/** Valeur de l'attribut accept du sélecteur de fichiers. */
export const acceptOf = (l: AttachmentLimits) => l.extensions.map((e) => `.${e}`).join(",");

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Ajoute aux fichiers déjà choisis ceux que les limites acceptent ; seuls ceux-là sont lus.
 *  Rend aussi la raison de chaque refus, à montrer telle quelle. */
export async function addFiles(
  current: PendingFile[],
  picked: File[],
  l: AttachmentLimits
): Promise<{ files: PendingFile[]; refused: string[] }> {
  const files = [...current];
  const refused: string[] = [];
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of picked) {
    if (!l.extensions.includes(extOf(f.name))) refused.push(`« ${f.name} » : type de fichier non autorisé`);
    else if (f.size === 0) refused.push(`« ${f.name} » est vide`);
    else if (f.size > l.maxFileBytes) refused.push(`« ${f.name} » dépasse ${humanSize(l.maxFileBytes)}`);
    else if (files.length >= l.maxFiles) refused.push(`« ${f.name} » : ${l.maxFiles} fichiers au plus`);
    else if (total + f.size > l.maxTotalBytes) refused.push(`« ${f.name} » : plus de ${humanSize(l.maxTotalBytes)} au total`);
    else if (files.some((x) => x.name === f.name && x.size === f.size)) continue;
    else {
      try {
        const data = await readBase64(f);
        files.push({ id: `${Date.now()}-${files.length}-${f.name}`, name: f.name, size: f.size, type: f.type, data });
        total += f.size;
      } catch {
        refused.push(`« ${f.name} » : illisible`);
      }
    }
  }
  return { files, refused };
}

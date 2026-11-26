export type DiffPart = { kind: "same" | "del" | "ins"; text: string };

// Mots, espaces (insécables comprises) et ponctuation séparés : « ca » → « ça »
// ou une espace ajoutée avant « ? » ressortent seuls.
const TOKEN = /\s+|[\p{L}\p{N}_’'-]+|[^\s\p{L}\p{N}_]/gu;
// Au-delà, le calcul serait lent pour rien : avant / après en bloc.
const MAX_CELLS = 4_000_000;

/** Différences mot à mot entre le texte d'origine et sa correction. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  if (a.length * b.length > MAX_CELLS) return [{ kind: "del", text: before }, { kind: "ins", text: after }];
  // Plus longue sous-suite commune, remplie depuis la fin.
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push("same", a[i++]);
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) push("ins", b[j++]);
    else push("del", a[i++]);
  }
  // Dans chaque passage modifié, tout le barré puis tout l'ajouté : « ca » puis « ça ».
  const out: DiffPart[] = [];
  for (let k = 0; k < parts.length; ) {
    if (parts[k].kind === "same") {
      out.push(parts[k++]);
      continue;
    }
    let del = "";
    let ins = "";
    for (; k < parts.length && parts[k].kind !== "same"; k++) parts[k].kind === "del" ? (del += parts[k].text) : (ins += parts[k].text);
    if (del) out.push({ kind: "del", text: del });
    if (ins) out.push({ kind: "ins", text: ins });
  }
  return out;
}

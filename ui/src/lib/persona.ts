/** Le SOUL.md tel que le moteur le lit : sections, versions et apprentissage. */
export type SoulSection = {
  heading: string;
  level: number;
  body: string;
  rules: number;
  examples: number;
  learned: boolean;
};
export type SoulSource =
  "initial" | "manuel" | "appris" | "restauré" | "assistant";
export type SoulVersion = {
  id: string;
  at: string;
  source: SoulSource;
  note: string;
  size: number;
};
export type SoulSignal = {
  at: string;
  kind: "corrigé" | "accepté" | "rejeté" | "écrit";
  conversation: string;
  proposal: string;
  final: string;
};
export type SoulLearning = {
  enabled: boolean;
  every: number;
  running: boolean;
  pending: number;
  informative: number;
  total: number;
  lastAt: string | null;
  lastRunAt: string | null;
  lastResult: {
    changed: boolean;
    added: string[];
    removed: string[];
    signals: number;
  } | null;
  recent: SoulSignal[];
};
export type SoulDetails = {
  content: string;
  custom: boolean;
  title: string;
  sections: SoulSection[];
  history: SoulVersion[];
  learning: SoulLearning;
};

export function mapSoulDetails(raw: any): SoulDetails {
  const l = raw?.learning ?? {};
  return {
    content: String(raw?.content ?? ""),
    custom: Boolean(raw?.custom),
    title: String(raw?.parsed?.title ?? ""),
    sections: (raw?.parsed?.sections ?? []) as SoulSection[],
    history: (raw?.history ?? []) as SoulVersion[],
    learning: {
      enabled: l.enabled !== false,
      every: Number(l.every ?? 8),
      running: Boolean(l.running),
      pending: Number(l.pending ?? 0),
      informative: Number(l.informative ?? 0),
      total: Number(l.total ?? 0),
      lastAt: l.last_at ?? null,
      lastRunAt: l.last_run_at ?? null,
      lastResult: l.last_result ?? null,
      recent: (l.recent ?? []) as SoulSignal[],
    },
  };
}

/** Lignes ajoutées et retirées entre deux versions (plus longue sous-suite commune). */
export type DiffLine = { kind: "same" | "add" | "del"; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1])
      out.push({ kind: "del", text: a[i++] });
    else out.push({ kind: "add", text: b[j++] });
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

const DEMO_SOUL =
  "# SOUL — Toi\n\n## Ton et style\n- Direct et cordial, sans formules toutes faites.\n\n## Tu ou vous\n- Je tutoie mon équipe ; je vouvoie les clients.\n\n## Ce que Trame doit refuser\n- Jamais d'engagement de date à ma place.\n\n## Exemples de messages écrits par moi\n> Je regarde ça ce soir et je te dis.\n\n## Appris des conversations\n\n_Tenue à jour par Trame d'après tes corrections et tes messages ; tes autres sections priment._\n\n- Réponses d'une ou deux phrases, sans formule d'ouverture.\n- « Merci ! » pour clore plutôt que « Cordialement ».\n";

export function demoSoulDetails(): SoulDetails {
  const sections: SoulSection[] = DEMO_SOUL.split(/\n(?=## )/)
    .slice(1)
    .map((chunk) => {
      const [head, ...rest] = chunk.split("\n");
      const body = rest.join("\n").trim();
      const heading = head.replace(/^##\s+/, "");
      return {
        heading,
        level: 2,
        body,
        rules: body.split("\n").filter((x) => /^\s*[-*+]\s+\S/.test(x)).length,
        examples: body.split("\n").filter((x) => x.trimStart().startsWith(">"))
          .length,
        learned: heading === "Appris des conversations",
      };
    });
  const day = (d: number) =>
    new Date(Date.now() - d * 86400000).toISOString().slice(0, 19);
  return {
    content: DEMO_SOUL,
    custom: true,
    title: "SOUL — Toi",
    sections,
    history: [
      {
        id: "20261126-180000-000",
        at: day(1),
        source: "appris",
        note: "2 ajoutée(s), 0 retirée(s), d'après 9 échange(s)",
        size: 640,
      },
      {
        id: "20261120-090000-000",
        at: day(7),
        source: "manuel",
        note: "",
        size: 420,
      },
      {
        id: "20261118-090000-000",
        at: day(9),
        source: "initial",
        note: "Version trouvée au démarrage",
        size: 380,
      },
    ],
    learning: {
      enabled: true,
      every: 8,
      running: false,
      pending: 3,
      informative: 3,
      total: 12,
      lastAt: day(1),
      lastRunAt: day(1),
      lastResult: {
        changed: true,
        added: ["Réponses d'une ou deux phrases, sans formule d'ouverture."],
        removed: [],
        signals: 9,
      },
      recent: [
        {
          at: day(0),
          kind: "corrigé",
          conversation: "Chloé Julenon",
          proposal: "Bonjour Chloé, je vais regarder cela rapidement.",
          final: "Je regarde ça ce soir.",
        },
        {
          at: day(0),
          kind: "écrit",
          conversation: "Équipe Interop",
          proposal: "",
          final: "Merci ! Je prends la suite.",
        },
        {
          at: day(0),
          kind: "rejeté",
          conversation: "Christophe Francis",
          proposal: "Je te confirme la livraison vendredi.",
          final: "",
        },
      ],
    },
  };
}

/** Le diff resserré autour des changements : `context` lignes identiques de part et d'autre, le reste replié. */
export type DiffRow = DiffLine | { kind: "skip"; count: number };

export function foldDiff(lines: DiffLine[], context = 2): DiffRow[] {
  const near = lines.map((_, i) =>
    lines
      .slice(Math.max(0, i - context), i + context + 1)
      .some((x) => x.kind !== "same"),
  );
  const out: DiffRow[] = [];
  lines.forEach((line, i) => {
    if (line.kind !== "same" || near[i]) return void out.push(line);
    const last = out[out.length - 1];
    if (last && last.kind === "skip") last.count++;
    else out.push({ kind: "skip", count: 1 });
  });
  return out;
}

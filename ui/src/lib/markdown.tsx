import { Fragment, type ReactNode } from "react";

/**
 * Markdown simple rendu en éléments React (jamais de HTML injecté) : titres, listes,
 * tableaux, citations, blocs de code, gras, italique, code et liens http(s).
 * Suffit pour un compte-rendu ; le texte reste copiable tel quel à côté.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={className}>{blocks(text)}</div>;
}

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k} className="rounded bg-muted px-1 font-mono text-[0.9em]">{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(m[2].slice(2, -2), i)}</strong>);
    else if (m[3]) out.push(<em key={k}>{m[3].slice(1, -1)}</em>);
    else if (m[4]) {
      const label = m[4].slice(1, m[4].indexOf("]("));
      out.push(
        <a key={k} href={m[5]} target="_blank" rel="noreferrer noopener" className="text-link underline underline-offset-2">
          {label}
        </a>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      out.push(<pre key={k++} className="my-2 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs">{code.join("\n")}</pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const size = ["text-xl", "text-lg", "text-base", "text-sm", "text-sm", "text-sm"][h[1].length - 1];
      out.push(<p key={k++} role="heading" aria-level={h[1].length} className={`mt-4 mb-1.5 font-semibold first:mt-0 ${size}`}>{inline(h[2])}</p>);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        <div key={k++} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>{head.map((c, j) => <th key={j} className="border-b px-2 py-1 text-left font-medium">{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>{r.map((c, j) => <td key={j} className="border-b border-border/50 px-2 py-1 align-top">{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={k++} className={`my-1.5 flex flex-col gap-0.5 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>
          {items.map((it, n) => {
            const box = /^\[( |x|X)\]\s+(.*)$/.exec(it);
            return <li key={n}>{box ? <Fragment>{box[1] === " " ? "☐ " : "☑ "}{inline(box[2])}</Fragment> : inline(it)}</li>;
          })}
        </List>
      );
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) quote.push(lines[i++].replace(/^>\s?/, ""));
      out.push(<blockquote key={k++} className="my-2 border-l-2 pl-3 text-muted-foreground">{inline(quote.join(" "))}</blockquote>);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      out.push(<hr key={k++} className="my-3" />);
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i]))
      para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(<p key={k++} className="my-1.5 leading-relaxed">{inline(para.join(" "))}</p>);
  }
  return out;
}

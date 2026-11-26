// Mini-DOM pour les tests : juste ce que lit messageParts (nodeType, tagName, childNodes,
// getAttribute), construit à partir d'un fragment HTML bien formé. Sans dépendance.

export type MiniNode = MiniElement | MiniText;
export interface MiniText {
  nodeType: 3;
  data: string;
}
export interface MiniElement {
  nodeType: 1;
  tagName: string;
  attributes: Record<string, string>;
  childNodes: MiniNode[];
  getAttribute(name: string): string | null;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

function element(tagName: string, attributes: Record<string, string>): MiniElement {
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    attributes,
    childNodes: [],
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
  };
}

/** Racine (un <div> sans attribut) contenant le fragment. Commentaires ignorés. */
export function parse(html: string): MiniElement {
  const root = element("div", {});
  const stack: MiniElement[] = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  // Comme un navigateur : fins de ligne normalisées (le dépôt peut extraire le fragment en CRLF).
  for (const m of html.replace(/\r\n?/g, "\n").matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const name = m[1].toUpperCase();
      const at = stack.map((e) => e.tagName).lastIndexOf(name);
      if (at > 0) stack.length = at;
    } else if (m[2]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[3] || "").matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
      }
      const el = element(m[2], attrs);
      top.childNodes.push(el);
      if (!m[4] && !VOID.has(m[2].toLowerCase())) stack.push(el);
    } else if (m[5]) {
      top.childNodes.push({ nodeType: 3, data: decode(m[5]) });
    }
  }
  return root;
}

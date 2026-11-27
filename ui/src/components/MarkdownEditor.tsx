import { useEffect, useRef } from "react";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo,
} from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import {
  Bold,
  Heading2,
  Italic,
  Link,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Search,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Entoure la sélection (ou le mot vide) d'un marqueur ; l'enlève s'il y est déjà. */
function wrap(view: EditorView, mark: string) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const word = range.empty ? view.state.wordAt(range.head) : null;
      if (range.empty && !word)
        return {
          changes: { from: range.from, insert: mark + mark },
          range: EditorSelection.cursor(range.from + mark.length),
        };
      const { from, to } = word ?? range;
      const doc = view.state.doc;
      const before = doc.sliceString(from - mark.length, from);
      const after = doc.sliceString(to, to + mark.length);
      if (before === mark && after === mark)
        return {
          changes: [
            { from: from - mark.length, to: from, insert: "" },
            { from: to, to: to + mark.length, insert: "" },
          ],
          range: EditorSelection.range(from - mark.length, to - mark.length),
        };
      return {
        changes: [
          { from, insert: mark },
          { from: to, insert: mark },
        ],
        range: EditorSelection.range(from + mark.length, to + mark.length),
      };
    }),
  );
  view.focus();
  return true;
}

/** Bascule un préfixe de ligne (« ## », « - », « > », « 1. ») sur chaque ligne sélectionnée. */
function linePrefix(view: EditorView, prefix: string, pattern: RegExp) {
  const { state } = view;
  const seen = new Set<number>();
  const changes: { from: number; to: number; insert: string }[] = [];
  const lines = state.selection.ranges.flatMap((r) => {
    const out = [];
    for (let pos = r.from; pos <= r.to; ) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        out.push(line);
      }
      pos = line.to + 1;
    }
    return out;
  });
  const allHave = lines.every((l) => pattern.test(l.text));
  lines.forEach((line, i) => {
    const m = line.text.match(pattern);
    if (allHave && m)
      changes.push({ from: line.from, to: line.from + m[0].length, insert: "" });
    else {
      const strip = line.text.match(/^(#{1,6}\s+|[-*+]\s+|>\s?|\d+\.\s+)/);
      const p = prefix === "1. " ? `${i + 1}. ` : prefix;
      changes.push({
        from: line.from,
        to: line.from + (strip ? strip[0].length : 0),
        insert: p,
      });
    }
  });
  view.dispatch({ changes });
  view.focus();
  return true;
}

function insertLink(view: EditorView) {
  view.dispatch(
    view.state.changeByRange(({ from, to }) => {
      const label = view.state.doc.sliceString(from, to) || "texte";
      const insert = `[${label}](url)`;
      const urlFrom = from + label.length + 3;
      return {
        changes: { from, to, insert },
        range: EditorSelection.range(urlFrom, urlFrom + 3),
      };
    }),
  );
  view.focus();
  return true;
}

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.35em", fontWeight: "700" },
  { tag: t.heading2, fontSize: "1.15em", fontWeight: "650" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--link)" },
  { tag: t.url, color: "var(--link)", textDecoration: "underline" },
  { tag: t.quote, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: t.monospace, fontFamily: "var(--font-mono, ui-monospace, monospace)", color: "var(--primary)" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--muted-foreground)" },
  { tag: t.list, color: "var(--foreground)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--foreground)", fontSize: "14px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.65", overflow: "auto" },
  ".cm-content": { padding: "12px 16px", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 45%, transparent)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklch, var(--primary) 30%, transparent) !important",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in oklch, var(--primary) 15%, transparent)" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  ".cm-panels": { backgroundColor: "var(--card)", color: "var(--foreground)", borderColor: "var(--border)" },
  ".cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-search": { fontSize: "13px", padding: "6px 12px" },
  ".cm-search input, .cm-search button, .cm-textfield, .cm-button": {
    backgroundColor: "var(--background)",
    backgroundImage: "none",
    color: "var(--foreground)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
  },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--warning) 35%, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in oklch, var(--warning) 65%, transparent)" },
});

/**
 * Éditeur Markdown (CodeMirror 6) : coloration et titres rendus, barre d'outils,
 * raccourcis (Ctrl+B, Ctrl+I, Ctrl+K, Ctrl+F, Ctrl+Z), Ctrl+S → onSave.
 */
export function MarkdownEditor({
  value,
  onChange,
  onSave,
  placeholder,
  className,
  label = "Contenu Markdown",
}: {
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  placeholder?: string;
  className?: string;
  label?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, onSave });
  latest.current = { onChange, onSave };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "true", lang: "fr" }),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(highlight),
          theme,
          placeholder ? cmPlaceholder(placeholder) : [],
          keymap.of([
            { key: "Mod-b", run: (v) => wrap(v, "**") },
            { key: "Mod-i", run: (v) => wrap(v, "*") },
            { key: "Mod-k", run: insertLink },
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                latest.current.onSave?.();
                return true;
              },
            },
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, []);

  // Valeur remplacée de l'extérieur (modèle chargé, version restaurée).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value)
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  const run = (fn: (v: EditorView) => boolean) => () => view.current && fn(view.current);
  const tools: { icon: typeof Bold; label: string; keys?: string; run: () => unknown }[][] = [
    [
      { icon: Heading2, label: "Titre de section", run: run((v) => linePrefix(v, "## ", /^##\s+/)) },
      { icon: Bold, label: "Gras", keys: "Ctrl+B", run: run((v) => wrap(v, "**")) },
      { icon: Italic, label: "Italique", keys: "Ctrl+I", run: run((v) => wrap(v, "*")) },
      { icon: Link, label: "Lien", keys: "Ctrl+K", run: run(insertLink) },
    ],
    [
      { icon: List, label: "Liste à puces", run: run((v) => linePrefix(v, "- ", /^[-*+]\s+/)) },
      { icon: ListOrdered, label: "Liste numérotée", run: run((v) => linePrefix(v, "1. ", /^\d+\.\s+/)) },
      { icon: Quote, label: "Citation / exemple", run: run((v) => linePrefix(v, "> ", /^>\s?/)) },
    ],
    [
      { icon: Undo2, label: "Annuler", keys: "Ctrl+Z", run: run(undo) },
      { icon: Redo2, label: "Rétablir", keys: "Ctrl+Y", run: run(redo) },
      { icon: Search, label: "Rechercher / remplacer", keys: "Ctrl+F", run: run(openSearchPanel) },
    ],
  ];

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <TooltipProvider delayDuration={300}>
      <div role="toolbar" aria-label="Mise en forme" className="flex flex-wrap items-center gap-0.5 border-b px-2 py-1">
        {tools.map((group, g) => (
          <div key={g} className={cn("flex items-center gap-0.5", g > 0 && "ml-1 border-l pl-1")}>
            {group.map((tool) => (
              <Tooltip key={tool.label}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-foreground"
                    aria-label={tool.label}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={tool.run}
                  >
                    <tool.icon className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {tool.label}
                  {tool.keys && <span className="ml-1.5 opacity-60">{tool.keys}</span>}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        ))}
      </div>
      </TooltipProvider>
      <div ref={host} className="min-h-0 flex-1" />
    </div>
  );
}

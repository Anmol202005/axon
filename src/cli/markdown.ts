import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

// ===========================================================================
// markdown rendering
// ---------------------------------------------------------------------------
// Convert a markdown string into ANSI-coloured text that Ink's <Text> can
// render. Code blocks are syntax-highlighted via cli-highlight (a dep of
// marked-terminal). The output keeps width measurements correct because Ink
// uses string-width / wrap-ansi internally.
// ===========================================================================

const marked = new Marked();
marked.use(
  markedTerminal({
    // Indent code blocks slightly and keep things flush-left.
    reflowText: false,
    tab: 2,
    width: 0, // 0 disables hard-wrap; let Ink handle layout
  }) as never,
);

export function renderMarkdown(input: string): string {
  if (!input) return "";
  try {
    const out = marked.parse(input, { async: false }) as string;
    // marked-terminal tends to trail a newline — trim it so the message box
    // doesn't add an empty row.
    return out.replace(/\n+$/, "");
  } catch {
    // Fall back to the raw text if anything goes wrong (e.g. malformed md).
    return input;
  }
}

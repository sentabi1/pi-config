/**
 * jordan-label — wraps the pi input box in a full four-sided fieldset box
 * with a "present jordan" legend in the top border (like `┌─ Search ─┐`).
 *
 * Clean + supported: ctx.ui.setEditorComponent() with a CustomEditor subclass,
 * so it survives pi updates.
 *
 * How the box is built: the base Editor only draws top + bottom rules (no
 * sides). We render the editor at width-2, then wrap each line with `│` sides
 * and corner-join the top/bottom rules. Prepending `│` to a content line shifts
 * the embedded zero-width cursor marker right by one column too, so IME / hardware
 * cursor positioning stays correct.
 *
 * Color: the editor `theme` is pi-tui's EditorTheme (only `borderColor` /
 * `selectList`) — NO `.fg()`/`.bold()`. We color with the inherited
 * `this.borderColor` (live thinking-level color) and bold via raw ANSI.
 */
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const LABEL = " present jordan ";
const BOLD = "\x1b[1m";
const UNBOLD = "\x1b[22m";

// Fixed colors (so they don't shift with thinking level and match the bubbles).
const PURPLE = (s: string) => `\x1b[38;2;209;131;232m${s}\x1b[39m`; // #d183e8
const BLUE = (s: string) => `\x1b[38;2;95;135;255m${s}\x1b[39m`; // #5f87ff

class LabeledEditor extends CustomEditor {
  render(width: number): string[] {
    const inner = width - 2;

    // Too narrow to box safely — fall back to the plain editor.
    if (inner < LABEL.length + 2) return super.render(width);

    const lines = super.render(inner);
    if (lines.length === 0) return lines;

    const last = lines.length - 1;
    const out: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      if (i === 0) {
        // Top border: purple frame, blue "present jordan" label.
        if (line.includes("more")) {
          out.push(PURPLE("┌") + line + PURPLE("┐"));
        } else {
          const fill = "─".repeat(Math.max(0, inner - 1 - LABEL.length));
          const top =
            PURPLE("┌─") + BLUE(BOLD + LABEL + UNBOLD) + PURPLE(fill + "┐");
          out.push(truncateToWidth(top, width, ""));
        }
      } else if (i === last) {
        // Bottom border: purple.
        out.push(PURPLE("└") + line + PURPLE("┘"));
      } else {
        // Content rows: purple sides, blue text (the bubble's border color).
        out.push(PURPLE("│") + BLUE(line) + PURPLE("│"));
      }
    }

    return out;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent(
      (tui, theme, kb) => new LabeledEditor(tui, theme, kb),
    );
  });
}

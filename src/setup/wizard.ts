import {
  S_BAR,
  S_BAR_END,
  S_BAR_START,
  S_STEP_ACTIVE,
  S_STEP_SUBMIT,
  S_WARN,
} from "@clack/prompts";
import color from "picocolors";
import { type Writers, logInfo, logProgress, logWarn } from "../output.js";
import { canRedraw } from "./tty.js";

/**
 * The frame around a setup run: one opening line, one closing block.
 *
 * A wizard that starts mid-sentence and stops mid-sentence never quite reads as
 * a thing you were taken through. Clack's own `intro`/`outro` draw exactly this
 * — `┌` at the top, `└` at the bottom, the `│` rail joining them — and that is
 * what makes a sequence of steps legible as one session rather than as a
 * scrolling log.
 *
 * Not `@clack/prompts`' `intro`/`outro` themselves: those write to stdout, and
 * stdout in this CLI belongs to results and to the `--json` event stream. The
 * whole wizard is stderr.
 */

/** The name on the box. */
export const WIZARD_TITLE = "TraceRoot Setup Wizard";

/**
 * Where a user goes next. All three are load-bearing at the end of a *failed*
 * run as much as a successful one, which is why the closing block prints them
 * either way.
 */
export const DOCS_URL = "https://docs.traceroot.ai";
const ISSUES_URL = "https://github.com/traceroot-ai/traceroot-cli/issues/new";
const SUPPORT_URL = "https://discord.gg/TM2m3CtKuC";

/** Opens the frame. Everything the run prints from here on sits inside it. */
export function wizardIntro(writers: Writers): void {
  writers.err.write(`${color.dim(S_BAR_START)}  ${color.bold(WIZARD_TITLE)}\n`);
}

/*
 * ── Colour ─────────────────────────────────────────────────────────────────
 *
 * Six roles, and no `color.*` call anywhere else in the closing blocks. Colour
 * applied inline, a phrase at a time, is how a rendering drifts into being
 * unreadable: the rule stops being stated anywhere and starts being whatever
 * the last person to touch a string felt like.
 *
 * URLs are coloured. The worry that a terminal would fold the escape codes into
 * a copied selection does not hold — SGR is an attribute of the cell, not of
 * its text, and every terminal copies the characters. Leaving them uncoloured
 * costs something real: the two links a user is meant to click become the least
 * findable things on the screen.
 *
 * Every one of them goes through picocolors, which turns itself off for
 * `NO_COLOR`, for a non-TTY and for `TERM=dumb`. Nothing here second-guesses
 * that.
 */

/**
 * The one accent in the wizard: things to click, and things to copy exactly.
 *
 * `cyanBright` (SGR 96). Plain blue (34) is the darkest colour in the
 * 16-colour set and on a dark terminal it was the least legible thing on
 * screen, which is a poor outcome for the lines a user is most likely to want
 * to select with a mouse. `blueBright` (94) fixed the legibility and still read
 * as a heavier colour than the role wants.
 *
 * The cost is real and worth naming: clack's step markers are cyan too, so a
 * link and a section glyph now share a hue. What keeps them apart is position
 * and weight rather than colour — a glyph sits in the rail column at normal
 * intensity, a link sits in the text and is brighter. Anything that needs to be
 * told apart from a link by colour alone must not be cyan.
 */
const LIGHT_BLUE = color.cyanBright;

/** Written out rather than embedded, so no control character reaches source. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** OSC 8: `ESC ] 8 ; params ; URI BEL`; the same with an empty URI closes it. */
const OSC8_OPEN = `${ESC}]8;;`;
const OSC8_CLOSE = `${ESC}]8;;${BEL}`;

/**
 * Patterns for the escapes above, built from the same constants.
 *
 * A regex literal would have to embed the control characters themselves, which
 * is the thing the constants exist to avoid — and a lone `ESC` in source is
 * invisible in a diff and easy to delete by accident.
 */
const SGR_PATTERN = `${ESC}\\[[0-9;]*m`;
const OSC8_PATTERN = `${ESC}\\]8;;[^${BEL}]*${BEL}`;
/** One whole line wrapped in a single SGR pair, and nothing else. */
const WHOLE_LINE_SGR = new RegExp(`^(${SGR_PATTERN})([^${ESC}]*)(${SGR_PATTERN})$`);

/**
 * Terminals known to render OSC 8, by their own self-identification.
 *
 * An allowlist rather than a probe, because there is no probe: OSC 8 has no
 * query form, and a terminal that does not understand it prints the escape
 * bytes into the user's scrollback. Getting this wrong in the permissive
 * direction corrupts the one line of the run a user has to copy, so anything
 * not named here is treated as not supporting it. Apple's Terminal.app is the
 * notable absence and it is deliberate — it identifies itself and it does not
 * implement the sequence.
 */
const HYPERLINK_TERM_PROGRAMS: ReadonlySet<string> = new Set([
  "iTerm.app",
  "WezTerm",
  "Hyper",
  "ghostty",
  "rio",
  "Tabby",
  "vscode",
]);

/**
 * Whether escape-sequence hyperlinks can be written to this stream.
 *
 * `FORCE_HYPERLINK` overrides everything below it, which is what makes this
 * testable and what gives a user on a terminal we have not heard of a way in.
 * Everything else is the usual ladder: the user's own opt-outs first, then a
 * cursor to write to at all, then a terminal that has said what it is.
 */
export function hyperlinksSupported(
  env: NodeJS.ProcessEnv = process.env,
  stream: { isTTY?: boolean } = process.stderr,
): boolean {
  const forced = env.FORCE_HYPERLINK;
  if (forced !== undefined && forced !== "" && forced !== "0") {
    return true;
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }
  if (env.TERM === "dumb") {
    return false;
  }
  // A pipe, a file or a CI log. All three are read as text later, where an
  // escape sequence is damage rather than decoration.
  if (stream.isTTY !== true) {
    return false;
  }
  if (env.CI !== undefined && env.CI !== "") {
    return false;
  }
  if (HYPERLINK_TERM_PROGRAMS.has(env.TERM_PROGRAM ?? "")) {
    return true;
  }
  // Windows Terminal announces itself nowhere else.
  if (env.WT_SESSION !== undefined && env.WT_SESSION !== "") {
    return true;
  }
  const term = env.TERM ?? "";
  if (term.includes("kitty") || term.includes("ghostty")) {
    return true;
  }
  // GNOME Terminal and the rest of the VTE family, from 0.50 onwards.
  const vte = Number.parseInt(env.VTE_VERSION ?? "", 10);
  return Number.isFinite(vte) && vte >= 5000;
}

/**
 * A link: something to click, or to drag a mouse across.
 *
 * The clickable form wraps the URL in OSC 8 — but the *text* inside the wrapper
 * is the URL itself, never a label. That is the whole design constraint here: a
 * terminal that renders the link gives the user something to click, and a
 * terminal that does not, or a `NO_COLOR` run, or anything piped to a file,
 * still shows exactly the characters they would have seen before, selectable
 * and copyable. Link-only text ("click here", or a shortened URL) would trade
 * away the fallback for a nicer-looking best case, and the fallback is the case
 * that has to keep working.
 *
 * `hyperlinks` is a parameter so a test can pin both forms; production calls it
 * with one argument and gets the environment's answer.
 */
export function wizardLink(url: string, hyperlinks: boolean = hyperlinksSupported()): string {
  return paintedLink(url, LIGHT_BLUE, hyperlinks);
}

/**
 * A link that is there for reference rather than to be followed now.
 *
 * The troubleshooting guide under the closing block is the one place this is
 * used, and it is deliberately quieter than the trace permalink two lines
 * above it. Both are links; only one of them is what the user came for. Giving
 * them the same weight makes the block ask twice, and the branch nobody wants
 * to be on wins by being lower on the screen.
 *
 * Not wrapped for clicking — see below for why that is the only way it can
 * actually stay grey.
 */
export function wizardMutedLink(url: string): string {
  // No OSC 8, and that is the whole point of this function now.
  //
  // Our bytes were already pure grey — `ESC[90m` and nothing else. What made
  // these links read as dark blue is that terminals style OSC 8 hyperlinks
  // themselves: iTerm2, Ghostty and the VTE family colour and underline a
  // hyperlink regardless of the SGR inside it. A quiet link wrapped for
  // clicking is therefore not quiet, and no amount of colouring on our side
  // wins against the terminal's own link attribute.
  //
  // So the muted role gives up the wrapper to keep the colour. Very little is
  // lost: every terminal in the allowlist also auto-detects a bare URL and
  // makes it clickable on its own. `wizardLink` keeps OSC 8, because there the
  // terminal's styling and ours agree.
  return GREY_TEXT(url);
}

/** The OSC 8 wrapper, once, so the two link roles cannot drift apart. */
function paintedLink(url: string, paint: (text: string) => string, hyperlinks: boolean): string {
  const painted = paint(url);
  if (!hyperlinks) {
    return painted;
  }
  return `${OSC8_OPEN}${url}${BEL}${painted}${OSC8_CLOSE}`;
}

/**
 * The name of an environment variable, in prose.
 *
 * The same light blue as a link, deliberately. In these blocks a variable name
 * is the other thing the eye has to find in a paragraph — the one token that
 * has to be copied exactly — and giving it a colour of its own would say there
 * are two kinds of important where there is one.
 */
export function wizardEnvVar(name: string): string {
  return LIGHT_BLUE(name);
}

/**
 * The grey the quiet roles are painted in.
 *
 * A true 256-colour grey, not SGR 90. `color.gray` is "bright black", which is
 * a *palette slot* rather than a colour: the terminal's theme decides what it
 * renders as, and most popular dark themes tint that slot blue. Solarized,
 * Nord and the macOS defaults all do. So text asked to be grey comes out a dark
 * slate blue, and asking harder cannot fix it: the request names a slot and the
 * theme names the colour.
 *
 * `38;5;245` names a specific neutral grey in the xterm-256 cube, which no
 * theme remaps. It costs a terminal that only understands 16 colours, and every
 * terminal in the hyperlink allowlist understands 256 — as does anything
 * setting `TERM=*-256color`. Where it is not understood the sequence is
 * ignored and the text renders at normal weight, which is the same failure
 * `NO_COLOR` already produces and is safe.
 *
 * Routed through picocolors' own enable/disable check so `NO_COLOR`, a pipe
 * and `TERM=dumb` still strip it.
 */
const GREY_TEXT = (text: string): string =>
  color.isColorSupported ? `${ESC}[38;5;245m${text}${ESC}[39m` : text;

/**
 * Supporting detail: true, worth keeping, not what the block is about.
 *
 * Grey rather than dim. Dim is an intensity attribute and terminals disagree
 * about it wildly — some render it identically to normal, which silently
 * collapses this role into the one it is supposed to be quieter than. Grey is a
 * colour, and a colour is a thing every terminal in the allowlist can actually
 * draw.
 */
export function wizardAside(text: string): string {
  return GREY_TEXT(text);
}

/** The one word in a line that the line is actually about. */
export function wizardEmphasis(text: string): string {
  return color.bold(text);
}

/**
 * The one green in the wizard: something that came out right.
 *
 * Two things wear it, and they are the same claim about different objects — a
 * fact the run has settled, and a step the user has settled. Blue is spoken for
 * by links and variable names, both of which are things to go and act on; green
 * is for things to check, and there is nothing left to do to either of them.
 */
const GREEN = color.green;

/**
 * A value the run has settled on: a project, a workspace, a name that came back
 * from the server rather than out of this source file.
 *
 * A line like "setup complete (project: demo, workspace: acme)" is two kinds of
 * text — a sentence we wrote and two facts about the user's account — and
 * colouring the second is what lets someone confirm at a glance that the run
 * landed where they meant it to.
 */
export function wizardValue(text: string): string {
  return GREEN(text);
}

/**
 * The line under a closing block that a human presses Enter on.
 *
 * Three parts, three weights, and the order matters. A green dot in place of
 * the rail, because this row is the only one in the block that is waiting on
 * somebody; the sentence at full contrast, because it is what they are
 * agreeing to; and the instruction in grey on the right, because a user who
 * has pressed Enter once already knows, and one who has not needs telling
 * exactly once.
 *
 * The line is not dim. Dimming it would read the row as a formality — nothing
 * branches on the answer — but the thing being acknowledged is the one action
 * the wizard cannot take for the user, and dimming it makes the only live row
 * on screen the quietest thing on it.
 *
 * Anything inside `text` that must stand out is the caller's to mark with
 * {@link wizardEmphasis}, which survives being composed in here.
 */
export function wizardAcknowledgement(text: string): string {
  // The rail in the gutter, not a marker and not a blank.
  //
  // The green dot went because a marker is how every other line in the wizard
  // announces "a new thing starts here", and these two do the opposite — they
  // close the block above them. Three spaces was the wrong replacement: the
  // frame's vertical line simply stopped for two rows and started again, which
  // reads as the block having ended early. `│` is the frame, not a marker, so
  // it continues through a row that is waiting without claiming to open one.
  return `${color.dim(S_BAR)}  ${text}  ${wizardAside("(Press Enter to continue)")}`;
}

/**
 * The same line once it has been answered, ready to be drawn over the live one.
 *
 * Two things change and both are the point. The instruction goes, because
 * "press Enter to continue" above a run that has already continued is stale
 * text the user has to re-read to discover is stale. And the whole row drops to
 * grey, because a settled acknowledgement is transcript rather than something
 * being asked — the live row should be the only bright one on screen.
 *
 * Takes the plain sentence, not the composed line: dimming a string that
 * already contains a bold span ends the dim early, and the row comes back half
 * grey and half not.
 */
export function wizardAcknowledgementSettled(text: string): string {
  return `${color.dim(S_BAR)}  ${color.dim(text)}`;
}

/**
 * Draws the settled acknowledgement over the live one the user just answered.
 *
 * Enter leaves the cursor on the row below the prompt, so this steps back one
 * line, wipes it, and writes the grey version in its place.
 *
 * Only where the terminal can be redrawn at all. Piped, dumb or non-TTY, the
 * cursor movement would be literal garbage in the output and the live line was
 * never animated to begin with — so the answered line simply stays as it was,
 * which reads correctly in a transcript.
 */
export function settleAcknowledgement(writers: Writers, text: string): void {
  if (!canRedraw(writers.err, process.env)) {
    return;
  }
  writers.err.write(`${ESC}[1A${ESC}[2K${wizardAcknowledgementSettled(text)}\n`);
}

/**
 * A block of prose inside the frame, each line on the rail.
 *
 * The first line takes a clack step marker, so a block that needs reading — a
 * sign-in link, a verification code, the two blocks that close a run — is
 * visibly a step rather than incidental logging. Everything after it continues
 * on the rail.
 */
/**
 * Splits a line so it fits beside the rail instead of wrapping under it.
 *
 * A terminal wrapping a line on its own puts the overflow in column zero, where
 * the rail lives — so a long sentence walks straight through the wizard's left
 * edge and the frame stops being a frame. Wrapping here instead means every
 * continuation gets the rail prefix its first line got.
 *
 * Colour survives one specific shape, which is the shape every line here has:
 * the whole string wrapped in a single SGR pair, as `wizardAside` and
 * `wizardEmphasis` produce. That pair is lifted off, the plain text is wrapped,
 * and each piece is re-wrapped in it. Anything more complicated — a line with
 * colour *inside* it — is returned untouched rather than corrupted, because
 * splitting mid-escape is worse than a line that runs long.
 */
export function wrapForRail(line: string, width: number): string[] {
  if (width <= 0 || visibleLength(line) <= width) {
    return [line];
  }

  // A line coloured as a whole — everything `wizardAside` and `wizardEmphasis`
  // produce. The pair comes off, the text wraps, and every piece gets it back,
  // so a three-line caveat is grey on all three lines rather than the first.
  const paired = WHOLE_LINE_SGR.exec(line);
  if (paired !== null) {
    const [, open = "", body = "", close = ""] = paired;
    return wrapWords(body, width).map((piece) => `${open}${piece}${close}`);
  }

  // Colour inside the line: a variable name, a path. Splitting on spaces never
  // splits an escape pair, because every span we emit sits inside one word — so
  // the escapes travel with the word they belong to and the wrap is safe. A
  // span that straddled a space could lose its colour after a break; that is a
  // fair trade against a sentence walking through the rail.
  return wrapWords(line, width);
}

/** Visible columns, ignoring SGR and OSC 8, which occupy no cells. */
function visibleLength(text: string): number {
  const bare = text
    .replace(new RegExp(SGR_PATTERN, "gu"), "")
    .replace(new RegExp(OSC8_PATTERN, "gu"), "");
  return bare.length;
}

/** Greedy word wrap on visible width. A word longer than `width` overflows. */
function wrapWords(text: string, width: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") {
      current = word;
    } else if (visibleLength(`${current} ${word}`) <= width) {
      current = `${current} ${word}`;
    } else {
      pieces.push(current);
      current = word;
    }
  }
  if (current !== "") {
    pieces.push(current);
  }
  return pieces;
}

/** Columns available beside the rail, which costs a glyph and two spaces. */
function railWidth(): number {
  const columns = (process.stderr as unknown as { columns?: number }).columns;
  return (typeof columns === "number" && columns > 20 ? columns : 80) - 3;
}

export function wizardNote(
  writers: Writers,
  lines: readonly string[],
  options: { dimFrom?: number; settled?: boolean } = {},
): void {
  const rail = color.dim(S_BAR);
  // Lines from `dimFrom` onwards are supporting detail rather than the point.
  // A list of forty changed paths at full contrast shouts louder than the
  // sentence explaining what it means.
  const dimFrom = options.dimFrom ?? Number.POSITIVE_INFINITY;
  // `◆` is clack's marker for the step you are on; `◇` for one that has been
  // answered. The closing blocks take `◇` because that is what they look like
  // in the transcript a user is left with — the acknowledgement under each one
  // has been given by the time anybody reads it back.
  const glyph = options.settled === true ? S_STEP_SUBMIT : S_STEP_ACTIVE;
  const width = railWidth();
  const rendered: string[] = [];
  lines.forEach((line, index) => {
    const text = index >= dimFrom ? color.dim(line) : line;
    if (line === "") {
      rendered.push(rail);
      return;
    }
    // Only the block's very first row takes the step glyph; a wrapped
    // continuation of it is still the same row and takes the rail.
    for (const [piece, at] of wrapForRail(text, width).map((p, i) => [p, i] as const)) {
      const prefix = index === 0 && at === 0 ? color.cyan(glyph) : rail;
      rendered.push(`${prefix}  ${piece}`);
    }
  });
  writers.err.write(`${rail}\n${rendered.join("\n")}\n`);
}

/**
 * One settled line marked as a step of the run — returned, not written.
 *
 * The line spinner needs the finished text in hand before it erases the block
 * it drew, so this hands the composed line back instead of printing it. The
 * glyph is the one {@link wizardNote} opens with: a step that collapsed to a
 * single sentence is still a step, and it has to look like one.
 */
export function wizardStepLine(text: string): string {
  return `${color.cyan(S_STEP_ACTIVE)}  ${text}`;
}

/**
 * Where a line is going, and whether there is a frame around it.
 *
 * `SetupContext` satisfies this structurally, so a stage says `wizardLine(ctx,
 * …)` and cannot get the two apart. Under `--json` no frame was ever drawn —
 * stdout is an event stream and stderr is plain diagnostics — so the rail is
 * dropped rather than left decorating nothing.
 */
export interface FramedOutput {
  writers: Writers;
  json: boolean;
}

/**
 * Puts every line of `text` on the rail, blank lines included.
 *
 * The one place this is decided. A line printed without it sits visibly outside
 * the frame, reading as a sentence about the wizard rather than part of it.
 */
function onRail(text: string, decorate: (line: string) => string): string {
  const rail = color.dim(S_BAR);
  return text
    .split("\n")
    .map((line) => (line === "" ? rail : `${rail}  ${decorate(line)}`))
    .join("\n");
}

/** Something the run has to say, at full weight. */
export function wizardLine(target: FramedOutput, text: string): void {
  if (target.json) {
    logInfo(text, target.writers);
    return;
  }
  target.writers.err.write(`${onRail(text, (line) => line)}\n`);
}

/** Something the run did, dimmed: true, worth recording, not worth staring at. */
export function wizardProgress(target: FramedOutput, text: string): void {
  if (target.json) {
    logProgress(text, target.writers);
    return;
  }
  target.writers.err.write(`${onRail(text, color.dim)}\n`);
}

/**
 * A warning: its own glyph in place of the rail on the first line, so it is
 * findable in a scrollback, and still inside the frame.
 *
 * Keeps the `warning:` prefix the rest of the CLI uses. The messages are
 * written as continuations of it ("not inside a git repository — …") and read
 * as fragments without it.
 */
export function wizardWarn(target: FramedOutput, text: string): void {
  if (target.json) {
    logWarn(text, target.writers);
    return;
  }
  const [first = "", ...rest] = `warning: ${text}`.split("\n");
  const lines = [`${color.yellow(S_WARN)}  ${first}`];
  if (rest.length > 0) {
    lines.push(onRail(rest.join("\n"), (line) => line));
  }
  target.writers.err.write(`${lines.join("\n")}\n`);
}

/**
 * Closes the frame, then says the last few things outside it.
 *
 * `message` is the caller's, because only the caller knows whether this was a
 * finished setup, a run that stopped short of a trace, or a failure — and
 * "complete" printed over either of the other two would be a lie the user finds
 * out about later.
 *
 * Everything after `└` is deliberately unrailed. The frame is the *wizard*, and
 * the wizard has ended; where to report a problem and where to find the docs
 * are the CLI talking to its user afterwards, and drawing them inside a box
 * that just closed makes them look like one more step of a flow that is over.
 *
 * `closing` is the one sentence only a successful run may print, so it is a
 * parameter rather than a constant: a run that stopped at the agent has not
 * earned "you can now use TraceRoot in production".
 */
export function wizardOutro(
  writers: Writers,
  message: string,
  options: { closing?: string | null } = {},
): void {
  const rail = color.dim(S_BAR);
  const tail = [
    "",
    `${color.dim(S_BAR_END)}  ${message}`,
    "",
    ...(options.closing == null ? [] : [options.closing, ""]),
    `If you ran into anything during setup, please open an issue at ${wizardLink(ISSUES_URL)}`,
    "",
    // Grey links, like the line they sit on. These are where to go if
    // something is wrong later, not something to do now, and a bright link
    // inside a grey sentence reads as the point of it.
    wizardAside(`- Contact support: ${wizardMutedLink(SUPPORT_URL)}`),
    wizardAside(`- Further documentation: ${wizardMutedLink(DOCS_URL)}`),
    // Two, so the shell prompt lands with a blank line above it rather than
    // flush against the last bullet. A prompt hard against the final line of
    // output reads as one more line of that output, and the run's last word
    // ends up looking like an argument somebody typed.
    "",
    "",
  ];
  writers.err.write(`${rail}${tail.join("\n")}`);
}

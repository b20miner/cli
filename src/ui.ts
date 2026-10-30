/**
 * Terminal presentation: the B20MINER CLI banner, colours and small
 * layout helpers. The palette is the app's "Cyclorama" world: cobalt
 * horizon, rose for earned results, amber for warnings. Colours switch
 * off for NO_COLOR, non-TTY output, or TERM=dumb.
 */

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const truecolor = useColor && /truecolor|24bit/i.test(process.env.COLORTERM ?? "");

type Rgb = readonly [number, number, number];
const COBALT: Rgb = [29, 60, 255];
const COBALT_HI: Rgb = [90, 114, 255];
const VIOLET: Rgb = [109, 69, 255];
const ROSE: Rgb = [255, 111, 159];
const AMBER: Rgb = [255, 181, 71];
const FAULT: Rgb = [255, 97, 71];
const INK_2: Rgb = [178, 183, 214];

function rgb(c: Rgb, text: string): string {
  if (!useColor) return text;
  if (truecolor) return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${text}\x1b[39m`;
  // 256-colour approximation
  const idx = 16 + 36 * Math.round((c[0] / 255) * 5) + 6 * Math.round((c[1] / 255) * 5) + Math.round((c[2] / 255) * 5);
  return `\x1b[38;5;${idx}m${text}\x1b[39m`;
}

const wrap = (open: number, close: number) => (text: string) => (useColor ? `\x1b[${open}m${text}\x1b[${close}m` : text);
export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const cobalt = (t: string) => rgb(COBALT_HI, t);
export const rose = (t: string) => rgb(ROSE, t);
export const amber = (t: string) => rgb(AMBER, t);
export const fault = (t: string) => rgb(FAULT, t);
export const muted = (t: string) => rgb(INK_2, t);

function lerp(a: Rgb, b: Rgb, t: number): Rgb {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

/** Horizontal cobalt → violet → rose gradient across a line. */
function gradient(line: string, width: number): string {
  if (!useColor) return line;
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const t = width <= 1 ? 0 : i / (width - 1);
    const c = t < 0.5 ? lerp(COBALT, VIOLET, t * 2) : lerp(VIOLET, ROSE, (t - 0.5) * 2);
    out += line[i] === " " ? " " : rgb(c, line[i]!);
  }
  return out;
}

const LOGO = [
  "██████╗ ██████╗  ██████╗ ███╗   ███╗██╗███╗   ██╗███████╗██████╗ ",
  "██╔══██╗╚════██╗██╔═████╗████╗ ████║██║████╗  ██║██╔════╝██╔══██╗",
  "██████╔╝ █████╔╝██║██╔██║██╔████╔██║██║██╔██╗ ██║█████╗  ██████╔╝",
  "██╔══██╗██╔═══╝ ████╔╝██║██║╚██╔╝██║██║██║╚██╗██║██╔══╝  ██╔══██╗",
  "██████╔╝███████╗╚██████╔╝██║ ╚═╝ ██║██║██║ ╚████║███████╗██║  ██║",
  "╚═════╝ ╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝",
];

export function banner(version: string, network: string): string {
  const width = LOGO[0]!.length;
  const lines = LOGO.map((l) => "  " + gradient(l, width));
  const horizon = "  " + gradient("━".repeat(width), width);
  const tag = `  ${bold("CLI")} ${muted(`v${version}`)}   ${cobalt("●")} ${network}   ${amber("TESTNET")}`;
  return ["", ...lines, horizon, tag, ""].join("\n");
}

/** Compact banner when the terminal is narrower than the logo. */
export function smallBanner(version: string, network: string): string {
  return `\n  ${gradient("B20MINER", 8)} ${bold("CLI")} ${muted(`v${version}`)}  ${cobalt("●")} ${network}  ${amber("testnet")}\n`;
}

export function printBanner(version: string, network: string): void {
  const cols = process.stdout.columns ?? 80;
  console.log(cols >= 72 ? banner(version, network) : smallBanner(version, network));
}

/** Label/value rows, labels padded to a common width. */
export function rows(entries: ReadonlyArray<readonly [string, string]>): string {
  const w = Math.max(...entries.map(([k]) => k.length));
  return entries.map(([k, v]) => `  ${muted(k.padEnd(w))}  ${v}`).join("\n");
}

export function heading(text: string): string {
  return `\n  ${bold(text.toUpperCase())}\n  ${muted("─".repeat(Math.min(56, text.length + 24)))}`;
}

export function ok(text: string): string {
  return `  ${rose("✔")} ${text}`;
}

export function warn(text: string): string {
  return `  ${amber("!")} ${text}`;
}

export function err(text: string): string {
  return `  ${fault("✖")} ${text}`;
}

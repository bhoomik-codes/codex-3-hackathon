/**
 * GuardSaaB CLI UI — ANSI formatting, badges, and layout helpers.
 * Zero-dependency, fast, cross-platform terminal presentation.
 */

const noColor = Boolean(process.env.NO_COLOR || !process.stdout.isTTY);

export const c = {
  reset: noColor ? '' : '\x1b[0m',
  bold: noColor ? '' : '\x1b[1m',
  dim: noColor ? '' : '\x1b[2m',
  italic: noColor ? '' : '\x1b[3m',
  underline: noColor ? '' : '\x1b[4m',

  // Foreground colors
  red: noColor ? '' : '\x1b[31m',
  green: noColor ? '' : '\x1b[32m',
  yellow: noColor ? '' : '\x1b[33m',
  blue: noColor ? '' : '\x1b[34m',
  magenta: noColor ? '' : '\x1b[35m',
  cyan: noColor ? '' : '\x1b[36m',
  white: noColor ? '' : '\x1b[37m',
  gray: noColor ? '' : '\x1b[90m',

  // Bright colors
  brightRed: noColor ? '' : '\x1b[91m',
  brightGreen: noColor ? '' : '\x1b[92m',
  brightYellow: noColor ? '' : '\x1b[93m',
  brightCyan: noColor ? '' : '\x1b[96m',

  // Background colors
  bgRed: noColor ? '' : '\x1b[41m',
  bgGreen: noColor ? '' : '\x1b[42m',
  bgYellow: noColor ? '' : '\x1b[43m',
  bgBlue: noColor ? '' : '\x1b[44m',
  bgDark: noColor ? '' : '\x1b[100m',
};

export function badge(action: string): string {
  switch (action.toUpperCase()) {
    case 'ALLOW':
      return `${c.bgGreen}${c.white}${c.bold} ALLOW ${c.reset}`;
    case 'BLOCK':
      return `${c.bgRed}${c.white}${c.bold} BLOCK ${c.reset}`;
    case 'HITL':
    case 'HOLD':
      return `${c.bgYellow}${c.white}${c.bold} HITL ${c.reset}`;
    case 'ASK':
      return `${c.bgYellow}${c.white}${c.bold} ASK ${c.reset}`;
    case 'AUDIT':
      return `${c.bgBlue}${c.white}${c.bold} AUDIT ${c.reset}`;
    default:
      return `${c.gray}[${action}]${c.reset}`;
  }
}

export function riskBadge(band?: string, score?: number): string {
  const scoreText = score !== undefined ? ` (${score})` : '';
  switch ((band ?? '').toUpperCase()) {
    case 'CRITICAL':
    case 'BLOCK':
      return `${c.red}${c.bold}● CRITICAL${scoreText}${c.reset}`;
    case 'HIGH':
      return `${c.brightRed}${c.bold}● HIGH${scoreText}${c.reset}`;
    case 'MEDIUM':
    case 'HITL':
      return `${c.yellow}${c.bold}▲ MEDIUM${scoreText}${c.reset}`;
    case 'LOW':
    case 'ALLOW':
      return `${c.green}✓ LOW${scoreText}${c.reset}`;
    default:
      return `${c.gray}○ UNKNOWN${scoreText}${c.reset}`;
  }
}

export function banner(): void {
  const art = [
    ` ${c.cyan}${c.bold}██████╗ ██╗   ██╗ █████╗ ██████╗ ██████╗ ███████╗ █████╗  █████╗ ██████╗ ${c.reset}`,
    ` ${c.cyan}${c.bold}██╔════╝ ██║   ██║██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔══██╗${c.reset}`,
    ` ${c.cyan}${c.bold}██║  ███╗██║   ██║███████║██████╔╝██║  ██║███████╗███████║███████║██████╔╝${c.reset}`,
    ` ${c.cyan}${c.bold}██║   ██║██║   ██║██╔══██║██╔══██╗██║  ██║╚════██║██╔══██║██╔══██║██╔══██╗${c.reset}`,
    ` ${c.cyan}${c.bold}╚██████╔╝╚██████╔╝██║  ██║██║  ██║██████╔╝███████║██║  ██║██║  ██║██████╔╝${c.reset}`,
    `  ${c.dim}Control Plane for Autonomous AI Agents · Local-First Security Gateway${c.reset}\n`,
  ];
  process.stdout.write(art.join('\n') + '\n');
}

export function box(titleText: string, lines: string[]): void {
  const width = Math.max(64, ...lines.map((l) => stripAnsi(l).length), stripAnsi(titleText).length + 4);
  const border = '─'.repeat(width - 2);
  process.stdout.write(`\n${c.cyan}┌─ ${c.bold}${titleText}${c.reset}${c.cyan} ${'─'.repeat(Math.max(0, width - stripAnsi(titleText).length - 5))}┐${c.reset}\n`);
  for (const l of lines) {
    const rawLen = stripAnsi(l).length;
    const padding = ' '.repeat(Math.max(0, width - rawLen - 4));
    process.stdout.write(`${c.cyan}│${c.reset}  ${l}${padding}${c.cyan}│${c.reset}\n`);
  }
  process.stdout.write(`${c.cyan}└${border}┘${c.reset}\n`);
}

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function header(titleText: string): void {
  const line = '─'.repeat(Math.max(40, titleText.length + 4));
  process.stdout.write(`\n${c.bold}${c.brightCyan}${titleText}${c.reset}\n${c.gray}${line}${c.reset}\n`);
}

export function tableRow(col1: string, col2: string, width1 = 20): void {
  process.stdout.write(`  ${c.dim}${col1.padEnd(width1)}${c.reset} ${col2}\n`);
}

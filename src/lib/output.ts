function shouldColor(): boolean {
  return process.env.NO_COLOR === undefined;
}

function color(code: number, text: string): string {
  if (!shouldColor()) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export const colors = {
  green: (text: string) => color(32, text),
  red: (text: string) => color(31, text),
  yellow: (text: string) => color(33, text),
  dim: (text: string) => color(2, text),
  bold: (text: string) => color(1, text),
};

export function success(msg: string): void {
  console.log(`${colors.green("✓")} ${msg}`);
}

export function error(msg: string): void {
  console.error(`${colors.red("✗")} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${colors.yellow("⚠")} ${msg}`);
}

export function info(msg: string): void {
  console.log(`${colors.dim("ℹ")} ${msg}`);
}

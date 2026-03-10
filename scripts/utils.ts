import { spawnSync } from "child_process";
import * as readline from "readline";

const isWindows = process.platform === "win32";

// ANSI colors for terminal output
export const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

// Check if a command exists in PATH
export function commandExists(command: string): boolean {
  const checkCmd = isWindows ? "where" : "which";
  const result = spawnSync(checkCmd, [command], { stdio: "pipe" });
  return result.status === 0;
}

// Ask user for confirmation
export async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${colors.yellow}? ${question} (y/N): ${colors.reset}`, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import * as readline from "readline";

const isWindows = process.platform === "win32";

// Add common user-level CLI install locations so setup/start scripts work in
// non-login shells (for example on headless Linux servers over SSH).
export function ensureUserBinPaths() {
  if (isWindows) return;

  const candidates = [
    path.join(os.homedir(), ".bun", "bin"),
    path.join(os.homedir(), ".opencode", "bin"),
    path.join(os.homedir(), ".local", "bin"),
  ].filter((candidate) => fs.existsSync(candidate));

  const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const seen = new Set(current);
  const missing = candidates.filter((candidate) => !seen.has(candidate));

  if (missing.length > 0) {
    process.env.PATH = [...missing, ...current].join(path.delimiter);
  }
}

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

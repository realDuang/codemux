import * as pty from "node-pty";
import os from "os";
import { BrowserWindow } from "electron";

interface TerminalInstance {
  pty: pty.IPty;
  windowId: number;
}

const terminals = new Map<string, TerminalInstance>();
let idCounter = 0;

function getDefaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/bash";
}

export function createTerminal(
  window: BrowserWindow,
  cwd: string,
  cols: number,
  rows: number,
): string {
  const id = `term-${++idCounter}`;
  const shell = getDefaultShell();

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (!env.LANG) env.LANG = "ru_RU.UTF-8";
  if (!env.LC_CTYPE) env.LC_CTYPE = env.LANG;
  if (!env.LC_ALL) env.LC_ALL = env.LANG;

  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
  });

  ptyProcess.onData((data) => {
    if (window.isDestroyed()) return;
    window.webContents.send("terminal:data", id, data);
  });

  ptyProcess.onExit(() => {
    terminals.delete(id);
    if (!window.isDestroyed()) {
      window.webContents.send("terminal:exit", id);
    }
  });

  terminals.set(id, { pty: ptyProcess, windowId: window.id });
  return id;
}

export function writeTerminal(id: string, data: string): void {
  const term = terminals.get(id);
  if (term) {
    term.pty.write(data);
  }
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const term = terminals.get(id);
  if (term) {
    term.pty.resize(cols, rows);
  }
}

export function destroyTerminal(id: string): void {
  const term = terminals.get(id);
  if (term) {
    term.pty.kill();
    terminals.delete(id);
  }
}

export function destroyAllTerminals(): void {
  for (const [id, term] of terminals) {
    term.pty.kill();
    terminals.delete(id);
  }
}

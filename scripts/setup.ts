/**
 * CodeMux - External Dependencies Setup Script
 * Supports Windows / macOS / Linux
 *
 * Usage: bun run setup
 */

import { spawn, spawnSync } from "child_process";
import * as readline from "readline";

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

// ANSI colors
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(message: string, color: string = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logStep(step: string) {
  console.log(`\n${colors.cyan}> ${step}${colors.reset}`);
}

function logSuccess(message: string) {
  console.log(`${colors.green}[ok] ${message}${colors.reset}`);
}

function logWarning(message: string) {
  console.log(`${colors.yellow}[!] ${message}${colors.reset}`);
}

function logError(message: string) {
  console.log(`${colors.red}[x] ${message}${colors.reset}`);
}

// Check if a command exists in PATH
function commandExists(command: string): boolean {
  const checkCmd = isWindows ? "where" : "which";
  const result = spawnSync(checkCmd, [command], { stdio: "pipe" });
  return result.status === 0;
}

// Get command version
function getVersion(command: string, versionArg: string = "--version"): string | null {
  try {
    const result = spawnSync(command, [versionArg], {
      stdio: "pipe",
      encoding: "utf-8",
    });
    if (result.status === 0 && result.stdout) {
      const firstLine = result.stdout.trim().split("\n")[0];
      const versionMatch = firstLine.match(/(\d+\.\d+\.\d+)/);
      return versionMatch ? versionMatch[1] : firstLine.substring(0, 20);
    }
  } catch {
    return null;
  }
  return null;
}

// Ask user for confirmation
async function confirm(question: string): Promise<boolean> {
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

// Execute install command
async function runInstallCommand(
  description: string,
  command: string,
  args: string[],
  options: { shell?: boolean } = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    log(`  Running: ${command} ${args.join(" ")}`, colors.blue);

    const proc = spawn(command, args, {
      stdio: "inherit",
      shell: options.shell ?? isWindows,
    });

    proc.on("close", (code) => {
      if (code === 0) {
        logSuccess(`${description} completed`);
        resolve(true);
      } else {
        logError(`${description} failed (exit code: ${code})`);
        resolve(false);
      }
    });

    proc.on("error", (err) => {
      logError(`${description} failed: ${err.message}`);
      resolve(false);
    });
  });
}

// Install OpenCode CLI
async function installOpenCode(): Promise<boolean> {
  logStep("Installing OpenCode CLI");

  if (isWindows) {
    log("  Using PowerShell to install...", colors.blue);
    return runInstallCommand(
      "OpenCode CLI installation",
      "powershell",
      ["-Command", "irm https://opencode.ai/install.ps1 | iex"],
      { shell: true }
    );
  } else {
    log("  Using curl to install...", colors.blue);
    return runInstallCommand(
      "OpenCode CLI installation",
      "bash",
      ["-c", "curl -fsSL https://opencode.ai/install.sh | bash"],
      { shell: false }
    );
  }
}

// Install Cloudflared
async function installCloudflared(): Promise<boolean> {
  logStep("Installing Cloudflared");

  if (isWindows) {
    if (commandExists("winget")) {
      return runInstallCommand(
        "Cloudflared installation",
        "winget",
        ["install", "--id", "Cloudflare.cloudflared", "-e", "--accept-source-agreements"],
        { shell: true }
      );
    } else {
      logWarning("winget is not installed. Please download cloudflared manually:");
      log("  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/", colors.blue);
      return false;
    }
  } else if (isMac) {
    if (commandExists("brew")) {
      return runInstallCommand(
        "Cloudflared installation",
        "brew",
        ["install", "cloudflared"],
        { shell: false }
      );
    } else {
      logWarning("Homebrew is not installed. Please install Homebrew first or install cloudflared manually:");
      log("  https://brew.sh", colors.blue);
      return false;
    }
  } else {
    if (commandExists("apt")) {
      log("  Detected apt, installing from Cloudflare official repository...", colors.blue);
      const commands = [
        "curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null",
        'echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list',
        "sudo apt update && sudo apt install -y cloudflared",
      ];
      return runInstallCommand(
        "Cloudflared installation",
        "bash",
        ["-c", commands.join(" && ")],
        { shell: false }
      );
    } else if (commandExists("yum") || commandExists("dnf")) {
      const pm = commandExists("dnf") ? "dnf" : "yum";
      return runInstallCommand(
        "Cloudflared installation",
        "sudo",
        [pm, "install", "-y", "cloudflared"],
        { shell: false }
      );
    } else {
      logWarning("No supported package manager detected. Please install cloudflared manually:");
      log("  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/", colors.blue);
      return false;
    }
  }
}

// Auth provider interface
interface AuthProvider {
  name: string;
  type: string;
}

// Get list of configured auth providers
function getAuthProviders(): AuthProvider[] {
  try {
    const result = spawnSync("opencode", ["auth", "list"], {
      stdio: "pipe",
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    if (result.status === 0 && result.stdout) {
      const providers: AuthProvider[] = [];
      const cleanOutput = result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
      const lines = cleanOutput.split("\n");
      for (const line of lines) {
        const match = line.match(/[●○]\s+(.+?)\s+(oauth|api[_-]?key|custom)\s*$/i);
        if (match) {
          providers.push({
            name: match[1].trim(),
            type: match[2].toLowerCase(),
          });
        }
      }
      return providers;
    }
  } catch {
    return [];
  }
  return [];
}

// Check if any auth provider is configured
function hasAuthProvider(): boolean {
  return getAuthProviders().length > 0;
}

// Print auth provider status
function printAuthStatus() {
  const providers = getAuthProviders();

  console.log("\n" + "-".repeat(60));
  console.log(`${colors.bold}  Configured Auth Providers${colors.reset}`);
  console.log("-".repeat(60));

  if (providers.length === 0) {
    console.log(`  ${colors.yellow}No providers configured${colors.reset}`);
  } else {
    for (const provider of providers) {
      console.log(`  ${colors.green}[ok]${colors.reset} ${provider.name} (${provider.type})`);
    }
  }

  console.log("-".repeat(60) + "\n");
}

// Run opencode auth login interactively (let opencode handle the UI)
async function runAuthLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    log("  Running: opencode auth login", colors.blue);

    const proc = spawn("opencode", ["auth", "login"], {
      stdio: "inherit",
      shell: isWindows,
    });

    proc.on("close", (code) => {
      resolve(code === 0);
    });

    proc.on("error", (err) => {
      logError(`Authentication failed: ${err.message}`);
      resolve(false);
    });
  });
}

// Dependency status interface
interface DependencyStatus {
  name: string;
  command: string;
  installed: boolean;
  version: string | null;
  required: boolean;
  description: string;
}

function checkDependencies(): DependencyStatus[] {
  return [
    {
      name: "Bun",
      command: "bun",
      installed: commandExists("bun"),
      version: getVersion("bun"),
      required: true,
      description: "JavaScript runtime (required)",
    },
    {
      name: "OpenCode CLI",
      command: "opencode",
      installed: commandExists("opencode"),
      version: getVersion("opencode"),
      required: true,
      description: "OpenCode CLI tool (required)",
    },
    {
      name: "Cloudflared",
      command: "cloudflared",
      installed: commandExists("cloudflared"),
      version: getVersion("cloudflared"),
      required: false,
      description: "Cloudflare Tunnel (optional, for public access)",
    },
  ];
}

// Print dependency status table
function printDependencyTable(deps: DependencyStatus[]) {
  console.log("\n" + "-".repeat(80));
  console.log(
    `${colors.bold}  Dependency${" ".repeat(10)}Status${" ".repeat(6)}Version${" ".repeat(13)}Description${colors.reset}`
  );
  console.log("-".repeat(80));

  for (const dep of deps) {
    const status = dep.installed
      ? `${colors.green}Installed${colors.reset}`
      : `${colors.red}Missing${colors.reset}`;
    const version = dep.version || "-";
    const name = dep.name.padEnd(18);
    const versionPad = version.substring(0, 20).padEnd(20);

    console.log(
      `  ${name}${status}${" ".repeat(4)}${versionPad}${dep.description}`
    );
  }

  console.log("-".repeat(80) + "\n");
}

// Main function
async function main() {
  console.log("\n" + "=".repeat(60));
  console.log(
    `${colors.bold}${colors.cyan}  CodeMux - Setup Wizard${colors.reset}`
  );
  console.log("=".repeat(60));

  // Check current status
  logStep("Checking installed dependencies");
  const deps = checkDependencies();
  printDependencyTable(deps);

  // Check Bun (prerequisite)
  const bunDep = deps.find((d) => d.name === "Bun");
  if (!bunDep?.installed) {
    logError("Bun is not installed! Please install Bun first:");
    log("  https://bun.sh", colors.blue);
    if (isWindows) {
      log("  powershell -c \"irm bun.sh/install.ps1 | iex\"", colors.cyan);
    } else {
      log("  curl -fsSL https://bun.sh/install | bash", colors.cyan);
    }
    process.exit(1);
  }

  // Check which dependencies need to be installed
  const opencodeDep = deps.find((d) => d.name === "OpenCode CLI");
  const cloudflaredDep = deps.find((d) => d.name === "Cloudflared");

  const needOpenCode = !opencodeDep?.installed;
  const needCloudflared = !cloudflaredDep?.installed;

  if (!needOpenCode && !needCloudflared) {
    logSuccess("All dependencies are installed!");
  }

  // Install OpenCode
  if (needOpenCode) {
    const shouldInstall = await confirm("Install OpenCode CLI? (required)");
    if (shouldInstall) {
      const success = await installOpenCode();
      if (!success) {
        logError("OpenCode CLI installation failed. Please install manually:");
        if (isWindows) {
          log("  irm https://opencode.ai/install.ps1 | iex", colors.cyan);
        } else {
          log("  curl -fsSL https://opencode.ai/install.sh | bash", colors.cyan);
        }
      }
    } else {
      logWarning("Skipped OpenCode CLI installation. Note: This is a required dependency!");
    }
  }

  // Install Cloudflared
  if (needCloudflared) {
    const shouldInstall = await confirm(
      "Install Cloudflared? (optional, for public access feature)"
    );
    if (shouldInstall) {
      const success = await installCloudflared();
      if (!success) {
        logWarning("Cloudflared installation failed or requires manual installation.");
        logWarning("You can still use CodeMux on your local network.");
      }
    } else {
      logWarning("Skipped Cloudflared installation. Public access feature will not be available.");
    }
  }

  // Final dependency check
  const finalDeps = checkDependencies();
  const allRequired = finalDeps.filter((d) => d.required).every((d) => d.installed);
  if (!allRequired) {
    console.log("\n");
    logStep("Final status check");
    printDependencyTable(finalDeps);
    logWarning("Some required dependencies are missing. Please install them manually before starting.");
    process.exit(1);
  }

  // Auth provider setup
  logStep("Checking auth providers");
  printAuthStatus();

  if (!hasAuthProvider()) {
    logWarning("No auth provider configured. You need to authenticate with at least one provider.");
    const shouldAuth = await confirm("Run opencode auth login now?");

    if (shouldAuth) {
      await runAuthLogin();
      printAuthStatus();
    }
  } else {
    const addMore = await confirm("Add another auth provider?");
    if (addMore) {
      await runAuthLogin();
      printAuthStatus();
    }
  }

  // Final message
  console.log("\n" + "=".repeat(60));
  if (hasAuthProvider()) {
    logSuccess("Setup complete! Run `bun run start` to start the project.");
  } else {
    logWarning("Setup complete, but no auth provider configured.");
    log("  Run `opencode auth login` to add a provider later.", colors.yellow);
  }
  console.log("=".repeat(60) + "\n");
}

main().catch((err) => {
  logError(`Error occurred: ${err.message}`);
  process.exit(1);
});

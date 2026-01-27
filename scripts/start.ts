import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import * as readline from "readline";

const isWindows = process.platform === "win32";

// ANSI colors
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

// Generate 6-digit auth code
function generateAuthCode(): string {
  return Math.random().toString().slice(2, 8);
}

// Check if a command exists in PATH
function commandExists(command: string): boolean {
  const checkCmd = isWindows ? "where" : "which";
  const result = spawnSync(checkCmd, [command], { stdio: "pipe" });
  return result.status === 0;
}

// Ask user for confirmation
async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      `${colors.yellow}? ${question} (y/N): ${colors.reset}`,
      (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
      },
    );
  });
}

// Execute install command
async function runInstallCommand(
  command: string,
  args: string[],
): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(
      `${colors.cyan}  Running: ${command} ${args.join(" ")}${colors.reset}`,
    );

    const proc = spawn(command, args, {
      stdio: "inherit",
      shell: isWindows,
    });

    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

// Install OpenCode CLI
async function installOpenCode(): Promise<boolean> {
  console.log(`${colors.cyan}> Installing OpenCode CLI...${colors.reset}`);

  if (isWindows) {
    return runInstallCommand("powershell", [
      "-Command",
      "irm https://opencode.ai/install.ps1 | iex",
    ]);
  } else {
    return runInstallCommand("bash", [
      "-c",
      "curl -fsSL https://opencode.ai/install.sh | bash",
    ]);
  }
}

// Check dependencies
async function checkDependencies(): Promise<boolean> {
  console.log(`\n${colors.cyan}> Checking dependencies...${colors.reset}`);

  // Check opencode
  if (!commandExists("opencode")) {
    console.log(
      `${colors.red}[x] OpenCode CLI is not installed${colors.reset}`,
    );

    const shouldInstall = await confirm("Install OpenCode CLI now?");
    if (shouldInstall) {
      const success = await installOpenCode();
      if (success) {
        console.log(
          `${colors.green}[ok] OpenCode CLI installed successfully${colors.reset}`,
        );
        // Re-check (PATH may need to be reloaded in some cases)
        if (!commandExists("opencode")) {
          console.log(
            `${colors.yellow}[!] Installation completed, but you may need to restart your terminal for PATH to take effect${colors.reset}`,
          );
          console.log(
            `${colors.yellow}    Please restart your terminal and run bun run start again${colors.reset}`,
          );
          return false;
        }
      } else {
        console.log(
          `${colors.red}[x] Installation failed. Please install manually:${colors.reset}`,
        );
        if (isWindows) {
          console.log(
            `${colors.cyan}  irm https://opencode.ai/install.ps1 | iex${colors.reset}`,
          );
        } else {
          console.log(
            `${colors.cyan}  curl -fsSL https://opencode.ai/install.sh | bash${colors.reset}`,
          );
        }
        return false;
      }
    } else {
      console.log(
        `${colors.yellow}[!] OpenCode CLI is a required dependency${colors.reset}`,
      );
      console.log(
        `${colors.yellow}    Run bun run setup to install all dependencies${colors.reset}`,
      );
      return false;
    }
  } else {
    console.log(`${colors.green}[ok] OpenCode CLI is installed${colors.reset}`);
  }

  // Hint about cloudflared (optional)
  if (!commandExists("cloudflared")) {
    console.log(
      `${colors.yellow}[!] Cloudflared is not installed (optional, for public access feature)${colors.reset}`,
    );
    console.log(
      `${colors.yellow}    Run bun run setup to install${colors.reset}`,
    );
  } else {
    console.log(`${colors.green}[ok] Cloudflared is installed${colors.reset}`);
  }

  return true;
}

async function main() {
  // Check dependencies first
  const depsOk = await checkDependencies();
  if (!depsOk) {
    process.exit(1);
  }

  // Check if official app is built
  const officialAppPath = path.join(
    process.cwd(),
    "public",
    "opencode-app",
    "index.html",
  );
  if (!fs.existsSync(officialAppPath)) {
    console.log(
      `${colors.yellow}[!] Official OpenCode App not built${colors.reset}`,
    );
    console.log(
      `${colors.yellow}    Run 'bun run build:official-app' to enable Official UI feature${colors.reset}`,
    );
  } else {
    console.log(
      `${colors.green}[ok] Official OpenCode App is available${colors.reset}`,
    );
  }

  const authCode = generateAuthCode();
  const authCodePath = path.join(process.cwd(), ".auth-code");

  // Save auth code to file
  fs.writeFileSync(authCodePath, authCode);

  console.log("\n" + "=".repeat(60));
  console.log("Starting OpenCode Remote");
  console.log("=".repeat(60));
  console.log(`\nAccess Code: ${authCode}\n`);

  // 1. Start OpenCode Server
  console.log("Starting OpenCode Server...");
  const opencodeProcess = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
    {
      stdio: "inherit",
      shell: isWindows,
      env: { ...process.env },
    },
  );

  // Wait for OpenCode Server to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // 2. Start Vite dev server
  console.log("Starting Web UI...");
  const viteProcess = spawn("vite", ["--host", "--port", "5174"], {
    stdio: "inherit",
    shell: isWindows,
    env: {
      ...process.env,
      VITE_OPENCODE_API: "http://localhost:4096",
    },
  });

  console.log("\n" + "=".repeat(60));
  console.log("All services started!");
  console.log("Web UI: http://localhost:5174");
  console.log(`Use code: ${authCode}`);
  console.log("=".repeat(60) + "\n");

  // Handle exit signals
  const cleanup = () => {
    console.log("\nShutting down...");
    opencodeProcess.kill();
    viteProcess.kill();
    if (fs.existsSync(authCodePath)) {
      fs.unlinkSync(authCodePath);
    }
    process.exit();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch(console.error);

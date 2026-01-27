import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const isWindows = process.platform === "win32";

const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

function log(msg: string) {
  console.log(`${colors.cyan}> ${msg}${colors.reset}`);
}

function success(msg: string) {
  console.log(`${colors.green}[ok] ${msg}${colors.reset}`);
}

function error(msg: string) {
  console.log(`${colors.red}[x] ${msg}${colors.reset}`);
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    log(`Running: ${command} ${args.join(" ")}`);
    const proc = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: isWindows,
    });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

async function main() {
  const projectRoot = process.cwd();
  const submodulePath = path.join(projectRoot, "opencode");
  const appPath = path.join(submodulePath, "packages", "app");
  const outputPath = path.join(projectRoot, "public", "opencode-app");

  console.log("\n" + "=".repeat(60));
  console.log("Building Official OpenCode App");
  console.log("=".repeat(60) + "\n");

  // Check submodule exists
  if (!fs.existsSync(appPath)) {
    error("OpenCode submodule not found. Run: git submodule update --init");
    process.exit(1);
  }

  // Check if node_modules exists in submodule
  const nodeModulesPath = path.join(submodulePath, "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    log(
      "Installing dependencies in opencode submodule (first time may take a while)...",
    );
    const installOk = await runCommand("bun", ["install"], submodulePath);
    if (!installOk) {
      error("Failed to install dependencies");
      process.exit(1);
    }
    success("Dependencies installed");
  } else {
    success("Dependencies already installed");
  }

  // Build using the submodule's own build command, then copy output
  log("Building app using monorepo build system...");

  // Run the build in packages/app directory
  // The app's vite.config uses @tailwindcss/vite (v4), not postcss
  // We need to ensure it doesn't inherit parent's postcss.config.js

  // Create a temporary vite config that sets the output path
  const buildConfigPath = path.join(appPath, "vite.build.config.ts");
  const buildConfig = `import { defineConfig, mergeConfig } from "vite"
import baseConfig from "./vite.config"

export default mergeConfig(baseConfig, defineConfig({
  base: "/opencode-app/",
  build: {
    outDir: "${outputPath.replace(/\\/g, "/")}",
    emptyOutDir: true,
  },
  // Explicitly disable postcss config lookup to prevent inheriting parent's tailwind v3 config
  css: {
    postcss: {},
  },
}))
`;
  fs.writeFileSync(buildConfigPath, buildConfig);

  // Run vite build from the app directory
  const buildOk = await runCommand(
    "bunx",
    ["--bun", "vite", "build", "--config", "vite.build.config.ts"],
    appPath,
  );

  // Cleanup temp config
  if (fs.existsSync(buildConfigPath)) {
    fs.unlinkSync(buildConfigPath);
  }

  if (!buildOk) {
    error("Build failed");
    process.exit(1);
  }

  success(`App built to ${outputPath}`);

  // Copy necessary static files from app's public folder
  const staticFiles = [
    "favicon-96x96-v3.png",
    "favicon-v3.svg",
    "favicon-v3.ico",
    "apple-touch-icon-v3.png",
    "oc-theme-preload.js",
    "site.webmanifest",
  ];

  const publicSrc = path.join(appPath, "public");
  if (fs.existsSync(publicSrc)) {
    for (const file of staticFiles) {
      const src = path.join(publicSrc, file);
      const dest = path.join(outputPath, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    }
    success("Static files copied");
  }

  console.log("\n" + "=".repeat(60));
  console.log("Build complete!");
  console.log(`Output: ${outputPath}`);
  console.log("=".repeat(60) + "\n");
}

main().catch((err) => {
  error(err.message);
  process.exit(1);
});

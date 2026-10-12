import { spawnSync } from "node:child_process";

const maxAttempts = Number.parseInt(process.env.CI_BUN_INSTALL_ATTEMPTS ?? "3", 10);
const bunCommand = "bun";

function runBun(args: string[]): number {
  const result = spawnSync(bunCommand, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  console.log(`[ci-install] bun install attempt ${attempt}/${maxAttempts}`);
  const status = runBun(["install", "--frozen-lockfile"]);
  if (status === 0) {
    process.exit(0);
  }

  if (attempt === maxAttempts) {
    process.exit(status);
  }

  console.warn(`[ci-install] bun install failed with exit code ${status}; clearing Bun cache before retry`);
  runBun(["pm", "cache", "rm"]);
  await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
}

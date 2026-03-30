import readline from "readline";
import type { PendingRequest } from "../shared/device-store-types";
import { deviceStore } from "./device-store";
import { colors } from "./utils";

type Command = "help" | "access-code" | "access-requests" | "status";

function usage(): void {
  console.log(`
${colors.bold}${colors.cyan}CodeMux Server Auth Helper${colors.reset}
`);
  console.log("Usage:");
  console.log("  bun scripts/server-auth.ts access-code [--plain]");
  console.log("  bun scripts/server-auth.ts access-requests [--count]");
  console.log("  bun scripts/server-auth.ts status");
}

function formatAge(createdAt: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));

  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago`;
}

function summarizeRequest(request: PendingRequest): string {
  return `${request.id}  ${request.device.name}  ${request.device.platform}/${request.device.browser}  ${request.ip}  ${formatAge(request.createdAt)}`;
}

function printAccessCode(plain: boolean): void {
  const code = deviceStore.getAccessCode();
  if (plain) {
    console.log(code);
    return;
  }

  console.log(`${colors.green}[ok]${colors.reset} Access code: ${colors.bold}${code}${colors.reset}`);
}

function getPendingRequests(): PendingRequest[] {
  return deviceStore.listPendingRequests();
}

function printPendingRequests(requests: PendingRequest[]): void {
  if (requests.length === 0) {
    console.log(`${colors.yellow}[!]${colors.reset} No pending requests.`);
    return;
  }

  console.log(`${colors.green}[ok]${colors.reset} Pending requests (${requests.length}):`);
  for (const request of requests) {
    console.log(`  ${summarizeRequest(request)}`);
  }
}

function approveRequest(requestId: string): boolean {
  const approved = deviceStore.approveRequest(requestId);
  if (!approved) {
    console.log(`${colors.yellow}[!]${colors.reset} Request is no longer pending: ${requestId}`);
    return false;
  }

  console.log(`${colors.green}[ok]${colors.reset} Approved request ${requestId} for ${approved.device.name}.`);
  return true;
}

function denyRequest(requestId: string): boolean {
  const denied = deviceStore.denyRequest(requestId);
  if (!denied) {
    console.log(`${colors.yellow}[!]${colors.reset} Request is no longer pending: ${requestId}`);
    return false;
  }

  console.log(`${colors.green}[ok]${colors.reset} Denied request ${requestId} for ${denied.device.name}.`);
  return true;
}

function printStatus(): void {
  printAccessCode(false);
  printPendingRequests(getPendingRequests());
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function handleAccessRequests(countOnly: boolean): Promise<void> {
  const requests = getPendingRequests();

  if (countOnly) {
    console.log(String(requests.length));
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printPendingRequests(requests);
    return;
  }

  if (requests.length === 0) {
    printPendingRequests(requests);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    for (const request of requests) {
      const fresh = deviceStore.getPendingRequest(request.id);
      if (!fresh || fresh.status !== "pending") {
        continue;
      }

      console.log(`
${colors.bold}Pending request${colors.reset}`);
      console.log(`  ${summarizeRequest(fresh)}`);

      const answer = (await ask(
        rl,
        `${colors.yellow}?${colors.reset} [a]pprove / [d]eny / [s]kip / [q]uit: `,
      )).trim().toLowerCase();

      if (answer === "q" || answer === "quit") {
        console.log(`${colors.yellow}[!]${colors.reset} Stopped processing pending requests.`);
        break;
      }

      if (answer === "a" || answer === "approve" || answer === "y" || answer === "yes") {
        approveRequest(fresh.id);
      } else if (answer === "d" || answer === "deny" || answer === "n" || answer === "no") {
        denyRequest(fresh.id);
      } else {
        console.log(`${colors.yellow}[!]${colors.reset} Left request pending: ${fresh.id}`);
      }
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2) as [Command | undefined, ...string[]];

  switch (command) {
    case "access-code":
      printAccessCode(args.includes("--plain"));
      break;
    case "access-requests":
      await handleAccessRequests(args.includes("--count"));
      break;
    case "status":
      printStatus();
      break;
    case "help":
    case undefined:
      usage();
      break;
    default:
      console.error(`${colors.red}[x]${colors.reset} Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`${colors.red}[x]${colors.reset} ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

import { execFileSync } from "node:child_process";

function processParents(snapshot: string): Map<number, number> {
  const parents = new Map<number, number>();
  const ambiguous = new Set<number>();
  for (const line of snapshot.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid) || pid <= 1 || parentPid <= 0) continue;
    if (parents.has(pid) && parents.get(pid) !== parentPid) ambiguous.add(pid);
    parents.set(pid, parentPid);
  }
  for (const pid of ambiguous) parents.delete(pid);
  return parents;
}

function descendantPids(parents: Map<number, number>, rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, parentPid] of parents) {
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }

  const descendants: number[] = [];
  const visited = new Set([rootPid, process.pid, process.ppid]);
  const queue = [rootPid];
  for (let index = 0; index < queue.length; index++) {
    for (const pid of children.get(queue[index]) ?? []) {
      if (visited.has(pid)) continue;
      visited.add(pid);
      queue.push(pid);
      descendants.push(pid);
    }
  }
  return descendants.reverse();
}

function processSnapshot(): string | undefined {
  try {
    const options = {
      encoding: "utf8" as const,
      timeout: 5_000,
      killSignal: "SIGKILL" as const,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
    };
    return process.platform === "win32"
      ? execFileSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }",
      ], options)
      : execFileSync("ps", ["-A", "-o", "pid=,ppid="], options);
  } catch {
    // Unknown ownership is never a reason to kill a process by name or port.
    return;
  }
}

function terminatePids(pids: number[]): void {
  for (const pid of pids) {
    try {
      // Kill leaves first, while their ancestry is still visible in the snapshot.
      process.kill(pid, "SIGKILL");
    } catch {
      // Exited or inaccessible children must not prevent immediate host exit.
    }
  }
}

/** Emergency cleanup before immediate host exit; never runs persistence or shutdown hooks. */
export function terminateOwnedChildren(): void {
  const snapshot = processSnapshot();
  if (snapshot === undefined) return;
  terminatePids(descendantPids(processParents(snapshot), process.pid));
}

/** Force-stop one directly owned child and its descendants without touching sibling children. */
export function terminateOwnedProcessTree(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) return;
  const snapshot = processSnapshot();
  if (snapshot === undefined) return;
  const parents = processParents(snapshot);
  if (parents.get(pid) !== process.pid) return;
  terminatePids([...descendantPids(parents, pid), pid]);
}

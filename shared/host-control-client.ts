import fs from "node:fs/promises";
import path from "node:path";
import { HOST_CONTROL_FILENAME, HostControlError, type HostControlMetadata } from "./host-control-types";

export { HostControlError } from "./host-control-types";

export interface HostControlClientOptions {
  timeoutMs?: number;
  expectedInstanceId?: string;
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/** Discovery is read-only: an absent runtime must not create a new data store. */
export async function readHostControlMetadata(dataPath: string): Promise<HostControlMetadata | null> {
  try {
    const canonicalPath = await fs.realpath(dataPath);
    const metadataFile = await fs.open(path.join(canonicalPath, HOST_CONTROL_FILENAME), "r");
    let value: unknown;
    try {
      if ((await metadataFile.stat()).size > 16_384) throw new Error("Metadata is too large");
      value = JSON.parse(await metadataFile.readFile("utf8"));
    } finally {
      await metadataFile.close();
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid metadata");
    const metadata = value as Record<string, unknown>;
    if (metadata.version !== 1
      || typeof metadata.instanceId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(metadata.instanceId)
      || !Number.isSafeInteger(metadata.pid) || (metadata.pid as number) < 1
      || !Number.isSafeInteger(metadata.port) || (metadata.port as number) < 1 || (metadata.port as number) > 65_535
      || metadata.dataPath !== canonicalPath
      || typeof metadata.ownerCredential !== "string" || !/^[0-9a-f]{64}$/.test(metadata.ownerCredential)) {
      throw new Error("Invalid metadata");
    }
    return metadata as unknown as HostControlMetadata;
  } catch (error) {
    if (isMissing(error)) return null;
    throw new HostControlError("INVALID_METADATA", "Cannot read valid CodeMux host control metadata");
  }
}

export async function callHost<T = unknown>(
  dataPath: string,
  method: string,
  args: unknown[] = [],
  options: HostControlClientOptions = {},
): Promise<T> {
  const metadata = await readHostControlMetadata(dataPath);
  if (!metadata) throw new HostControlError("NOT_RUNNING", "No CodeMux host is running for this data directory");
  if (options.expectedInstanceId !== undefined && metadata.instanceId !== options.expectedInstanceId) {
    throw new HostControlError("INSTANCE_CHANGED", "The CodeMux host instance changed; reconnect before retrying");
  }
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(`http://127.0.0.1:${metadata.port}/control`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${metadata.ownerCredential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method, args }),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    body = await response.json();
  } catch {
    throw new HostControlError("UNAVAILABLE", "CodeMux host control is unavailable or did not respond");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HostControlError("REQUEST_FAILED", "Invalid CodeMux host control response");
  }
  const result = body as Record<string, unknown>;
  if (!response.ok || typeof result.error === "string") {
    const message = typeof result.error === "string"
      ? result.error.replaceAll(metadata.ownerCredential, "[redacted]").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512)
      : "CodeMux host operation failed";
    throw new HostControlError(response.status === 401 ? "UNAUTHORIZED" : "REQUEST_FAILED", message);
  }
  return result.result as T;
}

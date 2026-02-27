// ============================================================================
// Copilot CLI Adapter — GitHub Copilot CLI ACP integration
// ============================================================================

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { AcpBaseAdapter } from "./acp-base-adapter";
import { sessionStore } from "../services/session-store";
import { copilotLog } from "../services/logger";
import type {
  EngineType,
  EngineCapabilities,
  UnifiedSession,
} from "../../../src/types/unified";

interface SessionRow {
  id: string;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  summary: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export class CopilotAdapter extends AcpBaseAdapter {
  readonly engineType: EngineType = "copilot";

  private binaryPath: string;
  private dbPath: string;

  constructor(options?: { binaryPath?: string }) {
    super();
    this.binaryPath = options?.binaryPath ?? "copilot";
    this.dbPath = join(homedir(), ".copilot", "session-store.db");
  }

  protected getBinary(): string {
    return this.binaryPath;
  }

  protected getArgs(): string[] {
    return ["--acp"];
  }

  getCapabilities(): EngineCapabilities {
    return {
      providerModelHierarchy: false,
      dynamicModes: true,
      messageCancellation: true,
      permissionAlways: true,
      imageAttachment: true,
      loadSession: true,
      listSessions: true,
      availableModes: this.getModes(),
    };
  }

  // ---------------------------------------------------------------------------
  // Override listSessions to read from Copilot's SQLite DB as primary source
  // ---------------------------------------------------------------------------
  async listSessions(directory?: string): Promise<UnifiedSession[]> {
    // 1. Try ACP RPC as supplementary source (if CLI is connected)
    //    super.listSessions has its own try/catch for RPC failures
    await super.listSessions(directory).catch(() => {});

    // 2. Read sessions from SQLite DB — DB is primary, overwrites RPC entries
    await this.loadSessionsFromDb();

    // 3. Return all sessions from memory, optionally filtered by directory
    const allSessions = Array.from(this.sessions.values());
    const normalizedDir = directory?.replaceAll("\\", "/");
    const filtered = normalizedDir
      ? allSessions.filter((s) => s.directory === normalizedDir)
      : allSessions;
    sessionStore.mergeSessions(filtered, this.engineType);
    return filtered;
  }

  // ---------------------------------------------------------------------------
  // Override deleteSession to also remove the record from SQLite DB
  // ---------------------------------------------------------------------------
  async deleteSession(sessionId: string): Promise<void> {
    await super.deleteSession(sessionId);
    await this.deleteSessionFromDb(sessionId);
  }

  private async deleteSessionFromDb(sessionId: string): Promise<void> {
    if (!existsSync(this.dbPath)) return;

    let db: Database | null = null;
    try {
      const SQL = await initSqlJs({
        locateFile: (file: string) => {
          try {
            const sqlJsDir = require
              .resolve("sql.js")
              .replace(/[/\\][^/\\]+$/, "");
            return join(sqlJsDir, "..", "dist", file);
          } catch {
            return file;
          }
        },
      });
      const fileBuffer = readFileSync(this.dbPath);
      db = new SQL.Database(fileBuffer);

      db.run("DELETE FROM sessions WHERE id = ?", [sessionId]);

      // Write modified DB back to disk
      const data = db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
    } catch (err) {
      copilotLog.error("Failed to delete session from DB:", err);
    } finally {
      if (db) db.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Read sessions from ~/.copilot/session-store.db into the sessions Map
  // ---------------------------------------------------------------------------
  private async loadSessionsFromDb(): Promise<void> {
    if (!existsSync(this.dbPath)) {
      copilotLog.warn(
        `session-store.db not found at ${this.dbPath}`
      );
      return;
    }

    let db: Database | null = null;
    try {
      const SQL = await initSqlJs({
        // In Electron main process, sql.js needs explicit WASM file location.
        // Since externalizeDepsPlugin keeps sql.js in node_modules, the WASM
        // file sits alongside the JS entry. Use require.resolve to find it.
        locateFile: (file: string) => {
          try {
            const sqlJsDir = require
              .resolve("sql.js")
              .replace(/[/\\][^/\\]+$/, "");
            return join(sqlJsDir, "..", "dist", file);
          } catch {
            return file;
          }
        },
      });
      const fileBuffer = readFileSync(this.dbPath);
      db = new SQL.Database(fileBuffer);

      const stmt = db.prepare(
        "SELECT id, cwd, repository, branch, summary, created_at, updated_at FROM sessions"
      );

      while (stmt.step()) {
        const row = stmt.getAsObject() as unknown as SessionRow;

        const session: UnifiedSession = {
          id: row.id,
          engineType: this.engineType,
          directory: (row.cwd || homedir()).replaceAll("\\", "/"),
          title: row.summary ?? undefined,
          time: {
            created: row.created_at
              ? new Date(row.created_at).getTime()
              : Date.now(),
            updated: row.updated_at
              ? new Date(row.updated_at).getTime()
              : Date.now(),
          },
        };

        // DB is primary source — always overwrite any existing entry
        this.sessions.set(session.id, session);
      }

      stmt.free();
    } catch (err) {
      copilotLog.error("Failed to read session-store.db:", err);
    } finally {
      if (db) {
        db.close();
      }
    }
  }
}

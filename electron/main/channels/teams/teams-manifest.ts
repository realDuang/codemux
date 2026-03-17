// ============================================================================
// Teams App Package Generator
// Auto-generates manifest.json + placeholder icons + zip for sideloading.
// ============================================================================

import fs from "fs";
import path from "path";
import { deflateSync } from "node:zlib";
import { app } from "electron";
import { channelLog } from "../../services/logger";

const LOG_PREFIX = "[Teams]";

function getTeamsAppDir(): string {
  if (!app.isPackaged) {
    return path.join(process.cwd(), ".channels", "teams-app");
  }
  return path.join(app.getPath("userData"), "channels", "teams-app");
}

function getTeamsAppZipPath(): string {
  return path.join(path.dirname(getTeamsAppDir()), "teams-app.zip");
}

/** Generate minimal 1x1 PNG buffer (colored or outline) */
function generatePlaceholderPng(color: [number, number, number]): Buffer {
  // Minimal valid PNG: 1x1 pixel, RGBA
  const [r, g, b] = color;
  const header = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  ]);

  function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff];
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }

  function makeChunk(type: string, data: Buffer): Buffer {
    const typeData = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeData));
    return Buffer.concat([len, typeData, crc]);
  }

  // IHDR: 1x1, 8-bit RGBA
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width
  ihdrData.writeUInt32BE(1, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA

  // IDAT: raw pixel data (filter byte 0 + RGBA)
  const rawRow = Buffer.from([0, r, g, b, 255]);
  const compressed = deflateSync(rawRow);

  return Buffer.concat([
    header,
    makeChunk("IHDR", ihdrData),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

function buildManifest(botId: string): object {
  return {
    $schema:
      "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
    manifestVersion: "1.17",
    version: "1.0.0",
    id: botId,
    name: {
      short: "CodeMux Bot",
      full: "CodeMux AI Coding Assistant",
    },
    description: {
      short: "AI coding assistant via Teams",
      full: "Connect to CodeMux AI coding engines (OpenCode, Copilot, Claude Code) through Microsoft Teams.",
    },
    developer: {
      name: "CodeMux",
      websiteUrl: "https://github.com",
      privacyUrl: "https://github.com",
      termsOfUseUrl: "https://github.com",
    },
    icons: {
      color: "color.png",
      outline: "outline.png",
    },
    accentColor: "#4F46E5",
    bots: [
      {
        botId,
        scopes: ["personal", "team", "groupChat"],
        commandLists: [
          {
            scopes: ["personal"],
            commands: [
              { title: "help", description: "Show available commands" },
              { title: "project", description: "View and switch projects" },
              { title: "session new", description: "Create new session" },
              { title: "session list", description: "View session list" },
              { title: "cancel", description: "Cancel current message" },
            ],
          },
          {
            scopes: ["team", "groupChat"],
            commands: [
              { title: "help", description: "Show available commands" },
              { title: "cancel", description: "Cancel current message" },
              { title: "status", description: "View session info" },
              { title: "mode", description: "Switch mode (agent/plan/build)" },
              { title: "model list", description: "List available models" },
              { title: "history", description: "View session history" },
            ],
          },
        ],
      },
    ],
    validDomains: [],
  };
}

/** Create zip buffer from files (using deflate-raw via zlib) */
function createZip(
  files: Array<{ name: string; data: Buffer }>
): Buffer {
  // Minimal ZIP implementation (store method, no compression — good enough for small manifests)
  const centralEntries: Buffer[] = [];
  const localEntries: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf-8");
    const { deflateRawSync } = require("zlib") as typeof import("zlib");
    const compressed = deflateRawSync(file.data);

    // CRC32 of uncompressed data
    const { crc32: crc32Fn } = require("zlib") as { crc32: (data: Buffer) => number };
    let crc: number;
    if (typeof crc32Fn === "function") {
      crc = crc32Fn(file.data);
    } else {
      // Fallback CRC32
      let c = 0xffffffff;
      const table: number[] = [];
      for (let n = 0; n < 256; n++) {
        let v = n;
        for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
        table[n] = v >>> 0;
      }
      for (let i = 0; i < file.data.length; i++) {
        c = (c >>> 8) ^ table[(c ^ file.data[i]) & 0xff];
      }
      crc = (c ^ 0xffffffff) >>> 0;
    }

    // Local file header
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // compression: deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc >>> 0, 14); // crc32
    local.writeUInt32LE(compressed.length, 18); // compressed size
    local.writeUInt32LE(file.data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuffer.length, 26); // file name length
    local.writeUInt16LE(0, 28); // extra field length
    nameBuffer.copy(local, 30);

    localEntries.push(Buffer.concat([local, compressed]));

    // Central directory header
    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(8, 10); // compression: deflate
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc >>> 0, 16); // crc32
    central.writeUInt32LE(compressed.length, 20); // compressed size
    central.writeUInt32LE(file.data.length, 24); // uncompressed size
    central.writeUInt16LE(nameBuffer.length, 28); // file name length
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // file comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal file attributes
    central.writeUInt32LE(0, 38); // external file attributes
    central.writeUInt32LE(offset, 42); // relative offset of local header
    nameBuffer.copy(central, 46);

    centralEntries.push(central);
    offset += local.length + compressed.length;
  }

  const centralDirOffset = offset;
  const centralDir = Buffer.concat(centralEntries);
  const centralDirSize = centralDir.length;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk number with central dir
  eocd.writeUInt16LE(files.length, 8); // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12); // central dir size
  eocd.writeUInt32LE(centralDirOffset, 16); // central dir offset

  return Buffer.concat([...localEntries, centralDir, eocd]);
}

/**
 * Ensure the Teams app package (manifest.json + icons + zip) exists.
 * Creates it if missing. Does NOT overwrite existing files.
 */
export async function ensureTeamsAppPackage(botId: string): Promise<string> {
  const appDir = getTeamsAppDir();
  const zipPath = getTeamsAppZipPath();

  // Skip if zip already exists
  if (fs.existsSync(zipPath)) {
    channelLog.info(`${LOG_PREFIX} App package already exists: ${zipPath}`);
    return zipPath;
  }

  channelLog.info(`${LOG_PREFIX} Generating Teams app package...`);

  // Ensure directory
  if (!fs.existsSync(appDir)) {
    fs.mkdirSync(appDir, { recursive: true });
  }

  // Generate files
  const manifest = buildManifest(botId);
  const manifestJson = JSON.stringify(manifest, null, 2);
  const colorPng = generatePlaceholderPng([79, 70, 229]); // #4F46E5 indigo
  const outlinePng = generatePlaceholderPng([255, 255, 255]); // white

  // Write individual files
  fs.writeFileSync(path.join(appDir, "manifest.json"), manifestJson);
  fs.writeFileSync(path.join(appDir, "color.png"), colorPng);
  fs.writeFileSync(path.join(appDir, "outline.png"), outlinePng);

  // Create zip
  const zipBuffer = createZip([
    { name: "manifest.json", data: Buffer.from(manifestJson) },
    { name: "color.png", data: colorPng },
    { name: "outline.png", data: outlinePng },
  ]);
  fs.writeFileSync(zipPath, zipBuffer);

  channelLog.info(`${LOG_PREFIX} App package generated: ${zipPath}`);
  return zipPath;
}

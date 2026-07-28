#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const MAX_CONFIG_BYTES = 5 * 1024 * 1024;
const MANAGED_KEYS = [
  "cwd",
  "enabled",
  "required",
  "startup_timeout_sec",
  "tool_timeout_sec",
  "default_tools_approval_mode",
];

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tomlString(value) {
  return JSON.stringify(value);
}

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!["--config", "--cwd", "--server"].includes(name)) {
      throw new Error(`Unknown argument: ${name}`);
    }
    const value = args[index + 1];
    if (value === undefined || value === "") {
      throw new Error(`${name} requires a value.`);
    }
    parsed[name.slice(2)] = value;
    index += 1;
  }
  for (const required of ["config", "cwd", "server"]) {
    if (parsed[required] === undefined) {
      throw new Error(`--${required} is required.`);
    }
  }
  return parsed;
}

function updateServerSection(source, { cwd, server }) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = source.endsWith("\n");
  const lines = source.split(/\r?\n/);
  if (hadFinalNewline) {
    lines.pop();
  }

  const escapedServer = escapeRegularExpression(server);
  const headerPattern = new RegExp(`^\\s*\\[mcp_servers\\.${escapedServer}\\]\\s*(?:#.*)?$`);
  const headerIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (headerPattern.test(lines[index])) {
      headerIndexes.push(index);
    }
  }
  if (headerIndexes.length !== 1) {
    throw new Error(
      `Expected exactly one [mcp_servers.${server}] table, found ${headerIndexes.length}.`,
    );
  }

  const headerIndex = headerIndexes[0];
  let sectionEnd = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }

  const assignmentPattern = /^\s*([A-Za-z0-9_-]+)\s*=/;
  const retained = [];
  for (let index = headerIndex + 1; index < sectionEnd; index += 1) {
    const match = assignmentPattern.exec(lines[index]);
    if (match !== null && MANAGED_KEYS.includes(match[1])) {
      continue;
    }
    retained.push(lines[index]);
  }
  while (retained.at(-1)?.trim() === "") {
    retained.pop();
  }

  const managedLines = [
    `cwd = ${tomlString(cwd)}`,
    "enabled = true",
    "required = true",
    "startup_timeout_sec = 10",
    "tool_timeout_sec = 360",
    'default_tools_approval_mode = "writes"',
  ];
  const replacement = [...retained, ...managedLines, ""];
  lines.splice(headerIndex + 1, sectionEnd - headerIndex - 1, ...replacement);
  const updated = lines.join(newline);
  return hadFinalNewline ? `${updated}${newline}` : updated;
}

export async function configureCodexMcpOptions({ configPath, cwd, server }) {
  if (!path.isAbsolute(configPath) || !path.isAbsolute(cwd)) {
    throw new Error("Config and cwd paths must be absolute.");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(server)) {
    throw new Error("Server name contains unsupported characters.");
  }

  const metadata = await lstat(configPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Codex config must be a regular file, not a symbolic link.");
  }
  if (metadata.size > MAX_CONFIG_BYTES) {
    throw new Error(`Codex config exceeds ${MAX_CONFIG_BYTES} bytes.`);
  }

  const bytes = await readFile(configPath);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const updated = updateServerSection(source, { cwd, server });
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryFile;
  try {
    temporaryFile = await open(temporaryPath, "wx", metadata.mode & 0o777);
    await temporaryFile.writeFile(updated, { encoding: "utf8" });
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, configPath);
  } catch (error) {
    await temporaryFile?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  await configureCodexMcpOptions({
    configPath: args.config,
    cwd: args.cwd,
    server: args.server,
  });
  process.stdout.write(`Configured Codex MCP options for ${args.server}.\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`configure-codex: ${message}\n`);
    process.exitCode = 1;
  });
}

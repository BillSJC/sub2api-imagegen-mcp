#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

if (process.env.SUB2API_API_KEY !== undefined) {
  process.stderr.write("fake-codex: inline API key leaked into a subprocess\n");
  process.exit(72);
}

function fail(message, code = 1) {
  process.stderr.write(`fake-codex: ${message}\n`);
  process.exit(code);
}

function tomlString(value) {
  return JSON.stringify(value);
}

function tableExists(source, server) {
  const header = `[mcp_servers.${server}]`;
  return source.split(/\r?\n/).some((line) => line.trim() === header);
}

function removeServerTables(source, server) {
  const lines = source.split(/\r?\n/);
  const retained = [];
  let skip = false;
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section !== null) {
      const name = section[1];
      skip = name === `mcp_servers.${server}` || name.startsWith(`mcp_servers.${server}.`);
    }
    if (!skip) {
      retained.push(line);
    }
  }
  return `${retained.join("\n").trimEnd()}\n`;
}

const [scope, action, server, ...rest] = process.argv.slice(2);
if (scope !== "mcp" || action === undefined || server === undefined) {
  fail("expected mcp <get|remove|add> <server>");
}
if (!/^[A-Za-z0-9_-]+$/.test(server)) {
  fail("unsupported server name");
}

const codexHome = process.env.CODEX_HOME;
if (codexHome === undefined || !path.isAbsolute(codexHome)) {
  fail("CODEX_HOME must be absolute");
}
mkdirSync(codexHome, { mode: 0o700, recursive: true });
const configPath = path.join(codexHome, "config.toml");
const source = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";

if (action === "get") {
  if (!tableExists(source, server)) {
    process.exit(1);
  }
  if (rest.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ name: server, enabled: true })}\n`);
  } else {
    process.stdout.write(`${server}\n`);
  }
  process.exit(0);
}

if (action === "remove") {
  if (!tableExists(source, server)) {
    process.exit(1);
  }
  writeFileSync(configPath, removeServerTables(source, server), { mode: 0o600 });
  process.exit(0);
}

if (action !== "add") {
  fail(`unsupported action: ${action}`);
}

const separator = rest.indexOf("--");
if (separator < 0 || separator === rest.length - 1) {
  fail("add requires -- followed by a command");
}
const optionArgs = rest.slice(0, separator);
const commandArgs = rest.slice(separator + 1);
const environment = [];
for (let index = 0; index < optionArgs.length; index += 1) {
  if (optionArgs[index] !== "--env" || optionArgs[index + 1] === undefined) {
    fail("unsupported add option");
  }
  const assignment = optionArgs[index + 1];
  const equals = assignment.indexOf("=");
  if (equals <= 0) {
    fail("invalid environment assignment");
  }
  environment.push([assignment.slice(0, equals), assignment.slice(equals + 1)]);
  index += 1;
}

if (tableExists(source, server)) {
  fail("server already exists");
}
const block = [
  "",
  `[mcp_servers.${server}]`,
  `command = ${tomlString(commandArgs[0])}`,
  `args = [${commandArgs
    .slice(1)
    .map((argument) => tomlString(argument))
    .join(", ")}]`,
  "",
  `[mcp_servers.${server}.env]`,
  ...environment.map(([name, value]) => `${name} = ${tomlString(value)}`),
  "",
].join("\n");
appendFileSync(configPath, block, { mode: 0o600 });

if (process.env.FAKE_CODEX_FAIL_AFTER_ADD === "1") {
  fail("intentional post-add failure", 70);
}

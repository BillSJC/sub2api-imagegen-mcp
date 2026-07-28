#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadConfig, redactedConfig } from "./config.js";
import { publicErrorMessage, SafeError } from "./errors.js";
import { createServer } from "./server.js";
import { APP_NAME, APP_VERSION } from "./version.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${APP_NAME} ${APP_VERSION}\n`);
    return;
  }

  const config = await loadConfig();
  if (args.length === 1 && args[0] === "--check-config") {
    process.stdout.write(`${JSON.stringify({ ok: true, ...redactedConfig(config) }, null, 2)}\n`);
    return;
  }
  if (args.length !== 0) {
    throw new SafeError("invalid_argument", `Unknown argument: ${args[0]}`);
  }

  const handle = serveStdio(() => createServer(config), {
    onerror: (error) => {
      process.stderr.write(`MCP transport error: ${error.message}\n`);
    },
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    await handle.close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${publicErrorMessage(error)}\n`);
  process.exitCode = 1;
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configureCodexMcpOptions } from "../scripts/configure-codex.mjs";

test("configureCodexMcpOptions preserves unrelated config and is idempotent", async (context) => {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-codex-config-"));
  context.after(() => rm(temporaryDir, { force: true, recursive: true }));
  const configPath = path.join(temporaryDir, "config.toml");
  const source = `model = "test-model"

[mcp_servers.other]
command = "other-server"

[mcp_servers.sub2api_imagegen]
command = "/usr/bin/node"
args = ["/old/dist/index.js"]
tool_timeout_sec = 60
enabled = false

[mcp_servers.sub2api_imagegen.env]
SUB2API_BASE_URL = "https://sub2api.example.test/v1"
`;
  await writeFile(configPath, source, { mode: 0o600 });

  const options = {
    configPath,
    cwd: "/opt/sub2api-imagegen-mcp",
    server: "sub2api_imagegen",
    toolTimeoutSec: 660,
  };
  await configureCodexMcpOptions(options);
  const first = await readFile(configPath, "utf8");
  await configureCodexMcpOptions(options);
  const second = await readFile(configPath, "utf8");

  assert.equal(second, first);
  assert.match(first, /model = "test-model"/);
  assert.match(first, /\[mcp_servers\.other\]\ncommand = "other-server"/);
  assert.match(first, /cwd = "\/opt\/sub2api-imagegen-mcp"/);
  assert.match(first, /tool_timeout_sec = 660/);
  assert.match(first, /default_tools_approval_mode = "writes"/);
  assert.equal((first.match(/tool_timeout_sec\s*=/g) ?? []).length, 1);
  assert.equal((first.match(/\[mcp_servers\.sub2api_imagegen\]/g) ?? []).length, 1);
  if (process.platform !== "win32") {
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  }
});

test("configureCodexMcpOptions rejects duplicate target tables", async (context) => {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-codex-config-"));
  context.after(() => rm(temporaryDir, { force: true, recursive: true }));
  const configPath = path.join(temporaryDir, "config.toml");
  await writeFile(
    configPath,
    `[mcp_servers.sub2api_imagegen]
command = "one"

[mcp_servers.sub2api_imagegen]
command = "two"
`,
    { mode: 0o600 },
  );

  await assert.rejects(
    configureCodexMcpOptions({
      configPath,
      cwd: "/opt/sub2api-imagegen-mcp",
      server: "sub2api_imagegen",
      toolTimeoutSec: 660,
    }),
    /Expected exactly one/,
  );
});

test("configureCodexMcpOptions rejects an unsafe tool timeout", async (context) => {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-codex-config-"));
  context.after(() => rm(temporaryDir, { force: true, recursive: true }));
  const configPath = path.join(temporaryDir, "config.toml");
  await writeFile(
    configPath,
    `[mcp_servers.sub2api_imagegen]
command = "one"
`,
    { mode: 0o600 },
  );

  await assert.rejects(
    configureCodexMcpOptions({
      configPath,
      cwd: "/opt/sub2api-imagegen-mcp",
      server: "sub2api_imagegen",
      toolTimeoutSec: 3601,
    }),
    /between 1 and 3600/,
  );
});

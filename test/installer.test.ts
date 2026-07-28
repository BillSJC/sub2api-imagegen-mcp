import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function runInstaller(
  installerPath: string,
  environment: NodeJS.ProcessEnv,
  expectFailure = false,
) {
  try {
    const result = await execFileAsync("bash", [installerPath, "--non-interactive"], {
      env: environment,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 180_000,
    });
    if (expectFailure) {
      assert.fail("installer unexpectedly succeeded");
    }
    return `${result.stdout}${result.stderr}`;
  } catch (error) {
    if (!expectFailure || error instanceof assert.AssertionError) {
      throw error;
    }
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
}

test("installer is idempotent, keeps the key external, and restores config on failure", async (context) => {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-installer-"));
  context.after(() => rm(temporaryDir, { force: true, recursive: true }));
  const sourceDir = path.join(temporaryDir, "source");
  const excluded = new Set([".git", "dist", "generated-images", "node_modules"]);
  await cp(repositoryRoot, sourceDir, {
    filter(source) {
      const relative = path.relative(repositoryRoot, source);
      const topLevel = relative.split(path.sep)[0] ?? "";
      return relative === "" || !excluded.has(topLevel);
    },
    recursive: true,
  });

  const installerPath = path.join(sourceDir, "install.sh");
  const fakeCodexPath = path.join(sourceDir, "test", "fake-codex.mjs");
  await chmod(installerPath, 0o755);
  await chmod(fakeCodexPath, 0o755);

  const homeDir = path.join(temporaryDir, "home");
  const codexHome = path.join(homeDir, ".codex");
  await mkdir(codexHome, { mode: 0o700, recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  await writeFile(
    configPath,
    `model = "existing-model"

[mcp_servers.keep]
command = "/usr/bin/true"
`,
    { mode: 0o600 },
  );

  const testKey = "installer-test-placeholder-value";
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    HOME: homeDir,
    SUB2API_BASE_URL: "http://127.0.0.1:3099/v1",
    SUB2API_IMAGE_MODEL: "gpt-image-2",
    SUB2API_MCP_CODEX_BIN: fakeCodexPath,
    SUB2API_MCP_NO_UPDATE: "1",
    SUB2API_TIMEOUT_MS: "900000",
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
  };

  const invalidTimeoutOutput = await runInstaller(
    installerPath,
    { ...baseEnvironment, SUB2API_TIMEOUT_MS: "900001" },
    true,
  );
  assert.match(invalidTimeoutOutput, /between 1000 and 900000 milliseconds/);

  const firstOutput = await runInstaller(installerPath, {
    ...baseEnvironment,
    SUB2API_API_KEY: testKey,
  });
  assert.equal(firstOutput.includes(testKey), false);

  const keyPath = path.join(homeDir, ".config", "sub2api-imagegen-mcp", "sub2api-api.key");
  assert.equal((await readFile(keyPath, "utf8")).trim(), testKey);
  if (process.platform !== "win32") {
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  }

  const firstConfig = await readFile(configPath, "utf8");
  assert.match(firstConfig, /model = "existing-model"/);
  assert.match(firstConfig, /\[mcp_servers\.keep\]/);
  assert.match(firstConfig, /\[mcp_servers\.sub2api_imagegen\]/);
  assert.match(firstConfig, /tool_timeout_sec = 960/);
  assert.match(firstConfig, /default_tools_approval_mode = "writes"/);
  assert.match(firstConfig, /SUB2API_TIMEOUT_MS = "900000"/);
  assert.equal(firstConfig.includes(keyPath), true);
  assert.equal(firstConfig.includes(testKey), false);

  const secondOutput = await runInstaller(installerPath, baseEnvironment);
  assert.equal(secondOutput.includes(testKey), false);
  assert.equal(await readFile(configPath, "utf8"), firstConfig);

  const failureOutput = await runInstaller(
    installerPath,
    { ...baseEnvironment, FAKE_CODEX_FAIL_AFTER_ADD: "1" },
    true,
  );
  assert.match(failureOutput, /intentional post-add failure/);
  assert.equal(failureOutput.includes(testKey), false);
  assert.equal(await readFile(configPath, "utf8"), firstConfig);

  const backups = (await readdir(codexHome)).filter((name) =>
    name.startsWith("config.toml.backup."),
  );
  assert.equal(backups.length, 3);
  assert.equal((await stat(path.join(sourceDir, "dist", "index.js"))).isFile(), true);
});

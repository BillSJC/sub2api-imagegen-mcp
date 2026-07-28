import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const powershellInstaller = path.join(repositoryRoot, "install.ps1");

async function runInstaller(
  installerPath: string,
  environment: NodeJS.ProcessEnv,
  expectFailure = false,
  shell: "windows-powershell" | "powershell-7" = "windows-powershell",
) {
  const powershellPath =
    shell === "powershell-7"
      ? "pwsh.exe"
      : path.join(
          environment.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
  try {
    const result = await execFileAsync(
      powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installerPath,
        "-NonInteractive",
      ],
      {
        env: environment,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 240_000,
        windowsHide: true,
      },
    );
    if (expectFailure) {
      assert.fail("PowerShell installer unexpectedly succeeded");
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

test("PowerShell installer keeps API keys out of command-line parameters", async () => {
  const source = await readFile(powershellInstaller, "utf8");
  const parameterBlock = source.slice(0, source.indexOf("Set-StrictMode"));

  assert.doesNotMatch(parameterBlock, /\$ApiKey(?:\s|=|,)/);
  assert.match(source, /Read-Host -Prompt \$Prompt -AsSecureString/);
  assert.match(source, /Remove-Item Env:SUB2API_API_KEY/);
  assert.match(source, /Set-PrivateFileAcl/);
  assert.match(source, /config\.toml\.backup\./);
});

test(
  "native Windows installer is idempotent, protects the key, and restores config",
  { skip: process.platform !== "win32" },
  async (context) => {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-win-installer-"));
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

    const installerPath = path.join(sourceDir, "install.ps1");
    const fakeCodexPath = path.join(sourceDir, "test", "fake-codex.mjs");
    const fakeCodexWrapper = path.join(sourceDir, "test", "fake-codex.cmd");
    await writeFile(
      fakeCodexWrapper,
      '@echo off\r\n"%SUB2API_TEST_NODE%" "%SUB2API_TEST_FAKE_CODEX%" %*\r\n',
      "utf8",
    );

    const homeDir = path.join(temporaryDir, "home");
    const codexHome = path.join(homeDir, ".codex");
    const outputDir = path.join(homeDir, "Pictures", "Sub2API");
    const keyPath = path.join(homeDir, "private", "sub2api-api.key");
    await mkdir(codexHome, { recursive: true });
    const configPath = path.join(codexHome, "config.toml");
    await writeFile(
      configPath,
      `model = "existing-model"

[mcp_servers.keep]
command = "cmd.exe"
`,
      "utf8",
    );

    const testKey = "windows-installer-test-placeholder";
    const baseEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: codexHome,
      SUB2API_API_KEY_FILE: keyPath,
      SUB2API_BASE_URL: "http://127.0.0.1:3099/v1",
      SUB2API_IMAGE_MODEL: "gpt-image-2",
      SUB2API_IMAGE_OUTPUT_DIR: outputDir,
      SUB2API_MCP_CODEX_BIN: fakeCodexWrapper,
      SUB2API_MCP_NO_UPDATE: "1",
      SUB2API_TEST_FAKE_CODEX: fakeCodexPath,
      SUB2API_TEST_NODE: process.execPath,
      SUB2API_TIMEOUT_MS: "900000",
    };

    const invalidTimeoutOutput = await runInstaller(
      installerPath,
      { ...baseEnvironment, SUB2API_TIMEOUT_MS: "900001" },
      true,
    );
    assert.match(invalidTimeoutOutput, /between 1000 and 900000 milliseconds/);

    const firstOutput = await runInstaller(
      installerPath,
      {
        ...baseEnvironment,
        SUB2API_API_KEY: testKey,
      },
      false,
      "powershell-7",
    );
    assert.equal(firstOutput.includes(testKey), false);
    assert.equal((await readFile(keyPath, "utf8")).trim(), testKey);

    const keyAclOutput = await execFileAsync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Acl -LiteralPath '${keyPath.replaceAll("'", "''")}').AreAccessRulesProtected`,
      ],
      { windowsHide: true },
    );
    assert.equal(keyAclOutput.stdout.trim().toLowerCase(), "true");

    const firstConfig = await readFile(configPath, "utf8");
    assert.match(firstConfig, /model = "existing-model"/);
    assert.match(firstConfig, /\[mcp_servers\.keep\]/);
    assert.match(firstConfig, /\[mcp_servers\.sub2api_imagegen\]/);
    assert.match(firstConfig, /tool_timeout_sec = 960/);
    assert.match(firstConfig, /default_tools_approval_mode = "writes"/);
    assert.match(firstConfig, /SUB2API_TIMEOUT_MS = "900000"/);
    assert.equal(firstConfig.includes(keyPath.replaceAll("\\", "\\\\")), true);
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
  },
);

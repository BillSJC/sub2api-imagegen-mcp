#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bashInstaller = path.join(repositoryRoot, "install.sh");
const powershellInstaller = path.join(repositoryRoot, "install.ps1");

function run(executable, args, label, optional = false) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (optional && result.error?.code === "ENOENT") {
    return false;
  }
  if (result.error !== undefined) {
    throw new Error(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`${label} failed${output === "" ? "." : `:\n${output}`}`);
  }
  return true;
}

if (process.platform !== "win32") {
  run("bash", ["-n", bashInstaller], "Bash installer syntax check");
}

const source = readFileSync(powershellInstaller, "utf8");
const parameterBlock = source.slice(0, source.indexOf("Set-StrictMode"));
if (/\$ApiKey(?:\s|=|,)/.test(parameterBlock)) {
  throw new Error("PowerShell installer must not accept an API key command-line parameter.");
}
for (const required of [
  "Read-Host -Prompt $Prompt -AsSecureString",
  "Remove-Item Env:SUB2API_API_KEY",
  "Set-PrivateFileAcl",
  "config.toml.backup.",
]) {
  if (!source.includes(required)) {
    throw new Error(`PowerShell installer is missing required security behavior: ${required}`);
  }
}

const escapedInstaller = powershellInstaller.replaceAll("'", "''");
const parseCommand = [
  "$tokens = $null",
  "$errors = $null",
  `[System.Management.Automation.Language.Parser]::ParseFile('${escapedInstaller}', [ref]$tokens, [ref]$errors) | Out-Null`,
  "if ($errors.Count -gt 0) {",
  "  $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }",
  "  exit 1",
  "}",
].join("; ");

let parserRan;
if (process.platform === "win32") {
  const windowsPowerShell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  parserRan = run(
    windowsPowerShell,
    ["-NoProfile", "-NonInteractive", "-Command", parseCommand],
    "PowerShell installer syntax check",
  );
} else {
  parserRan = run(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", parseCommand],
    "PowerShell installer syntax check",
    true,
  );
}

process.stdout.write(
  `Installer checks passed${parserRan ? " (PowerShell parser included)" : ""}.\n`,
);

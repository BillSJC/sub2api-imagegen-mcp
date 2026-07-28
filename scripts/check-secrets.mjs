#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const MAX_SCANNED_OBJECT_BYTES = 50 * 1024 * 1024;
const GIT_OUTPUT_BUFFER_BYTES = 100 * 1024 * 1024;

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_BUFFER_BYTES,
    ...options,
  });
}

const candidateOutput = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8", maxBuffer: GIT_OUTPUT_BUFFER_BYTES },
);
const candidateFiles = candidateOutput.split("\0").filter(Boolean);

const patterns = [
  {
    label: "private key material",
    pattern: /-----BEGIN (?:OPENSSH |RSA |EC |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    label: "GitHub access token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  },
  {
    label: "OpenAI-style secret",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    label: "AWS access key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    label: "literal Sub2API credential assignment",
    pattern:
      /SUB2API_API_KEY\s*[:=]\s*["']?(?!\s*(?:$|<|\$\{|placeholder|example|test-))[A-Za-z0-9._-]{12,}/im,
  },
];

function hasSensitiveFileName(file) {
  const name = file.split("/").at(-1) ?? file;
  return (
    name === ".env" ||
    (name.startsWith(".env.") && name !== ".env.example") ||
    name === "auth.json" ||
    name === "credentials" ||
    name.startsWith("credentials.") ||
    /\.(?:key|pem|p12|pfx)$/i.test(name)
  );
}

function scanText(source, text, findings) {
  for (const { label, pattern } of patterns) {
    if (pattern.test(text)) {
      findings.add(`${source}: ${label}`);
    }
  }
}

const findings = new Set();
for (const file of candidateFiles) {
  if (hasSensitiveFileName(file)) {
    findings.add(`${file}: sensitive credential filename`);
  }
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    continue;
  }
  if (bytes.includes(0)) {
    continue;
  }
  scanText(file, bytes.toString("utf8"), findings);
}

const objectLines = runGit(["rev-list", "--objects", "--all"]).split("\n").filter(Boolean);
const historicalObjects = new Map();
for (const line of objectLines) {
  const separator = line.indexOf(" ");
  const objectId = separator < 0 ? line : line.slice(0, separator);
  const objectPath = separator < 0 ? "" : line.slice(separator + 1);
  if (objectPath !== "" && hasSensitiveFileName(objectPath)) {
    findings.add(`history:${objectPath}@${objectId.slice(0, 12)}: sensitive credential filename`);
  }
  if (!historicalObjects.has(objectId)) {
    historicalObjects.set(objectId, objectPath);
  }
}

let scannedHistoricalObjects = 0;
for (const [objectId, objectPath] of historicalObjects) {
  const type = runGit(["cat-file", "-t", objectId]).trim();
  if (!["blob", "commit", "tag"].includes(type)) {
    continue;
  }
  const size = Number(runGit(["cat-file", "-s", objectId]).trim());
  const source = `history:${objectPath || type}@${objectId.slice(0, 12)}`;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SCANNED_OBJECT_BYTES) {
    findings.add(`${source}: object exceeds the safe scan limit`);
    continue;
  }
  const bytes = execFileSync("git", ["cat-file", type, objectId], {
    encoding: null,
    maxBuffer: MAX_SCANNED_OBJECT_BYTES + 1024,
  });
  scannedHistoricalObjects += 1;
  if (!bytes.includes(0)) {
    scanText(source, bytes.toString("utf8"), findings);
  }
}

if (findings.size > 0) {
  process.stderr.write(
    `Potential credentials found; refusing to continue:\n${[...findings]
      .map((finding) => `- ${finding}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  const shallow = runGit(["rev-parse", "--is-shallow-repository"]).trim() === "true";
  process.stdout.write(
    `Secret scan passed (${candidateFiles.length} current files, ` +
      `${scannedHistoricalObjects} reachable historical objects` +
      `${shallow ? ", shallow history" : ", complete local history"}).\n`,
  );
}

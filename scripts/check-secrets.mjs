#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const candidateOutput = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
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

const findings = [];
for (const file of candidateFiles) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    continue;
  }
  if (bytes.includes(0)) {
    continue;
  }
  const text = bytes.toString("utf8");
  for (const { label, pattern } of patterns) {
    if (pattern.test(text)) {
      findings.push(`${file}: ${label}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `Potential credentials found; refusing to continue:\n${findings
      .map((finding) => `- ${finding}`)
      .join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`Secret scan passed (${candidateFiles.length} candidate files).\n`);
}

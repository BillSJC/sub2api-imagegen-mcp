import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scannerPath = path.join(repositoryRoot, "scripts", "check-secrets.mjs");

async function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd });
}

test("secret scanner detects credentials that were deleted from the worktree", async (context) => {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-secret-history-"));
  context.after(() => rm(temporaryDir, { force: true, recursive: true }));
  await git(temporaryDir, "init", "--quiet");
  await git(temporaryDir, "config", "user.name", "scanner-test");
  await git(temporaryDir, "config", "user.email", "scanner@example.test");
  await git(temporaryDir, "config", "commit.gpgsign", "false");

  const trackedPath = path.join(temporaryDir, "archived.txt");
  const marker = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");
  await writeFile(trackedPath, `${marker}\nplaceholder\n`);
  await git(temporaryDir, "add", "archived.txt");
  await git(temporaryDir, "commit", "--quiet", "-m", "add historical fixture");
  await unlink(trackedPath);
  await git(temporaryDir, "add", "--update");
  await git(temporaryDir, "commit", "--quiet", "-m", "remove historical fixture");

  try {
    await execFileAsync(process.execPath, [scannerPath], {
      cwd: temporaryDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.fail("scanner unexpectedly accepted historical credential material");
  } catch (error) {
    if (error instanceof assert.AssertionError) {
      throw error;
    }
    const failure = error as { stderr?: string; stdout?: string };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    assert.match(output, /history:archived\.txt@/);
    assert.match(output, /private key material/);
    assert.equal(output.includes(marker), false);
  }
});

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, redactedConfig } from "../src/config.js";
import { SafeError } from "../src/errors.js";

test("loadConfig accepts one inline key and normalizes an origin to /v1/", async () => {
  const outputDir = path.join(os.tmpdir(), "sub2api-output");
  const config = await loadConfig({
    SUB2API_API_KEY: "placeholder-value",
    SUB2API_BASE_URL: "https://sub2api.example.test",
    SUB2API_IMAGE_OUTPUT_DIR: outputDir,
  });

  assert.equal(config.baseUrl.toString(), "https://sub2api.example.test/v1/");
  assert.equal(config.credentialSource, "environment");
  assert.equal(config.model, "gpt-image-2");
  assert.equal(redactedConfig(config).credential_source, "environment");
  assert.equal(JSON.stringify(redactedConfig(config)).includes(config.apiKey), false);
});

test("loadConfig rejects missing or ambiguous credentials", async () => {
  const common = {
    SUB2API_BASE_URL: "https://sub2api.example.test",
    SUB2API_IMAGE_OUTPUT_DIR: path.join(os.tmpdir(), "sub2api-output"),
  };

  await assert.rejects(loadConfig(common), SafeError);
  await assert.rejects(
    loadConfig({
      ...common,
      SUB2API_API_KEY: "placeholder",
      SUB2API_API_KEY_FILE: "/tmp/also-set",
    }),
    /Set exactly one/,
  );
});

test("loadConfig rejects control characters in an inline key", async () => {
  await assert.rejects(
    loadConfig({
      SUB2API_API_KEY: "placeholder\ninjected",
      SUB2API_BASE_URL: "https://sub2api.example.test",
      SUB2API_IMAGE_OUTPUT_DIR: path.join(os.tmpdir(), "sub2api-output"),
    }),
    /control characters/,
  );
});

test("loadConfig reads a private external key file", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX permission test");
    return;
  }
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-config-"));
  context.after(() => rm(temporaryDir, { force: true, recursive: true }));
  const keyPath = path.join(temporaryDir, "sub2api.key");
  await writeFile(keyPath, "placeholder-from-file\n", { mode: 0o600 });

  const config = await loadConfig({
    SUB2API_API_KEY_FILE: keyPath,
    SUB2API_BASE_URL: "https://sub2api.example.test/v1",
    SUB2API_IMAGE_OUTPUT_DIR: path.join(temporaryDir, "output"),
  });
  assert.equal(config.apiKey, "placeholder-from-file");
  assert.equal(config.credentialSource, "file");

  await chmod(keyPath, 0o644);
  await assert.rejects(
    loadConfig({
      SUB2API_API_KEY_FILE: keyPath,
      SUB2API_BASE_URL: "https://sub2api.example.test/v1",
      SUB2API_IMAGE_OUTPUT_DIR: path.join(temporaryDir, "output"),
    }),
    /chmod 600/,
  );
});

test("loadConfig permits HTTP only for loopback testing", async () => {
  const baseEnv = {
    SUB2API_API_KEY: "placeholder",
    SUB2API_IMAGE_OUTPUT_DIR: path.join(os.tmpdir(), "sub2api-output"),
  };
  const loopback = await loadConfig({
    ...baseEnv,
    SUB2API_BASE_URL: "http://127.0.0.1:8080",
  });
  assert.equal(loopback.baseUrl.toString(), "http://127.0.0.1:8080/v1/");

  await assert.rejects(
    loadConfig({
      ...baseEnv,
      SUB2API_BASE_URL: "http://sub2api.example.test",
    }),
    /must use HTTPS/,
  );
});

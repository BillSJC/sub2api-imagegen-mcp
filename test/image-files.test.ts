import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectImage, loadReferenceImage, saveImage } from "../src/image-files.js";
import { ONE_PIXEL_PNG_BASE64 } from "./fixtures.js";

test("reference loading validates magic bytes and creates a data URL", async (context) => {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-image-"));
  context.after(() => rm(temporaryDir, { force: true, recursive: true }));
  const imagePath = path.join(temporaryDir, "reference.bin");
  const bytes = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");
  await writeFile(imagePath, bytes);

  const image = await loadReferenceImage(imagePath, 1024);
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.extension, "png");
  assert.equal(image.dataUrl, `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`);
});

test("reference loading rejects relative paths and symbolic links", async (context) => {
  await assert.rejects(loadReferenceImage("relative.png", 1024), /must be absolute/);

  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-image-"));
  context.after(() => rm(temporaryDir, { force: true, recursive: true }));
  const target = path.join(temporaryDir, "target.png");
  const link = path.join(temporaryDir, "link.png");
  await writeFile(target, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
  await symlink(target, link);
  await assert.rejects(loadReferenceImage(link, 1024), /symbolic links/);
});

test("saveImage writes private collision-safe output names", async (context) => {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-image-"));
  context.after(() => rm(temporaryDir, { force: true, recursive: true }));
  const bytes = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");
  const image = inspectImage(bytes);

  const first = await saveImage(temporaryDir, image, "canary.png");
  const second = await saveImage(temporaryDir, image, "canary.png");
  assert.equal(path.basename(first), "canary.png");
  assert.equal(path.basename(second), "canary-1.png");
  assert.deepEqual(await readFile(first), bytes);
  if (process.platform !== "win32") {
    assert.equal((await stat(first)).mode & 0o777, 0o600);
  }
  await assert.rejects(saveImage(temporaryDir, image, "../escape"), /safe basename/);
});

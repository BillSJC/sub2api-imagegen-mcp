import assert from "node:assert/strict";
import test from "node:test";
import { imageSizeSchema } from "../src/image-options.js";

test("custom sizes enforce image pixel, edge, alignment and aspect limits", () => {
  for (const size of ["auto", "1024x1024", "1536x864", "3840x2160", "2160x3840", "1024x640"]) {
    assert.equal(imageSizeSchema.safeParse(size).success, true, size);
  }
  for (const size of [
    "0x1024",
    "512x512",
    "1537x864",
    "4096x2048",
    "3840x3840",
    "3072x768",
    "1024X1024",
    "1e3x1024",
  ]) {
    assert.equal(imageSizeSchema.safeParse(size).success, false, size);
  }
});

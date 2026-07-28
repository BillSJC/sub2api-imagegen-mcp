#!/usr/bin/env node

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const outputDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-stdio-"));
let requestCount = 0;
const mockServer = createServer((request, response) => {
  requestCount += 1;
  assert.equal(request.method, "POST");
  assert.equal(request.headers.authorization, "Bearer test-placeholder-key");

  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "gpt-image-2");
    if (requestCount === 1) {
      assert.equal(request.url, "/v1/images/generations");
      assert.equal(body.prompt, "stdio smoke canary");
    } else {
      assert.equal(requestCount, 2);
      assert.equal(request.url, "/v1/images/edits");
      assert.equal(body.prompt, "stdio edit canary");
      assert.equal(body.images.length, 1);
      assert.match(body.images[0].image_url, /^data:image\/png;base64,/);
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
  });
});

try {
  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(0, "127.0.0.1", resolve);
  });
  const address = mockServer.address();
  assert(address && typeof address === "object");

  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined),
  );
  const transport = new StdioClientTransport({
    args: [path.resolve("dist/index.js")],
    command: process.execPath,
    env: {
      ...inheritedEnvironment,
      SUB2API_API_KEY: "test-placeholder-key",
      SUB2API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      SUB2API_IMAGE_OUTPUT_DIR: outputDir,
    },
  });
  const client = new Client({ name: "stdio-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["imagegen"],
    );
    const result = await client.callTool({
      arguments: {
        output_name: "stdio-canary",
        prompt: "stdio smoke canary",
      },
      name: "imagegen",
    });
    assert.equal(result.isError, undefined);
    assert.equal(
      result.content.some((item) => item.type === "image"),
      true,
    );
    assert.equal(result.structuredContent?.path, path.join(outputDir, "stdio-canary.png"));
    const editResult = await client.callTool({
      arguments: {
        output_name: "stdio-edit-canary",
        prompt: "stdio edit canary",
        referenced_image_paths: [path.join(outputDir, "stdio-canary.png")],
      },
      name: "imagegen",
    });
    assert.equal(editResult.isError, undefined);
    assert.equal(editResult.structuredContent?.operation, "edit");
    assert.equal(editResult.structuredContent?.path, path.join(outputDir, "stdio-edit-canary.png"));
    assert.equal(requestCount, 2);
  } finally {
    await client.close();
  }
  process.stdout.write("STDIO MCP smoke test passed.\n");
} finally {
  await new Promise((resolve) => mockServer.close(resolve));
  await rm(outputDir, { force: true, recursive: true });
}

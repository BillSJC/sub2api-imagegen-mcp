import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createServer } from "../src/server.js";
import { Sub2ApiImageClient } from "../src/sub2api-client.js";
import { ONE_PIXEL_PNG_BASE64, testConfig } from "./fixtures.js";

test("MCP exposes imagegen and returns an image plus a local path", async (context) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-mcp-"));
  context.after(() => rm(outputDir, { force: true, recursive: true }));
  const config = testConfig(outputDir);
  const imageClient = new Sub2ApiImageClient(
    config,
    (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }] }), {
        status: 200,
      })) as typeof fetch,
  );
  const server = createServer(config, imageClient);
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["imagegen"],
  );
  assert.match(listed.tools[0]?.description ?? "", /do not retry a failure/i);
  const result = await client.callTool({
    arguments: {
      output_name: "mcp-canary",
      prompt: "a tiny canary square",
    },
    name: "imagegen",
  });
  assert.equal(result.isError, undefined);
  assert.equal(
    result.content.some((item) => item.type === "image"),
    true,
  );
  assert.equal(typeof result.structuredContent, "object");
  const output = result.structuredContent as Record<string, unknown>;
  assert.equal(output.operation, "generation");
  assert.equal(output.mime_type, "image/png");
  assert.equal(output.path, path.join(outputDir, "mcp-canary.png"));
});

test("MCP reports reference validation failures without calling Sub2API", async (context) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "sub2api-mcp-"));
  context.after(() => rm(outputDir, { force: true, recursive: true }));
  const config = testConfig(outputDir);
  let called = false;
  const imageClient = new Sub2ApiImageClient(config, (async () => {
    called = true;
    throw new Error("must not be called");
  }) as typeof fetch);
  const server = createServer(config, imageClient);
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    arguments: {
      prompt: "edit this",
      referenced_image_paths: ["relative.png"],
    },
    name: "imagegen",
  });
  assert.equal(result.isError, true);
  assert.equal(called, false);
  assert.match(
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
    /must be absolute/,
  );
});

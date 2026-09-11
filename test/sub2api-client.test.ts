import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Sub2ApiImageClient } from "../src/sub2api-client.js";
import { ONE_PIXEL_PNG_BASE64, testConfig } from "./fixtures.js";

test("client sends an OpenAI-compatible generation request", async () => {
  let capturedUrl = "";
  let capturedAuthorization = "";
  let capturedBody: unknown;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = input.toString();
    capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }] }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }) as typeof fetch;
  const config = testConfig(path.join(os.tmpdir(), "sub2api-output"));
  const client = new Sub2ApiImageClient(config, fakeFetch);

  const result = await client.createImage({
    background: "auto",
    imageDataUrls: [],
    prompt: "a tiny test square",
    quality: "auto",
    size: "1024x1024",
  });

  assert.equal(capturedUrl, "https://sub2api.example.test/v1/images/generations");
  assert.equal(capturedAuthorization, `Bearer ${config.apiKey}`);
  assert.deepEqual(capturedBody, {
    background: "auto",
    model: "gpt-image-2",
    n: 1,
    prompt: "a tiny test square",
    quality: "auto",
    response_format: "b64_json",
    size: "1024x1024",
  });
  assert.equal(result.mimeType, "image/png");
});

test("client pins PNG output for transparent edits", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = input.toString();
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }] }), {
      status: 200,
    });
  }) as typeof fetch;
  const client = new Sub2ApiImageClient(
    testConfig(path.join(os.tmpdir(), "sub2api-output")),
    fakeFetch,
  );

  await client.createImage({
    background: "transparent",
    imageDataUrls: ["data:image/png;base64,AAAA"],
    prompt: "edit it",
    quality: "high",
    size: "auto",
  });

  assert.equal(capturedUrl, "https://sub2api.example.test/v1/images/edits");
  assert.equal(capturedBody.background, "transparent");
  assert.deepEqual(capturedBody.images, [{ image_url: "data:image/png;base64,AAAA" }]);
  assert.equal(capturedBody.output_format, "png");
  assert.equal(capturedBody.response_format, "b64_json");
});

for (const model of [
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare-2026-09-08",
  "gpt-image-2.5-sunburst-2026-09-08",
]) {
  for (const quality of ["xhigh", "max"] as const) {
    test(`${model} supports ${quality} generation and transparent editing`, async () => {
      for (const edit of [false, true]) {
        const client = new Sub2ApiImageClient(testConfig(os.tmpdir(), { model }), (async (
          url,
          init,
        ) => {
          assert.equal(String(url).endsWith(edit ? "images/edits" : "images/generations"), true);
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          assert.equal(body.model, model);
          assert.equal(body.quality, quality);
          assert.equal(body.size, "1536x864");
          assert.equal(body.output_format, "png");
          assert.equal("response_format" in body, false);
          assert.equal("images" in body, edit);
          return new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }] }));
        }) as typeof fetch);
        const result = await client.createImage({
          background: "transparent",
          imageDataUrls: edit ? [`data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`] : [],
          prompt: "test",
          quality,
          size: "1536x864",
        });
        assert.equal(result.mimeType, "image/png");
      }
    });
  }
}

test("invalid sizes and unsupported legacy quality fail before any network request", async () => {
  const client = new Sub2ApiImageClient(testConfig(os.tmpdir()), (async () => {
    assert.fail("must not contact upstream");
  }) as typeof fetch);
  await assert.rejects(
    client.createImage({
      background: "auto",
      imageDataUrls: [],
      prompt: "test",
      quality: "max",
      size: "auto",
    }),
    /require GPT Image 2.5/,
  );
  await assert.rejects(
    client.createImage({
      background: "auto",
      imageDataUrls: [],
      prompt: "test",
      quality: "auto",
      size: "512x512",
    }),
    /Invalid image size/,
  );
});

test("client redacts the API key from upstream errors", async () => {
  const config = testConfig(path.join(os.tmpdir(), "sub2api-output"), {
    apiKey: "secret-that-must-not-escape",
  });
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          message: `bad Bearer ${config.apiKey} and ${config.apiKey}`,
        },
      }),
      { status: 401 },
    )) as typeof fetch;
  const client = new Sub2ApiImageClient(config, fakeFetch);

  await assert.rejects(
    client.createImage({
      background: "auto",
      imageDataUrls: [],
      prompt: "test",
      quality: "auto",
      size: "auto",
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message.includes(config.apiKey), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test("client rejects URL-only and malformed image responses", async () => {
  const client = new Sub2ApiImageClient(
    testConfig(path.join(os.tmpdir(), "sub2api-output")),
    (async () =>
      new Response(JSON.stringify({ data: [{ url: "https://example.test/x" }] }), {
        status: 200,
      })) as typeof fetch,
  );

  await assert.rejects(
    client.createImage({
      background: "auto",
      imageDataUrls: [],
      prompt: "test",
      quality: "auto",
      size: "auto",
    }),
    /b64_json/,
  );
});

test("client timeout covers a stalled response body", async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"data":[');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const client = new Sub2ApiImageClient(
    testConfig(path.join(os.tmpdir(), "sub2api-output"), {
      baseUrl: new URL(`http://127.0.0.1:${address.port}/v1/`),
      timeoutMs: 100,
    }),
  );

  await assert.rejects(
    client.createImage({
      background: "auto",
      imageDataUrls: [],
      prompt: "test",
      quality: "auto",
      size: "auto",
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /did not respond within 100 ms/);
      assert.match(error.message, /may still be running or billable/);
      return true;
    },
  );
});

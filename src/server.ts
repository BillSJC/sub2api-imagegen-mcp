import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppConfig } from "./config.js";
import { publicErrorMessage } from "./errors.js";
import { loadReferenceImage, saveImage } from "./image-files.js";
import { Sub2ApiImageClient } from "./sub2api-client.js";
import { APP_NAME, APP_VERSION } from "./version.js";

const imageInputSchema = z
  .object({
    background: z
      .enum(["auto", "opaque", "transparent"])
      .optional()
      .default("auto")
      .describe("Background mode. Use transparent only when explicitly needed."),
    output_name: z
      .string()
      .max(128)
      .optional()
      .describe("Optional safe basename for the locally saved image."),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(32_000)
      .describe("A complete image generation or editing instruction."),
    quality: z.enum(["auto", "low", "medium", "high"]).optional().default("auto"),
    referenced_image_paths: z
      .array(z.string().min(1).max(4096))
      .max(5)
      .optional()
      .describe(
        "Up to five absolute local PNG, JPEG, or WebP paths. Their contents are sent to Sub2API.",
      ),
    size: z.enum(["auto", "1024x1024", "1536x1024", "1024x1536"]).optional().default("auto"),
  })
  .strict();

const imageOutputSchema = z.object({
  bytes: z.number().int().positive(),
  mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  model: z.string(),
  operation: z.enum(["generation", "edit"]),
  path: z.string(),
});

export function createServer(
  config: AppConfig,
  client: Sub2ApiImageClient = new Sub2ApiImageClient(config),
): McpServer {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Use imagegen only when the user explicitly requests image generation or editing. " +
        "The tool calls an external Sub2API service that may incur cost. " +
        "Never ask for or echo an API key. Reference image paths must be absolute local paths. " +
        "Never retry an error or timeout unless the user explicitly confirms a new billable attempt.",
    },
  );

  server.registerTool(
    "imagegen",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Generate a new image through Sub2API, or edit up to five local reference images. " +
        "Returns an MCP image and saves a private local copy. Each call may incur cost; " +
        "do not retry a failure without explicit user approval.",
      inputSchema: imageInputSchema,
      outputSchema: imageOutputSchema,
      title: "Sub2API Image Generation",
    },
    async ({
      background,
      output_name: outputName,
      prompt,
      quality,
      referenced_image_paths: referencePaths = [],
      size,
    }) => {
      try {
        const references = await Promise.all(
          referencePaths.map((referencePath) =>
            loadReferenceImage(referencePath, config.maxInputImageBytes),
          ),
        );
        const generated = await client.createImage({
          background,
          imageDataUrls: references.map((reference) => reference.dataUrl),
          prompt,
          quality,
          size,
        });
        const destination = await saveImage(config.outputDir, generated, outputName);
        const operation = references.length === 0 ? "generation" : "edit";
        const output = {
          bytes: generated.bytes.length,
          mime_type: generated.mimeType,
          model: config.model,
          operation,
          path: destination,
        } as const;
        return {
          content: [
            {
              text: `Image ${operation} completed and saved to ${destination}`,
              type: "text" as const,
            },
            {
              data: generated.base64,
              mimeType: generated.mimeType,
              type: "image" as const,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [
            {
              text: publicErrorMessage(error),
              type: "text" as const,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

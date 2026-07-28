import { SafeError } from "./errors.js";
import { inspectImage, type SupportedImage } from "./image-files.js";
import type { AppConfig } from "./config.js";
import { APP_VERSION } from "./version.js";

export type ImageQuality = "auto" | "low" | "medium" | "high";
export type ImageSize = "auto" | "1024x1024" | "1536x1024" | "1024x1536";
export type ImageBackground = "auto" | "opaque" | "transparent";

export interface ImageRequest {
  readonly background: ImageBackground;
  readonly imageDataUrls: readonly string[];
  readonly prompt: string;
  readonly quality: ImageQuality;
  readonly size: ImageSize;
}

export interface ImageResult extends SupportedImage {
  readonly base64: string;
}

type FetchImplementation = typeof fetch;

function redactText(value: string, apiKey: string): string {
  let redacted = value;
  if (apiKey !== "") {
    redacted = redacted.split(apiKey).join("[REDACTED]");
  }
  redacted = redacted
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  return redacted.slice(0, 1500);
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new SafeError(
          "response_too_large",
          `Sub2API response exceeded ${maximumBytes} bytes.`,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractErrorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      "message" in parsed.error &&
      typeof parsed.error.message === "string"
    ) {
      return parsed.error.message;
    }
  } catch {
    // A plain-text upstream error is handled below.
  }
  return body.trim() === "" ? "Sub2API returned an empty error body." : body;
}

function decodeImageResponse(body: string, maximumBytes: number): ImageResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new SafeError("invalid_upstream_response", "Sub2API returned invalid JSON.", {
      cause: error,
    });
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("data" in parsed) ||
    !Array.isArray(parsed.data) ||
    parsed.data.length === 0
  ) {
    throw new SafeError(
      "invalid_upstream_response",
      "Sub2API response does not contain data[0].b64_json.",
    );
  }
  const first = parsed.data[0] as unknown;
  if (
    typeof first !== "object" ||
    first === null ||
    !("b64_json" in first) ||
    typeof first.b64_json !== "string"
  ) {
    throw new SafeError(
      "invalid_upstream_response",
      "Sub2API response does not contain data[0].b64_json.",
    );
  }

  const normalized = first.b64_json.replace(/\s/g, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new SafeError("invalid_upstream_response", "Sub2API returned invalid base64 image data.");
  }

  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0 || bytes.length > maximumBytes) {
    throw new SafeError(
      "invalid_upstream_response",
      `Decoded image must be between 1 and ${maximumBytes} bytes.`,
    );
  }
  if (bytes.toString("base64") !== normalized) {
    throw new SafeError(
      "invalid_upstream_response",
      "Sub2API returned non-canonical base64 image data.",
    );
  }
  let inspected: SupportedImage;
  try {
    inspected = inspectImage(bytes);
  } catch (error) {
    throw new SafeError(
      "invalid_upstream_response",
      "Sub2API returned an unsupported or invalid image.",
      { cause: error },
    );
  }
  return { ...inspected, base64: normalized };
}

export class Sub2ApiImageClient {
  readonly #config: AppConfig;
  readonly #fetch: FetchImplementation;

  constructor(config: AppConfig, fetchImplementation: FetchImplementation = fetch) {
    this.#config = config;
    this.#fetch = fetchImplementation;
  }

  async createImage(request: ImageRequest): Promise<ImageResult> {
    const isEdit = request.imageDataUrls.length > 0;
    const body: Record<string, unknown> = {
      background: request.background,
      model: this.#config.model,
      n: 1,
      prompt: request.prompt,
      quality: request.quality,
      response_format: "b64_json",
      size: request.size,
    };
    if (isEdit) {
      body.images = request.imageDataUrls.map((imageUrl) => ({
        image_url: imageUrl,
      }));
    }

    const endpoint = isEdit ? "images/edits" : "images/generations";
    const url = new URL(endpoint, this.#config.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#config.timeoutMs);

    try {
      const response = await this.#fetch(url, {
        body: JSON.stringify(body),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#config.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": `sub2api-imagegen-mcp/${APP_VERSION}`,
        },
        method: "POST",
        redirect: "error",
        signal: controller.signal,
      });

      const responseBody = await readBoundedBody(response, this.#config.maxResponseBytes);
      if (!response.ok) {
        const safeMessage = redactText(extractErrorMessage(responseBody), this.#config.apiKey);
        throw new SafeError(
          "upstream_error",
          `Sub2API returned HTTP ${response.status}: ${safeMessage}`,
        );
      }
      return decodeImageResponse(responseBody, this.#config.maxResponseBytes);
    } catch (error) {
      if (error instanceof SafeError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new SafeError(
          "upstream_timeout",
          `Sub2API did not respond within ${this.#config.timeoutMs} ms.`,
          { cause: error },
        );
      }
      throw new SafeError("upstream_unreachable", "The Sub2API endpoint could not be reached.", {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

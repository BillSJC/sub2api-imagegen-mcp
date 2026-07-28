import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { SafeError } from "./errors.js";

const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

export type CredentialSource = "environment" | "file";

export interface AppConfig {
  readonly apiKey: string;
  readonly baseUrl: URL;
  readonly credentialSource: CredentialSource;
  readonly maxInputImageBytes: number;
  readonly maxResponseBytes: number;
  readonly model: string;
  readonly outputDir: string;
  readonly timeoutMs: number;
}

function requiredText(value: string | undefined, name: string, maxLength: number): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) {
    throw new SafeError("invalid_config", `${name} must be set.`);
  }
  if (normalized.length > maxLength) {
    throw new SafeError("invalid_config", `${name} exceeds the maximum supported length.`);
  }
  return normalized;
}

function validateApiKey(value: string, name: string): string {
  const apiKey = requiredText(value, name, 4096);
  if (
    Array.from(apiKey).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw new SafeError("invalid_config", `${name} contains control characters.`);
  }
  return apiKey;
}

function positiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  if (!/^[0-9]+$/.test(value.trim())) {
    throw new SafeError("invalid_config", `${name} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new SafeError("invalid_config", `${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function normalizeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new SafeError("invalid_config", "SUB2API_BASE_URL must be an absolute URL.", {
      cause: error,
    });
  }

  if (url.username !== "" || url.password !== "") {
    throw new SafeError("invalid_config", "SUB2API_BASE_URL must not contain credentials.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new SafeError(
      "invalid_config",
      "SUB2API_BASE_URL must not contain a query string or fragment.",
    );
  }

  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new SafeError(
      "invalid_config",
      "SUB2API_BASE_URL must use HTTPS (HTTP is allowed only for loopback testing).",
    );
  }

  const trimmedPath = url.pathname.replace(/\/+$/, "");
  if (trimmedPath === "" || trimmedPath === "/") {
    url.pathname = "/v1/";
  } else if (trimmedPath === "/v1") {
    url.pathname = "/v1/";
  } else {
    url.pathname = `${trimmedPath}/`;
  }
  return url;
}

async function readApiKeyFile(filePath: string): Promise<string> {
  if (!path.isAbsolute(filePath)) {
    throw new SafeError("invalid_config", "SUB2API_API_KEY_FILE must be an absolute path.");
  }

  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    throw new SafeError("invalid_config", "SUB2API_API_KEY_FILE cannot be read.", { cause: error });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new SafeError(
      "invalid_config",
      "SUB2API_API_KEY_FILE must be a regular file, not a symbolic link.",
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new SafeError(
      "invalid_config",
      "SUB2API_API_KEY_FILE permissions are too broad; run chmod 600 on it.",
    );
  }

  let contents: string;
  try {
    contents = await readFile(filePath, { encoding: "utf8" });
  } catch (error) {
    throw new SafeError("invalid_config", "SUB2API_API_KEY_FILE cannot be read.", { cause: error });
  }
  return validateApiKey(contents, "SUB2API_API_KEY_FILE contents");
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  const inlineKey = env.SUB2API_API_KEY?.trim() ?? "";
  const keyFile = env.SUB2API_API_KEY_FILE?.trim() ?? "";
  if ((inlineKey === "") === (keyFile === "")) {
    throw new SafeError(
      "invalid_config",
      "Set exactly one of SUB2API_API_KEY or SUB2API_API_KEY_FILE.",
    );
  }

  const outputDir = requiredText(env.SUB2API_IMAGE_OUTPUT_DIR, "SUB2API_IMAGE_OUTPUT_DIR", 4096);
  if (!path.isAbsolute(outputDir)) {
    throw new SafeError("invalid_config", "SUB2API_IMAGE_OUTPUT_DIR must be an absolute path.");
  }

  const credentialSource: CredentialSource = inlineKey === "" ? "file" : "environment";
  const apiKey =
    credentialSource === "file"
      ? await readApiKeyFile(keyFile)
      : validateApiKey(inlineKey, "SUB2API_API_KEY");

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(requiredText(env.SUB2API_BASE_URL, "SUB2API_BASE_URL", 2048)),
    credentialSource,
    maxInputImageBytes: positiveInteger(
      env.SUB2API_MAX_INPUT_IMAGE_BYTES,
      "SUB2API_MAX_INPUT_IMAGE_BYTES",
      DEFAULT_MAX_INPUT_IMAGE_BYTES,
      1024,
      100 * 1024 * 1024,
    ),
    maxResponseBytes: positiveInteger(
      env.SUB2API_MAX_RESPONSE_BYTES,
      "SUB2API_MAX_RESPONSE_BYTES",
      DEFAULT_MAX_RESPONSE_BYTES,
      1024,
      200 * 1024 * 1024,
    ),
    model: requiredText(env.SUB2API_IMAGE_MODEL ?? DEFAULT_MODEL, "SUB2API_IMAGE_MODEL", 128),
    outputDir: path.resolve(outputDir),
    timeoutMs: positiveInteger(
      env.SUB2API_TIMEOUT_MS,
      "SUB2API_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
      1000,
      900_000,
    ),
  };
}

export function redactedConfig(config: AppConfig): Record<string, unknown> {
  return {
    base_url: config.baseUrl.toString(),
    credential_source: config.credentialSource,
    max_input_image_bytes: config.maxInputImageBytes,
    max_response_bytes: config.maxResponseBytes,
    model: config.model,
    output_directory: config.outputDir,
    timeout_ms: config.timeoutMs,
  };
}

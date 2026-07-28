import type { AppConfig } from "../src/config.js";

export const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export function testConfig(outputDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiKey: "test-placeholder-key",
    baseUrl: new URL("https://sub2api.example.test/v1/"),
    credentialSource: "environment",
    maxInputImageBytes: 20 * 1024 * 1024,
    maxResponseBytes: 40 * 1024 * 1024,
    model: "gpt-image-2",
    outputDir,
    timeoutMs: 10_000,
    ...overrides,
  };
}

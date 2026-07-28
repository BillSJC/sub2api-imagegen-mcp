import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { SafeError } from "./errors.js";

export type SupportedImage = {
  readonly bytes: Buffer;
  readonly extension: "jpg" | "png" | "webp";
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
};

export interface ReferenceImage extends SupportedImage {
  readonly dataUrl: string;
  readonly path: string;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

export function inspectImage(bytes: Buffer): SupportedImage {
  if (bytes.length >= 8 && hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { bytes, extension: "png", mimeType: "image/png" };
  }
  if (bytes.length >= 3 && hasPrefix(bytes, [0xff, 0xd8, 0xff])) {
    return { bytes, extension: "jpg", mimeType: "image/jpeg" };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { bytes, extension: "webp", mimeType: "image/webp" };
  }
  throw new SafeError("unsupported_image", "Only valid PNG, JPEG, and WebP images are supported.");
}

export async function loadReferenceImage(
  inputPath: string,
  maximumBytes: number,
): Promise<ReferenceImage> {
  if (!path.isAbsolute(inputPath)) {
    throw new SafeError(
      "invalid_reference",
      `Reference image paths must be absolute: ${inputPath}`,
    );
  }

  let linkMetadata;
  try {
    linkMetadata = await lstat(inputPath);
  } catch (error) {
    throw new SafeError("invalid_reference", `Reference image does not exist: ${inputPath}`, {
      cause: error,
    });
  }
  if (linkMetadata.isSymbolicLink()) {
    throw new SafeError(
      "invalid_reference",
      `Reference images must not be symbolic links: ${inputPath}`,
    );
  }

  let canonicalPath: string;
  let metadata;
  try {
    canonicalPath = await realpath(inputPath);
    metadata = await stat(canonicalPath);
  } catch (error) {
    throw new SafeError("invalid_reference", `Reference image cannot be inspected: ${inputPath}`, {
      cause: error,
    });
  }
  if (!metadata.isFile()) {
    throw new SafeError(
      "invalid_reference",
      `Reference image must be a regular file: ${inputPath}`,
    );
  }
  if (metadata.size === 0 || metadata.size > maximumBytes) {
    throw new SafeError(
      "invalid_reference",
      `Reference image must be between 1 and ${maximumBytes} bytes: ${inputPath}`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(canonicalPath);
  } catch (error) {
    throw new SafeError("invalid_reference", `Reference image cannot be read: ${inputPath}`, {
      cause: error,
    });
  }
  if (bytes.length > maximumBytes) {
    throw new SafeError(
      "invalid_reference",
      `Reference image exceeds ${maximumBytes} bytes: ${inputPath}`,
    );
  }

  const inspected = inspectImage(bytes);
  return {
    ...inspected,
    dataUrl: `data:${inspected.mimeType};base64,${bytes.toString("base64")}`,
    path: canonicalPath,
  };
}

function safeOutputStem(outputName: string | undefined): string {
  if (outputName === undefined || outputName.trim() === "") {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `sub2api-image-${timestamp}`;
  }
  const trimmed = outputName.trim();
  if (
    trimmed.length > 128 ||
    trimmed === "." ||
    trimmed === ".." ||
    path.basename(trimmed) !== trimmed ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)
  ) {
    throw new SafeError(
      "invalid_output_name",
      "output_name must be a safe basename using letters, numbers, dot, underscore, or hyphen.",
    );
  }
  return trimmed.replace(/\.(?:jpe?g|png|webp)$/i, "");
}

export async function saveImage(
  outputDir: string,
  image: SupportedImage,
  outputName?: string,
): Promise<string> {
  try {
    await mkdir(outputDir, { mode: 0o700, recursive: true });
  } catch (error) {
    throw new SafeError(
      "output_error",
      "The configured image output directory cannot be created.",
      { cause: error },
    );
  }

  const stem = safeOutputStem(outputName);
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const fileName =
      suffix === 0 ? `${stem}.${image.extension}` : `${stem}-${suffix}.${image.extension}`;
    const destination = path.join(outputDir, fileName);
    let file;
    try {
      file = await open(
        destination,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        continue;
      }
      throw new SafeError(
        "output_error",
        "The generated image cannot be created in the configured output directory.",
        { cause: error },
      );
    }

    try {
      await file.writeFile(image.bytes);
      await file.sync();
      await file.close();
      return destination;
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(destination).catch(() => undefined);
      throw new SafeError("output_error", "The generated image could not be written completely.", {
        cause: error,
      });
    }
  }

  throw new SafeError("output_error", "No unused output filename could be allocated.");
}

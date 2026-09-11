import { z } from "zod";

export const imageQualitySchema = z.enum(["auto", "low", "medium", "high", "xhigh", "max"]);

export const imageSizeSchema = z.string().refine((value) => {
  if (value === "auto") return true;
  if (!/^[1-9][0-9]{0,3}x[1-9][0-9]{0,3}$/.test(value)) return false;
  const [width = 0, height = 0] = value.split("x").map(Number);
  const pixels = width * height;
  return (
    width % 16 === 0 &&
    height % 16 === 0 &&
    width <= 3840 &&
    height <= 3840 &&
    Math.max(width, height) <= 3 * Math.min(width, height) &&
    pixels >= 655_360 &&
    pixels <= 8_294_400
  );
}, "Use auto or WIDTHxHEIGHT: multiples of 16, edges <=3840, aspect ratio <=3:1, and 655360–8294400 pixels.");

export function isImage25Model(model: string): boolean {
  return /^gpt-image-2\.5-(flare|sunburst)(-2026-09-08)?$/.test(model);
}

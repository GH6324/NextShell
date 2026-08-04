import { describe, expect, it } from "vitest";
import { hasVisibleSamplePixel } from "./switchFreezeFrame";

/** RGBA sample of `count` fully transparent black pixels. */
const blankSample = (count: number): Uint8ClampedArray => new Uint8ClampedArray(count * 4);

describe("hasVisibleSamplePixel", () => {
  it("rejects an all-transparent-black sample", () => {
    // What a WebGL canvas without preserveDrawingBuffer reads back as once its
    // frame has been composited — freezing it would pin a blank rectangle.
    expect(hasVisibleSamplePixel(blankSample(64))).toBe(false);
  });

  it("rejects an empty sample", () => {
    expect(hasVisibleSamplePixel(new Uint8ClampedArray(0))).toBe(false);
  });

  it("accepts a sample with one opaque pixel", () => {
    const pixels = blankSample(64);
    pixels[4 * 40 + 3] = 255;
    expect(hasVisibleSamplePixel(pixels)).toBe(true);
  });

  it("accepts a barely visible pixel from a downscaled glyph", () => {
    // A 32x32 downscale of a mostly empty transparent terminal averages a glyph
    // down to a very low alpha; anything above zero still counts as painted.
    const pixels = blankSample(64);
    pixels[4 * 7 + 3] = 1;
    expect(hasVisibleSamplePixel(pixels)).toBe(true);
  });

  it("accepts colour that arrived with zero alpha", () => {
    // Not the transparent-black failure signature, so it is treated as content
    // rather than as a failed readback.
    const pixels = blankSample(64);
    pixels[4 * 12] = 200;
    expect(hasVisibleSamplePixel(pixels)).toBe(true);
  });
});

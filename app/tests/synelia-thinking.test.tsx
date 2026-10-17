import { afterAll, afterEach, beforeAll, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import {
  THINKING_SLOW_AFTER_MS,
  Thinking,
} from "@/components/channels/thinking";
import { ui } from "@/lib/i18n";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});
afterAll(() => GlobalRegistrator.unregister());

test("no first token after 8 s: the same status line says it can take up to 30 seconds", () => {
  jest.useFakeTimers();
  const view = render(<Thinking />);
  const status = view.getByRole("status");
  expect(status.textContent).toBe(ui.conversation.thinking);
  act(() => jest.advanceTimersByTime(THINKING_SLOW_AFTER_MS - 1));
  expect(status.textContent).toBe(ui.conversation.thinking);
  act(() => jest.advanceTimersByTime(1));
  // Same element, same region: an update of the line, not a second announcement source.
  expect(view.getAllByRole("status")).toEqual([status]);
  expect(status.textContent).toBe(
    "Le modèle réfléchit, cela peut prendre jusqu'à 30 secondes…",
  );
  expect(status.getAttribute("aria-live")).toBe("polite");
});

test("first token before 8 s (the line unmounts): the timer is cleared", () => {
  jest.useFakeTimers();
  const view = render(<Thinking />);
  expect(jest.getTimerCount()).toBe(1);
  view.unmount();
  expect(jest.getTimerCount()).toBe(0);
});

/** sRGB channel (0..1) → relative luminance component. */
const linear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
/** Achromatic oklch(L 0 0) → sRGB channel 0..1. */
const srgb = (l: number) => {
  const y = l ** 3;
  return y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055;
};
const contrast = (a: number, b: number) => {
  const [hi, lo] = [linear(a), linear(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("the thinking dot keeps ≥ 3:1 against the page at every frame, both themes, and honours reduced motion", () => {
  const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");
  const theme = (block: string, name: string) => {
    const match = block.match(
      new RegExp(`--${name}: oklch\\(([\\d.]+) 0 0\\)`),
    );
    if (!match) throw new Error(`--${name} not found`);
    return Number(match[1]);
  };
  const light = css.slice(css.indexOf(":root"));
  const dark = css.slice(css.indexOf(".dark"));
  const dot = css.slice(css.indexOf(".synelia-thinking::before"));
  expect(dot).toMatch(/background: var\(--color-foreground/);
  const keyframes = css.slice(css.indexOf("@keyframes synelia-thinking-pulse"));
  const opacities = [
    ...keyframes
      .slice(0, keyframes.indexOf("}\n}") + 3)
      .matchAll(/opacity: ([\d.]+)/g),
  ].map((m) => Number(m[1]));
  const faintest = Math.min(...opacities);
  for (const block of [light, dark]) {
    const bg = srgb(theme(block, "background"));
    const fg = srgb(theme(block, "foreground"));
    // Alpha compositing over the page, as the browser does in sRGB.
    const drawn = faintest * fg + (1 - faintest) * bg;
    expect(contrast(drawn, bg)).toBeGreaterThanOrEqual(3);
  }
  const reduced = css.slice(
    css.lastIndexOf(
      "@media (prefers-reduced-motion: reduce) {\n  .synelia-thinking",
    ),
  );
  expect(reduced).toMatch(/animation: none/);
  // The shimmer is kept for everybody else, and reduced motion gets its glyphs back.
  expect(css).toMatch(/\.tool-line-running \{[^}]*animation: tool-line-sweep/);
  expect(css).toMatch(/-webkit-text-fill-color: currentColor;/);
});

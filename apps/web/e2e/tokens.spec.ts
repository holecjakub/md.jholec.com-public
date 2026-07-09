import { test, expect } from "@playwright/test";

/** Parse a computed `rgb(r, g, b)` / `rgba(...)` string into channel values. */
function parseRgb(color: string): [number, number, number] {
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) throw new Error(`Unexpected color format: ${color}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** WCAG relative luminance of a computed rgb() color. */
function luminance(color: string): number {
  const [r, g, b] = parseRgb(color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio between two computed rgb() colors. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

test("accent color resolves from CSS variables", async ({ page }) => {
  await page.goto("/");
  // The CSS pipeline (Lightning CSS) may normalize the hex value (e.g. #0099ff -> #09f),
  // so resolve both the actual and expected colors to canonical rgb() form before comparing.
  const [actual, expected] = await page.evaluate(() => {
    const toRgb = (color: string) => {
      const el = document.createElement("div");
      el.style.color = color;
      document.body.appendChild(el);
      const rgb = getComputedStyle(el).color;
      el.remove();
      return rgb;
    };
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim();
    return [toRgb(raw), toRgb("#0099ff")];
  });
  expect(actual).toBe(expected);
});

test("elevated surface token contrasts with the page background in both themes", async ({
  page,
}) => {
  await page.goto("/");

  // Read both themes WITHOUT toggling the document theme: the `.dark` selector
  // sets the dark custom properties, and CSS variables cascade, so a probe nested
  // in a temporary `.dark` wrapper resolves the dark values. This sidesteps a race
  // with next-themes re-applying the document class under parallel load.
  const { light, dark } = await page.evaluate(() => {
    const toRgb = (color: string) => {
      const el = document.createElement("div");
      el.style.color = color;
      document.body.appendChild(el);
      const rgb = getComputedStyle(el).color;
      el.remove();
      return rgb;
    };
    const readFrom = (probe: HTMLElement, name: string) =>
      toRgb(getComputedStyle(probe).getPropertyValue(name).trim());

    const lightProbe = document.createElement("div");
    document.body.appendChild(lightProbe);

    const darkWrap = document.createElement("div");
    darkWrap.className = "dark";
    const darkProbe = document.createElement("div");
    darkWrap.appendChild(darkProbe);
    document.body.appendChild(darkWrap);

    const result = {
      light: {
        elevated: readFrom(lightProbe, "--elevated"),
        background: readFrom(lightProbe, "--background"),
      },
      dark: {
        elevated: readFrom(darkProbe, "--elevated"),
        background: readFrom(darkProbe, "--background"),
      },
    };
    lightProbe.remove();
    darkWrap.remove();
    return result;
  });

  // Light: a faint grey, distinct from the white page.
  expect(light.elevated).toBe("rgb(244, 244, 245)");
  expect(light.elevated).not.toBe(light.background);

  // Dark: a near-black grey lifted off the #0a0a0a page.
  expect(dark.elevated).toBe("rgb(24, 24, 26)");
  expect(dark.elevated).not.toBe(dark.background);
});

test("muted-surface pairs AA with muted-foreground text in both themes", async ({
  page,
}) => {
  await page.goto("/");

  // M14 (root of blocker B2): --muted / --muted-foreground are strictly TEXT
  // greys; bg-muted-surface is the surface they sit on (resolved badges, avatar
  // fallback initials, ghost/outline button hover). In dark, --muted and
  // --muted-foreground both resolve to #a8a8a8, so the old bg-muted +
  // text-muted-foreground pairing was invisible (1:1).
  const themes = await page.evaluate(() => {
    const toRgb = (color: string) => {
      const el = document.createElement("div");
      el.style.color = color;
      document.body.appendChild(el);
      const rgb = getComputedStyle(el).color;
      el.remove();
      return rgb;
    };
    const readFrom = (probe: HTMLElement, name: string) =>
      toRgb(getComputedStyle(probe).getPropertyValue(name).trim());

    const lightProbe = document.createElement("div");
    document.body.appendChild(lightProbe);

    const darkWrap = document.createElement("div");
    darkWrap.className = "dark";
    const darkProbe = document.createElement("div");
    darkWrap.appendChild(darkProbe);
    document.body.appendChild(darkWrap);

    const read = (probe: HTMLElement) => ({
      mutedSurface: readFrom(probe, "--muted-surface"),
      mutedForeground: readFrom(probe, "--muted-foreground"),
      muted: readFrom(probe, "--muted"),
    });
    const result = { light: read(lightProbe), dark: read(darkProbe) };
    lightProbe.remove();
    darkWrap.remove();
    return result;
  });

  for (const theme of ["light", "dark"] as const) {
    const t = themes[theme];
    // The surface must never collapse into the text greys (the B2 failure mode)…
    expect(t.mutedSurface).not.toBe(t.muted);
    expect(t.mutedSurface).not.toBe(t.mutedForeground);
    // …and muted text on it must clear WCAG AA for normal text.
    expect(contrast(t.mutedForeground, t.mutedSurface)).toBeGreaterThanOrEqual(4.5);
  }
});

test("elevation shadow tokens exist and adapt to the dark theme", async ({
  page,
}) => {
  await page.goto("/");

  // M15: floating surfaces consume --shadow-pill / --shadow-popover instead of
  // hardcoded pure-black shadows (which vanish on the #0a0a0a dark page). The
  // dark recipes add a top inset highlight so elevation still reads.
  const themes = await page.evaluate(() => {
    const readFrom = (probe: HTMLElement, name: string) =>
      getComputedStyle(probe).getPropertyValue(name).trim();

    const lightProbe = document.createElement("div");
    document.body.appendChild(lightProbe);

    const darkWrap = document.createElement("div");
    darkWrap.className = "dark";
    const darkProbe = document.createElement("div");
    darkWrap.appendChild(darkProbe);
    document.body.appendChild(darkWrap);

    const read = (probe: HTMLElement) => ({
      pill: readFrom(probe, "--shadow-pill"),
      popover: readFrom(probe, "--shadow-popover"),
    });
    const result = { light: read(lightProbe), dark: read(darkProbe) };
    lightProbe.remove();
    darkWrap.remove();
    return result;
  });

  for (const key of ["pill", "popover"] as const) {
    // Defined in both themes…
    expect(themes.light[key].length).toBeGreaterThan(0);
    expect(themes.dark[key].length).toBeGreaterThan(0);
    // …theme-aware (dark is a different, deeper recipe)…
    expect(themes.dark[key]).not.toBe(themes.light[key]);
    // …and the dark recipe carries the inset top highlight.
    expect(themes.dark[key]).toContain("inset");
    expect(themes.light[key]).not.toContain("inset");
  }
});

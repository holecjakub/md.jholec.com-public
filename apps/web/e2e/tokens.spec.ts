import { test, expect } from "@playwright/test";

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

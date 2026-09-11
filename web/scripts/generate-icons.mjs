import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Run explicitly when the design changes; production builds use committed PNGs.
const directory = new URL("../public/icons/", import.meta.url);
const svg = await readFile(new URL("pt.svg", directory), "utf8");
const browser = await chromium.launch();
try {
  for (
    const [name, size] of [
      ["icon-192.png", 192],
      ["icon-512.png", 512],
      ["apple-touch-icon.png", 180],
    ]
  ) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<style>body { margin: 0; } svg { display: block; width: 100vw; height: 100vh; }</style>${svg}`,
    );
    await page.screenshot({ path: fileURLToPath(new URL(name, directory)) });
    await page.close();
    console.log(`Generated ${name} (${size}×${size})`);
  }
} finally {
  await browser.close();
}

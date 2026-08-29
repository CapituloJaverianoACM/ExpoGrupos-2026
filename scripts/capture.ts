/**
 * Capturas de la escena en varios estados, para revisión visual. `bun run capture`
 * Requiere el servidor levantado (SMOKE_URL o localhost:3000).
 */

import { chromium } from "playwright";

const BASE = process.env.SMOKE_URL ?? "http://localhost:3000";
const OUT = process.env.CAPTURE_DIR ?? "/tmp/opencode/shots";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.error("pageerror:", e.message));

await page.goto(BASE, { waitUntil: "networkidle", timeout: 90_000 });
await page.locator("canvas").waitFor({ state: "visible", timeout: 60_000 });

/** SwiftShader necesita tiempo real para completar frames. */
const settle = (ms = 14_000) => page.waitForTimeout(ms);

await settle();
await page.screenshot({ path: `${OUT}/01-inicial.png` });
console.log("01-inicial — encuadre por defecto");

// Órbita: arrastrar el canvas.
await page.mouse.move(900, 450);
await page.mouse.down();
await page.mouse.move(1150, 380, { steps: 12 });
await page.mouse.up();
await settle(10_000);
await page.screenshot({ path: `${OUT}/02-orbita.png` });
console.log("02-orbita — tras rotar la cámara");

// Zoom out con la rueda.
await page.mouse.move(900, 450);
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(400);
}
await settle(10_000);
await page.screenshot({ path: `${OUT}/03-alejado.png` });
console.log("03-alejado — vista completa del campus");

// Seleccionar un edificio alto y reconocible.
await page.locator("aside input").fill("Maldonado");
await page.waitForTimeout(800);
await page.locator("aside button").first().click();
await settle(14_000);
await page.screenshot({ path: `${OUT}/04-seleccion.png` });
console.log("04-seleccion — vuelo a un edificio");

await browser.close();
console.log(`\nCapturas en ${OUT}`);

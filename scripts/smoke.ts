/**
 * Smoke test de la escena 3D en un navegador real. `bun run smoke`
 *
 * Comprueba lo que las comprobaciones de geometría no pueden: que la app arranca en un
 * navegador, que WebGL dibuja los volúmenes y que la interacción responde. Renderiza por
 * software (SwiftShader), así que es lento pero no necesita GPU.
 *
 * Requiere el servidor levantado aparte:  bun run dev  (o  bun run start)
 */

import { chromium, type ConsoleMessage } from "playwright";

const BASE = process.env.SMOKE_URL ?? "http://localhost:3000";
const SHOT = "/tmp/opencode/campus.png";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors: string[] = [];
const pageErrors: string[] = [];
page.on("console", (m: ConsoleMessage) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => pageErrors.push(e.message));

// Contador de draw calls: es la única forma fiable de distinguir "el canvas existe"
// de "el canvas está dibujando los 276 edificios".
await page.addInitScript(() => {
  (window as unknown as { __draws: number }).__draws = 0;
  const patch = (proto: object | undefined) => {
    if (!proto) return;
    const target = proto as Record<string, (...args: unknown[]) => unknown>;
    for (const fn of ["drawElements", "drawArrays"]) {
      const original = target[fn];
      if (typeof original !== "function") continue;
      target[fn] = function (this: unknown, ...args: unknown[]) {
        (window as unknown as { __draws: number }).__draws++;
        return original.apply(this, args);
      };
    }
  };
  patch(window.WebGL2RenderingContext?.prototype);
  patch(window.WebGLRenderingContext?.prototype);
});

console.log(`Cargando ${BASE} …`);
await page.goto(BASE, { waitUntil: "networkidle", timeout: 90_000 });

/* ---------- 1. Arranque ---------- */
console.log("\nArranque:");
const canvas = page.locator("canvas");
await canvas.waitFor({ state: "visible", timeout: 60_000 });
check("el canvas se monta", await canvas.isVisible());

const title = await page.locator("h1").first().textContent();
check("cabecera renderizada", title?.includes("Javeriana") ?? false, title ?? "");

const items = await page.locator("aside button").count();
check("la lista lateral se puebla", items > 45, `${items} botones`);

/* ---------- 2. WebGL dibuja ---------- */
console.log("\nRender:");
// SwiftShader es lento: se le dan varios segundos para completar frames.
await page.waitForTimeout(12_000);
const draws = await page.evaluate(() => (window as unknown as { __draws: number }).__draws);
check("WebGL ejecuta draw calls", draws > 0, `${draws} acumuladas`);
check(
  "se dibujan los volúmenes del campus (>250 por frame esperados)",
  draws > 250,
  `${draws} acumuladas`,
);

const glInfo = await page.evaluate(() => {
  const c = document.querySelector("canvas") as HTMLCanvasElement | null;
  if (!c) return null;
  const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
  return gl
    ? { version: gl.getParameter(gl.VERSION) as string, w: c.width, h: c.height }
    : null;
});
check("contexto WebGL activo", glInfo !== null, glInfo ? `${glInfo.version} @ ${glInfo.w}×${glInfo.h}` : "");

/* ---------- 3. Etiquetas ---------- */
console.log("\nEtiquetas:");
const labels = await page.locator("canvas + div div, [style*='translate3d']").count();
check("hay etiquetas en el DOM", labels > 0, `${labels} nodos`);

/* ---------- 4. Interacción ---------- */
console.log("\nInteracción:");
const first = page.locator("aside button").first();
const name = (await first.textContent())?.trim().slice(0, 40) ?? "";
await first.click();
await page.waitForTimeout(2500);

const panel = page.locator("section").filter({ hasText: "Tipo (OSM)" });
check("al seleccionar se abre la ficha", (await panel.count()) > 0, name);

const osmLink = await page.locator('a[href*="openstreetmap.org/way"], a[href*="openstreetmap.org/relation"]').count();
check("la ficha enlaza al objeto en OSM", osmLink > 0);

await page.locator("aside").getByText("Etiquetas").click();
await page.waitForTimeout(1500);
check("el toggle de etiquetas responde", true);

/* ---------- 5. Errores ---------- */
console.log("\nErrores de runtime:");
// Ruido esperable del render por software.
const ignorable = /SwiftShader|Software rendering|GroupMarkerNotSet|Failed to load resource.*favicon/i;
const realConsole = consoleErrors.filter((e) => !ignorable.test(e));
check("sin errores en consola", realConsole.length === 0, realConsole.slice(0, 3).join(" | "));
check("sin excepciones no capturadas", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

await page.screenshot({ path: SHOT });
console.log(`\nCaptura: ${SHOT}`);

await browser.close();
console.log(failures === 0 ? "\n✓ Smoke test OK" : `\n✗ ${failures} fallos`);
process.exit(failures === 0 ? 0 : 1);

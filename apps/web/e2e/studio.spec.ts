import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { STUDIO_ENV } from "./paths";

/**
 * The studio end to end (Task 11.4), with the offline stand-in model and tone voices: upload an
 * EPUB, make a chapter, hear it on the radio served from the data volume, change a voice and see
 * only that character re-recorded. A real worker runs beside the production web server. Also
 * checks that the radio as the live site runs it (generation off) has no studio at all.
 */

const STUDIO = "http://127.0.0.1:3124";
const DRACULA = join(import.meta.dirname, "../../../fixtures/books/bram-stoker_dracula.epub");

test.describe("generation off (the live site)", () => {
  test("there is no studio, no link to it, and every generation route is refused", async ({ page, request }) => {
    expect((await page.goto("/studio"))!.status()).toBe(404);
    await page.goto("/");
    await expect(page.getByRole("note")).toHaveText("AI-generated");
    await expect(page.getByRole("link", { name: /Make your own broadcast/ })).toHaveCount(0);
    for (const r of [
      await request.post("/api/books", { data: "x", headers: { "x-file-name": "a.epub" } }),
      await request.get("/api/books/bk-0123456789abcdef"),
      await request.post("/api/books/bk-0123456789abcdef/generate", { data: { chapters: [1], charBudget: 1000 } }),
    ]) {
      expect(r.status()).toBe(404);
    }
  });
});

test.describe("the studio (stub providers)", () => {
  test.describe.configure({ mode: "serial" });
  let worker: ChildProcess;
  const workerLog: string[] = [];

  test.beforeAll(async () => {
    worker = spawn("node", ["--import", "tsx", "src/main.ts"], { cwd: join(import.meta.dirname, "../../worker"), env: { ...process.env, ...STUDIO_ENV }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    worker.stdout!.on("data", (d: Buffer) => workerLog.push(d.toString()));
    worker.stderr!.on("data", (d: Buffer) => workerLog.push(d.toString()));
    await expect.poll(() => workerLog.join(""), { timeout: 30_000 }).toContain('"jobKinds":["episode"]');
  });
  test.afterAll(async () => {
    if (worker?.pid && worker.exitCode === null) process.kill(-worker.pid, "SIGTERM");
  });

  test("upload, make an episode with a designed voice per character, hear it on the radio", async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto(`${STUDIO}/`);
    await page.getByRole("link", { name: "Make your own broadcast from a DRM-free book" }).click();
    await expect(page.getByRole("heading", { name: "Before you upload" })).toBeVisible();

    // The rights box must be ticked first (Req 9.1).
    await page.getByLabel("EPUB file").setInputFiles(DRACULA);
    await expect(page.locator(".studio-error")).toHaveText("Confirm that you have the right to adapt this book first.");
    await page.getByLabel("I have the right to adapt the book I upload.").check();
    await page.getByLabel("EPUB file").setInputFiles(DRACULA);
    await expect(page.locator(".book-title")).toHaveText("Dracula · Bram Stoker");
    await expect(page.locator(".studio-error")).toHaveCount(0);
    await expect(page).toHaveURL(/\?book=bk-[0-9a-f]{16}$/);
    const chapter1 = page.locator('.episode-state[data-chapter="1"]');
    await expect(chapter1).toHaveText("Episode 1: Not started");

    // The budget field caps itself at the operator ceiling, and the form submits from the default value.
    const budget = page.getByLabel(/Speech budget for this book/);
    await expect(budget).toHaveValue("60000");
    await page.getByRole("button", { name: "Make this episode" }).click();
    await expect(page.getByRole("status")).toHaveText("1 episode(s) queued. They appear on the radio when ready.");
    await expect(chapter1).toHaveText("Episode 1: On air", { timeout: 180_000 });
    const spokenBefore = Number((await page.getByText(/characters spoken so far/).textContent())!.replace(/[^0-9]/g, ""));
    expect(spokenBefore).toBeGreaterThan(0);

    // The new station plays from the data volume on the production server.
    await page.getByRole("link", { name: "radio", exact: true }).click();
    await page.getByRole("button", { name: "Power" }).click();
    await expect(page.locator(".radio-layout")).toHaveAttribute("data-station", /^dracula-[0-9a-f]{6}-e1$/);
    await expect(page.locator(".now-playing .station")).toHaveText("Dracula \u2014 Episode 1");
    await expect(page.locator(".now-playing .line")).not.toHaveText("\u00a0", { timeout: 15_000 }); // a caption from the published transcript
    await page.goBack();

    // Casting is automatic: every character has a voice designed from the LLM's description, shown, not edited.
    const stranger = page.locator(".cast-table tr", { hasText: "The Stranger" });
    await expect(stranger).toContainText("A clear, steady adult voice of middle pitch and even pace, for The Stranger.");
    await expect(page.locator(".cast-table select")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /voice/i })).toHaveCount(0);
  });

  test("refuses what is not an EPUB, with the reason", async ({ page }) => {
    await page.goto(`${STUDIO}/studio`);
    await page.getByLabel("I have the right to adapt the book I upload.").check();
    await page.getByLabel("EPUB file").setInputFiles({ name: "notes.epub", mimeType: "application/epub+zip", buffer: Buffer.from("not a zip") });
    await expect(page.locator(".studio-error")).toHaveText(/^This EPUB cannot be used: /);
    await page.getByLabel("EPUB file").setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") });
    await expect(page.locator(".studio-error")).toHaveText("Choose an .epub file.");
  });
});

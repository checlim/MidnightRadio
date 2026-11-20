import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { FIXTURES } from "./global-setup";

/**
 * The player in a real browser (Task 10.4, Req 7.1–7.5): power-on unlocking audio, tuning,
 * keyboard control without stealing typing, the transcript, opt-in announcements, the retry
 * after a refused play(), and a warming-up station. Station files are served by route mocks.
 */

const STATIONS = {
  stations: [
    { status: "ready", id: "dracula-1", book: "Dracula", author: "Bram Stoker", episodeNumber: 1, title: "Jonathan Harker\u2019s Journal", durationMs: 8000, cleanUrl: "/e2e/dracula-1.mp3", amUrl: "/e2e/dracula-1-am.mp3", vttUrl: "/e2e/dracula-1.vtt" },
    { status: "ready", id: "heart-1", book: "Short Fiction", author: "Edgar Allan Poe", episodeNumber: 1, title: "The Telltale Heart", durationMs: 8000, cleanUrl: "/e2e/heart-1.mp3", amUrl: "/e2e/heart-1-am.mp3", vttUrl: "/e2e/heart-1.vtt" },
    { status: "warming", id: "dracula-2", book: "Dracula", author: "Bram Stoker", episodeNumber: 2, title: "Jonathan Harker\u2019s Journal (continued)", rendered: 47, total: 132 },
  ],
};

async function serve(page: Page, opts: { failAudio?: boolean } = {}) {
  await page.route("**/stations.json", (r) => r.fulfill({ json: STATIONS }));
  await page.route("**/e2e/*.vtt", (r) => r.fulfill({ body: readFileSync(join(FIXTURES, "episode.vtt"), "utf8"), contentType: "text/vtt" }));
  await page.route("**/e2e/*.mp3", (r) =>
    opts.failAudio ? r.abort("failed") : r.fulfill({ body: readFileSync(join(FIXTURES, r.request().url().includes("-am") ? "am.mp3" : "clean.mp3")), contentType: "audio/mpeg" }),
  );
}
const player = (page: Page) => page.locator(".radio-layout");
const slider = (page: Page) => page.getByRole("slider", { name: "Tuning" });

test.beforeEach(async ({ page }) => {
  await serve(page);
  await page.goto("/");
});

test("stays silent until the POWER switch, then tunes in the first station and plays it", async ({ page }) => {
  await expect(player(page)).toHaveAttribute("data-power", "off");
  await expect(page.getByText("Switch on the set with the POWER knob")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transcript" })).toHaveCount(0);
  await page.getByRole("button", { name: "Power" }).click();
  await expect(page.getByRole("button", { name: "Power" })).toHaveAttribute("aria-pressed", "true");
  await expect(player(page)).toHaveAttribute("data-power", "on");
  await expect(player(page)).toHaveAttribute("data-station", "dracula-1");
  await expect(player(page)).toHaveAttribute("data-wants-play", "true");
  await expect(page.locator(".now-playing .station")).toHaveText("Dracula \u2014 Episode 1");
  await expect(page.locator(".now-playing .line")).toHaveText("Good evening, listeners.");
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "650 kilocycles, Dracula, episode 1: Jonathan Harker\u2019s Journal");
});

test("tunes with the arrow keys and toggles play with Space, but never while typing in the search box", async ({ page }) => {
  await page.getByRole("button", { name: "Power" }).click();
  await expect(player(page)).toHaveAttribute("data-station", "dracula-1");
  await slider(page).focus();
  await page.keyboard.press("ArrowRight");
  await expect(player(page)).toHaveAttribute("data-station", "heart-1");
  await expect(slider(page)).toHaveAttribute("aria-valuetext", /Short Fiction, episode 1: The Telltale Heart/);
  await page.keyboard.press("ArrowLeft");
  await expect(player(page)).toHaveAttribute("data-station", "dracula-1");
  await page.keyboard.press("Space");
  await expect(player(page)).toHaveAttribute("data-wants-play", "false");
  await expect(page.getByText("Paused. Press Space to listen.")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(player(page)).toHaveAttribute("data-wants-play", "true");

  const search = page.getByRole("searchbox", { name: "Search the transcript" });
  await search.click();
  await page.keyboard.type("Count Dracula");
  await page.keyboard.press("ArrowRight");
  await expect(search).toHaveValue("Count Dracula");
  await expect(player(page)).toHaveAttribute("data-wants-play", "true"); // the spaces typed did not pause
  await expect(player(page)).toHaveAttribute("data-station", "dracula-1"); // the arrow did not tune
  await expect(page.getByRole("status")).toHaveText("2 matches");
});

test("jumps to a transcript line and highlights the line playing", async ({ page }) => {
  await page.getByRole("button", { name: "Power" }).click();
  await page.locator(".transcript button", { hasText: "Count Dracula?" }).click();
  await expect(page.locator('.transcript li[aria-current="true"]')).toContainText("Count Dracula?");
  await expect(page.locator(".now-playing .speaker")).toHaveText("Jonathan Harker");
});

test("announces lines to screen readers only when asked", async ({ page }) => {
  await page.getByRole("button", { name: "Power" }).click();
  const live = page.locator('[aria-live="polite"]');
  await expect(page.locator(".now-playing .line")).toHaveText("Good evening, listeners.");
  await expect(live).toHaveText("");
  await page.getByRole("checkbox", { name: "Announce lines for screen readers" }).check();
  await expect(live).toHaveText("Announcer: Good evening, listeners.");
});

test("switches to Vintage AM and back with the tone knob", async ({ page }) => {
  await page.getByRole("button", { name: "Power" }).click();
  const tone = page.getByRole("switch", { name: "Vintage AM sound" });
  await expect(tone).toHaveAttribute("aria-checked", "false");
  await tone.click();
  await expect(tone).toHaveAttribute("aria-checked", "true");
  await expect(player(page)).toHaveAttribute("data-variant", "am");
  await expect(page.locator(".engraving").nth(2)).toHaveText("Vintage AM");
  await tone.press("Space"); // a switch toggles on Space by itself, once
  await expect(player(page)).toHaveAttribute("data-variant", "clean");
});

test("shows a warming-up station with its progress", async ({ page }) => {
  await page.getByRole("button", { name: "Power" }).click();
  await slider(page).focus();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Warming up: 47 of 132 lines rendered")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Lines rendered" })).toHaveAttribute("value", "47");
  await expect(slider(page)).toHaveAttribute("aria-valuetext", /warming up, 47 of 132 lines rendered/);
  await expect(player(page)).toHaveAttribute("data-station", "");
});

test("between stations there is only static", async ({ page }) => {
  await page.getByRole("button", { name: "Power" }).click();
  const box = await page.locator(".dial-hit").boundingBox();
  await page.mouse.click(box!.x + box!.width * 0.3, box!.y + box!.height / 2);
  await expect(slider(page)).toHaveAttribute("aria-valuetext", /kilocycles, static$/);
  await expect(page.getByText(/Static\u2026 \d+ kc/)).toBeVisible();
  await expect(player(page)).toHaveAttribute("data-station", "");
});

test("offers a retry when the browser cannot start the broadcast", async ({ page }) => {
  await page.unrouteAll();
  await serve(page, { failAudio: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Power" }).click();
  const retry = page.getByRole("button", { name: "The broadcast did not start. Try again" });
  await expect(retry).toBeVisible();
  await page.unrouteAll();
  await serve(page);
  await retry.click();
  await expect(player(page)).toHaveAttribute("data-blocked", "false");
  await expect(retry).toHaveCount(0);
});

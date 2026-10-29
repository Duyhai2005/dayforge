import { expect, test } from "@playwright/test";

test("root redirects to the work calendar", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/work(?:\?date=\d{4}-\d{2}-\d{2})?$/);
});

for (const [route, heading] of [
  ["/work", "Lịch công việc"],
  ["/milestones", "Lịch dấu mốc"],
] as const) {
  test(`${route} serves an accessible Vietnamese shell without calendar records`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(`${heading} | DAYFORGE`);
    await expect(page.locator("html")).toHaveAttribute("lang", "vi");
    const main = page.getByRole("main");
    await expect(main).toHaveAttribute("id", "calendar-main");
    await expect(main).toHaveAttribute("tabindex", "-1");
    await expect(main.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    await expect(main.getByRole("button", { name: "Mở hoặc đóng điều hướng lịch" })).toHaveAttribute("aria-expanded", "false");
    await expect(main.getByRole("status")).toHaveText("Chưa kết nối dữ liệu");
  });
}

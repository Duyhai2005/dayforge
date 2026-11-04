import { expect, test } from "@playwright/test";
import { expectVerifiedSession, loginOwner, readOwnerCredentials } from "./fixtures";

test("verifiedOwnerCanOpenARealSession", async ({ page }) => {
  const owner = readOwnerCredentials();
  await loginOwner(page, owner);
  const ownerId = await expectVerifiedSession(page.request);
  expect(ownerId.length).toBeGreaterThan(0);
});

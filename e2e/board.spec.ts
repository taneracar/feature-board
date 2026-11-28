import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

const uid = () => Math.random().toString(36).slice(2, 8);

async function signUp(page: Page, name: string, next?: string) {
  const email = `${name.toLowerCase()}-${uid()}@example.test`;
  await page.goto(next ? `/signup?next=${encodeURIComponent(next)}` : "/signup");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  return email;
}

async function newWorkspace(page: Page, name: string) {
  await page.waitForURL("**/workspaces");
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return new URL(page.url()).pathname.split("/")[2];
}

async function fresh(browser: Browser, project: string) {
  const ctx = await browser.newContext(project === "phone" ? { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true } : {});
  return ctx.newPage();
}

test("app routes redirect to sign in, and come back after it", async ({ page }) => {
  await page.goto("/workspaces");
  await expect(page).toHaveURL(/\/login\?next=%2Fworkspaces/);
  await page.getByRole("link", { name: "Create an account" }).click();
  await signUp(page, "Back");
  await expect(page).toHaveURL(/\/workspaces$/);
});

test("sign up shows field errors and keeps typed values", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Name").fill("Short");
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByLabel("Password").fill("short");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  await expect(page.getByText("Use at least 10 characters.")).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("Short");
  await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
});

test("wrong password gives one generic message", async ({ page }) => {
  const email = await signUp(page, "Pw");
  await page.waitForURL("**/workspaces");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("wrong-password-here");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Next adds its own empty role=alert route announcer, so scope to the form.
  await expect(page.locator("form").getByRole("alert")).toHaveText("Email or password is incorrect.");
});

test("session cookie is httpOnly and SameSite=Lax", async ({ page, context }) => {
  await signUp(page, "Cookie");
  await page.waitForURL("**/workspaces");
  const c = (await context.cookies()).find((x) => x.name === "fb_session");
  expect(c).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  expect(await page.evaluate(() => document.cookie)).not.toContain("fb_session");
});

test("post, vote optimistically, filter, delete", async ({ page }) => {
  await signUp(page, "Poster");
  const slug = await newWorkspace(page, `Team ${uid()}`);

  await page.getByLabel("What should we build?").fill("Dark mode");
  await page.getByRole("button", { name: "Post request" }).click();
  await expect(page.getByText("Request posted.")).toBeVisible();
  await expect(page.getByLabel("What should we build?")).toHaveValue("");

  const card = page.getByTestId("request").filter({ hasText: "Dark mode" });
  const vote = card.getByRole("button", { name: /Dark mode/ });
  await expect(vote).toHaveAttribute("aria-pressed", "true");
  await expect(vote).toContainText("1");
  await vote.click();
  await expect(vote).toHaveAttribute("aria-pressed", "false");
  await expect(vote).toContainText("0");
  await page.reload();
  await expect(page.getByTestId("request").getByRole("button", { name: /Dark mode/ })).toContainText("0");

  // Owner sets a status, then the "Active" filter hides declined requests.
  await card.getByLabel("Status for Dark mode").selectOption("declined");
  await card.getByRole("button", { name: "Set status" }).click();
  await expect(page.getByTestId("request")).toHaveCount(0);
  await page.goto(`/w/${slug}?status=declined`);
  await expect(page.getByTestId("request")).toHaveCount(1);

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("request")).toHaveCount(0);
});

test("invite: member joins once, sees no admin controls, outsiders get 404", async ({ page, browser }, info) => {
  await signUp(page, "Owner");
  const slug = await newWorkspace(page, `Invites ${uid()}`);
  await page.getByLabel("What should we build?").fill("SSO login");
  await page.getByRole("button", { name: "Post request" }).click();
  await expect(page.getByTestId("request")).toHaveCount(1);

  await page.getByRole("link", { name: "Members" }).click();
  await page.getByRole("button", { name: "Create invite link" }).click();
  const link = await page.getByLabel(/Single-use link/).inputValue();
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
  const path = new URL(link).pathname;

  const member = await fresh(browser, info.project.name);
  await member.goto(path);
  await member.getByRole("link", { name: "Create an account to join" }).click();
  await signUp(member, "Member", path);
  await member.waitForURL(`**${path}`);
  await member.getByRole("button", { name: /Join as Member/ }).click();
  await expect(member).toHaveURL(new RegExp(`/w/${slug}$`));

  const card = member.getByTestId("request").filter({ hasText: "SSO login" });
  await expect(card.getByRole("button", { name: "Set status" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await card.getByRole("button", { name: /SSO login/ }).click();
  await expect(card.getByRole("button", { name: /SSO login/ })).toContainText("2");

  await member.goto(`/w/${slug}/members`);
  await expect(member.getByRole("button", { name: "Create invite link" })).toHaveCount(0);
  await expect(member.getByTestId("member")).toHaveCount(2);

  // The link is single use.
  const third = await fresh(browser, info.project.name);
  await third.goto(path);
  await expect(third.getByRole("heading", { name: "This invite can’t be used" })).toBeVisible();

  // An outsider gets the same 404 for a real slug as for a made-up one.
  await signUp(third, "Outsider");
  await third.waitForURL("**/workspaces");
  const real = await third.goto(`/w/${slug}`);
  await expect(third.getByRole("heading", { name: "Not found" })).toBeVisible();
  const fake = await third.goto(`/w/nope-${uid()}`);
  expect(real?.status()).toBe(fake?.status());
  await member.context().close();
  await third.context().close();
});

test("no horizontal overflow and no axe violations (light + dark)", async ({ page }, info) => {
  await signUp(page, "Axe");
  const slug = await newWorkspace(page, `Axe ${uid()}`);
  await page.getByLabel("What should we build?").fill("A long request title that should wrap nicely on a phone screen");
  await page.getByLabel("Details (optional)").fill("Some details.\nOn two lines.");
  await page.getByRole("button", { name: "Post request" }).click();
  await expect(page.getByTestId("request")).toHaveCount(1);

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of [`/w/${slug}`, `/w/${slug}/members`, "/workspaces"]) {
      await page.goto(path);
      // Wait for the streamed content, not the Suspense skeleton.
      await expect(page.locator("main h1")).toBeVisible();
      await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} overflows`).toBeLessThanOrEqual(0);
      const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(res.violations.map((v) => `${v.id}: ${v.nodes.length}`), `${scheme} ${path}`).toEqual([]);
    }
    if (info.project.name === "phone" || scheme === "light") {
      await page.goto(`/w/${slug}`);
      await expect(page.getByTestId("request").first()).toBeVisible();
      await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
      await page.screenshot({ path: `test-results/shots/${info.project.name}-${scheme}-board.png`, fullPage: true });
    }
  }
  for (const path of ["/", "/login", "/signup"]) {
    await page.context().clearCookies();
    await page.goto(path);
    const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(res.violations.map((v) => v.id), path).toEqual([]);
  }
});

test("security headers are set", async ({ request }) => {
  const res = await request.get("/");
  expect(res.headers()["x-frame-options"]).toBe("DENY");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["x-powered-by"]).toBeUndefined();
});

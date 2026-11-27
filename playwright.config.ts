import { defineConfig, devices } from "@playwright/test";

const PORT = 5198;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  // Production build against a throwaway database. INSECURE_COOKIES lets the
  // Secure cookie flag off because the test server is plain http.
  webServer: {
    command: `rm -rf .data/e2e && next build && next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: { DATABASE_DIR: ".data/e2e", INSECURE_COOKIES: "1", SCRYPT_N: "16384" },
  },
});

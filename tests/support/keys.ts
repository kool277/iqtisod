import { expect, type Page } from '@playwright/test'

/** Whether the build under test creates vaults with per-person keys: every build except one made with VITE_V2_KEYS=0. */
export const KEYS_BUILD = process.env.VITE_V2_KEYS !== '0'

/** Waits for the dashboard after setup; a vault with per-person keys first shows its founder the key to write down. */
export async function finishSetup(page: Page): Promise<void> {
  if (KEYS_BUILD) {
    await expect(page.getByTestId('fingerprint-notice')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('fingerprint-done').click()
  }
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })
}

/** The first sign-in to a vault with per-person keys in a browser stops to compare the founder key. */
export async function confirmFounderKey(page: Page): Promise<void> {
  await expect(page.getByTestId('trust-step')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('trust-confirm').click()
}

/**
 * After an admin signs in to a 1.x vault: a build with per-person keys offers the upgrade at every such sign-in until
 * it is taken, and "Not now" keeps the 1.x vault as it is.
 */
export async function skipUpgradeOffer(page: Page): Promise<void> {
  if (!KEYS_BUILD) return
  await expect(page.getByTestId('upgrade-offer')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('upgrade-later').click()
  await expect(page.getByTestId('upgrade-offer')).toHaveCount(0)
}

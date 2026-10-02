import { expect, test, type Page } from '@playwright/test'
import { watchViolations } from '../support/csp'

const ADMIN = { email: 'admin@example.com', password: 'Correct horse lantern 7' }
const MANAGER = { email: 'mira@example.com', renamed: 'mira.k@example.com', name: 'Mira Karimova', temporary: 'Temp maple kettle 101', password: 'Own orchard lantern 11' }
const VIEWER = { email: 'viewer@example.com', temporary: 'Temp birch window 202' }

async function createVault(page: Page) {
  await page.goto('/')
  await page.getByTestId('setup-name').fill('Home')
  await page.getByTestId('setup-email').fill(ADMIN.email)
  await page.getByTestId('setup-password').fill(ADMIN.password)
  await page.getByTestId('setup-confirm').fill(ADMIN.password)
  await page.getByTestId('setup-submit').click()
  await expect(page.getByTestId('kpi-net')).toBeVisible({ timeout: 30_000 })
}

async function signIn(page: Page, email: string, password: string) {
  await page.getByTestId('login-email').fill(email)
  await page.getByTestId('login-password').fill(password)
  await page.getByTestId('login-submit').click()
}

async function lockVault(page: Page) {
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 30_000 })
  await page.getByTestId('lock-vault').click()
  await expect(page.getByTestId('login-email')).toBeVisible({ timeout: 30_000 })
}

async function addPerson(page: Page, person: { email: string; temporary: string; name?: string }, role: 'Manager' | 'Viewer') {
  await page.getByTestId('nav-users').click()
  await page.getByTestId('user-add').click()
  await expect(page.getByTestId('add-user-dialog')).toBeVisible()
  await page.getByTestId('advanced-temp-toggle').click()
  await page.getByTestId('user-email').fill(person.email)
  if (person.name) await page.getByTestId('user-name').fill(person.name)
  await page.getByTestId('user-password').fill(person.temporary)
  await page.getByTestId('user-role').selectOption(role)
  await page.getByTestId('user-save').click()
  await expect(page.getByTestId('add-user-dialog')).toHaveCount(0, { timeout: 30_000 })
  await expect(row(page, person.email)).toBeVisible()
}

function row(page: Page, email: string) {
  return page.getByTestId('person-row').filter({ hasText: email })
}

async function openPerson(page: Page, email: string) {
  await page.getByTestId('nav-users').click()
  await row(page, email).getByTestId('user-link').click()
  await expect(page.getByTestId('user-detail')).toBeVisible({ timeout: 30_000 })
}

test('an admin adds, edits, bulk-changes, suspends, reactivates and deletes people; a manager only reads', async ({ page }) => {
  test.setTimeout(240_000)
  const violations = await watchViolations(page)
  await createVault(page)
  await page.getByTestId('nav-groups').click()
  await page.getByTestId('group-name').fill('Field team')
  await page.getByTestId('group-save').click()
  await expect(page.getByTestId('group-row')).toHaveCount(2)

  await page.getByTestId('nav-users').click()
  await expect(page.getByTestId('users-overview')).toBeVisible()
  await expect(page.getByTestId('overview-members')).toContainText('1')

  // Create: one dialog, temporary password, must change at first sign-in.
  await addPerson(page, MANAGER, 'Manager')
  await expect(page.getByRole('status').filter({ hasText: 'must change the password' })).toBeVisible()
  await expect(row(page, MANAGER.email)).toContainText(MANAGER.name)
  await expect(row(page, MANAGER.email).getByTestId('user-status')).toHaveAttribute('data-status', 'ACTIVE')
  await addPerson(page, VIEWER, 'Viewer')
  await expect(page.getByTestId('overview-members')).toContainText('3')
  await expect(page.getByTestId('overview-mustChange')).toHaveAttribute('data-count', '2')

  // Edit: new email keeps the same password working.
  await openPerson(page, MANAGER.email)
  await expect(page.getByTestId('user-detail-must-change')).toHaveText('Yes')
  await page.getByTestId('user-action-edit').click()
  await page.getByTestId('edit-email').fill(MANAGER.renamed)
  await page.getByTestId('edit-save').click()
  await expect(page.getByTestId('user-edit-dialog')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId('user-detail-email')).toHaveText(MANAGER.renamed)
  await expect(page.getByTestId('user-detail-title')).toHaveText(MANAGER.name)

  // Bulk change: both start in Field team (first by name) and move to Home as Managers, each change audited.
  await page.getByTestId('user-back').click()
  await row(page, MANAGER.renamed).getByTestId('users-select').check()
  await row(page, VIEWER.email).getByTestId('users-select').check()
  await expect(page.getByTestId('users-bulk')).toContainText('2 selected')
  await page.getByTestId('bulk-role').selectOption('Manager')
  await page.getByTestId('bulk-group').selectOption({ label: 'Home' })
  await page.getByTestId('bulk-apply').click()
  await page.getByTestId('bulk-confirm').click()
  await expect(page.getByRole('status').filter({ hasText: 'People updated: 2.' })).toBeVisible({ timeout: 30_000 })
  await expect(row(page, VIEWER.email).locator('[data-column="role"]')).toHaveText('Manager')
  await expect(row(page, MANAGER.renamed).locator('[data-column="group"]')).toHaveText('Home')
  await page.getByTestId('nav-audit').click()
  await expect(page.getByRole('cell', { name: 'User updated', exact: true })).toHaveCount(3)
  await lockVault(page)

  // The manager signs in with the new email, records something, and sees their group read-only.
  await signIn(page, MANAGER.renamed, MANAGER.temporary)
  await expect(page.getByTestId('must-change-banner')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('account-current').fill(MANAGER.temporary)
  await page.getByTestId('account-new').fill(MANAGER.password)
  await page.getByTestId('account-confirm').fill(MANAGER.password)
  await page.getByTestId('account-save').click()
  await expect(page.getByTestId('must-change-banner')).toHaveCount(0, { timeout: 30_000 })
  await page.getByTestId('nav-transactions').click()
  await page.getByTestId('add-transaction').click()
  await page.getByTestId('tx-type').selectOption('EXPENSE')
  await page.getByTestId('tx-amount').fill('70')
  await page.getByTestId('tx-save').click()
  await expect(page.locator('[data-testid="tx-row"][data-amount="70"]')).toBeVisible()
  await page.getByTestId('nav-users').click()
  await expect(page.getByTestId('users-read-only')).toBeVisible()
  await expect(page.getByTestId('user-add')).toHaveCount(0)
  await expect(page.getByTestId('users-overview')).toHaveCount(0)
  await expect(page.getByTestId('users-select')).toHaveCount(0)
  await expect(page.getByTestId('user-issue-reset')).toHaveCount(0)
  await row(page, VIEWER.email).getByTestId('user-link').click()
  await expect(page.getByTestId('user-read-only')).toBeVisible()
  await expect(page.getByTestId('user-actions')).toHaveCount(0)
  await expect(page.getByTestId('user-activity')).toHaveCount(0)
  await expect(page.getByTestId('user-detail-last-sign-in')).toHaveCount(0)
  await lockVault(page)

  // Suspend: the person can no longer sign in; reactivating hands out a reset code.
  await signIn(page, ADMIN.email, ADMIN.password)
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 })
  await openPerson(page, VIEWER.email)
  await page.getByTestId('user-action-suspend').click()
  await page.getByTestId('user-suspend-dialog-confirm').click()
  await expect(page.getByTestId('user-detail')).toHaveAttribute('data-status', 'SUSPENDED', { timeout: 30_000 })
  await expect(page.getByTestId('user-suspended-note')).toBeVisible()
  await lockVault(page)
  await signIn(page, VIEWER.email, VIEWER.temporary)
  await expect(page.getByTestId('form-error')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('app-shell')).toHaveCount(0)
  await signIn(page, ADMIN.email, ADMIN.password)
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 })
  await openPerson(page, VIEWER.email)
  await page.getByTestId('user-action-reactivate').click()
  await page.getByTestId('user-reactivate-dialog-confirm').click()
  await expect(page.getByTestId('issued-code-panel')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('user-detail')).toHaveAttribute('data-status', 'ACTIVE')
  await page.getByTestId('code-done').click()

  // Delete with reassignment: the record moves to the admin, the person is gone, the audit log keeps their name.
  await openPerson(page, MANAGER.renamed)
  await expect(page.getByTestId('user-records')).toHaveAttribute('data-count', '1')
  await expect(page.getByTestId('user-activity-entry').first()).toBeVisible()
  await page.getByTestId('user-action-delete').click()
  await page.getByTestId('delete-reassign').check()
  await page.getByTestId('delete-reassign-to').selectOption({ label: ADMIN.email })
  await expect(page.getByTestId('delete-confirm')).toBeDisabled()
  await page.getByTestId('delete-confirm-email').fill('someone@example.com')
  await expect(page.getByTestId('delete-confirm')).toBeDisabled()
  await page.getByTestId('delete-confirm-email').fill(MANAGER.renamed)
  await page.getByTestId('delete-confirm').click()
  await expect(page.getByRole('status').filter({ hasText: 'Person deleted.' })).toBeVisible({ timeout: 30_000 })
  await expect(row(page, MANAGER.renamed)).toHaveCount(0)
  await openPerson(page, ADMIN.email)
  await expect(page.getByTestId('user-records')).toHaveAttribute('data-count', '1')
  await page.getByTestId('nav-transactions').click()
  await expect(page.locator('[data-testid="tx-row"][data-amount="70"]')).toBeVisible()
  await page.getByTestId('nav-audit').click()
  await expect(page.getByRole('cell', { name: 'Records moved to another person', exact: true })).toHaveCount(1)
  await expect(page.getByRole('cell', { name: 'Record added', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: 'Record added' }).filter({ hasText: MANAGER.renamed })).toHaveCount(1)

  expect(await violations()).toEqual([])
})

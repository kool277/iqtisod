import { expect, type Page } from '@playwright/test'

export type Invitee = { email: string; password: string; role: 'Admin' | 'Manager' | 'Viewer'; group?: string }

/** As an admin: invites `person` from the People page and returns the code. Every vault takes invite codes. */
export async function invite(page: Page, person: Invitee): Promise<string> {
  await page.getByTestId('nav-users').click()
  await page.getByTestId('user-add').click()
  await page.getByTestId('invite-email').fill(person.email)
  await page.getByTestId('invite-role').selectOption(person.role)
  if (person.group) await page.getByTestId('invite-group').selectOption({ label: person.group })
  await page.getByTestId('invite-create').click()
  const code = (await page.getByTestId('issued-code').textContent({ timeout: 60_000 }))!.trim()
  await page.getByTestId('code-done').click()
  return code
}

/** From the sign-in screen: redeems `code` with the person's own password, ending signed in as them. */
export async function join(page: Page, person: Invitee, code: string): Promise<void> {
  await page.getByTestId('join-link').click()
  await page.getByTestId('register-email').fill(person.email)
  await page.getByTestId('register-code').fill(code)
  await page.getByTestId('register-password').fill(person.password)
  await page.getByTestId('register-confirm').fill(person.password)
  await page.getByTestId('register-submit').click()
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60_000 })
}

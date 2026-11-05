import type { Page } from '@playwright/test';
import { MANAGER_DESK } from '../client/src/world/layout';
import { enterOffice, expect, startAt, test, type SavedView } from './helpers';

// Issue #114: the 🔌 Providers tab. Demo mode's checkProvider (server/demo.ts) is deterministic: a base URL
// containing "bad" is unreachable, a key containing "wrong" gets a 401, a model containing "missing" isn't listed.

const AT_DESK: SavedView = { floor: 0, x: MANAGER_DESK.x, z: MANAGER_DESK.z + MANAGER_DESK.d / 2 + 0.8, yaw: 0, pitch: -0.6 };

/** The first-run tour overlay otherwise intercepts clicks on the console (e2e/hudLayout.spec.ts's own helper). */
async function skipTour(page: Page) {
  await page.evaluate(() => fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tutorialStep: -1 }) }));
  await expect(page.locator('.tour')).toBeHidden();
}

async function openProviders(page: Page) {
  await startAt(page, AT_DESK);
  await page.goto('/?pocket=0'); // a narrow viewport would otherwise start pocket mode, which has no console
  await enterOffice(page, { loaded: true });
  await skipTour(page);
  await page.keyboard.press('e');
  await page.getByRole('tab', { name: /Providers/ }).click();
  await expect(page.getByRole('heading', { name: '🔌 Providers' })).toBeVisible();
}

test('the built-in coding agents are listed read-only and greyed out', async ({ page }) => {
  await openProviders(page);
  const builtIns = page.locator('.provider-row-builtin');
  await expect(builtIns).toHaveCount(3);
  await expect(builtIns.nth(0)).toContainText('Claude Code');
  await expect(builtIns.nth(1)).toContainText('Codex');
  await expect(builtIns.nth(2)).toContainText('OpenCode');
  for (let i = 0; i < 3; i++) {
    await expect(builtIns.nth(i).getByRole('button')).toHaveCount(0); // no Edit or Delete
  }
});

test('Save stays disabled until the endpoint, key and model are all valid', async ({ page }) => {
  await openProviders(page);
  await page.getByRole('button', { name: /Add provider/ }).click();
  const save = page.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();

  await page.getByLabel('API endpoint').fill('not a url');
  await page.getByLabel('API key').fill('a-key');
  await page.getByLabel('Model name').fill('a-model');
  await expect(save).toBeDisabled(); // the endpoint still isn't http(s)

  await page.getByLabel('API endpoint').fill('http://localhost:9999/v1');
  await expect(save).toBeEnabled();

  await page.getByLabel('API key').fill('');
  await expect(save).toBeDisabled(); // key required on create

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByLabel('API endpoint')).toHaveCount(0);
});

test('Check connection reports unreachable, rejected and not-listed outcomes', async ({ page }) => {
  await openProviders(page);
  await page.getByRole('button', { name: /Add provider/ }).click();
  const form = page.getByRole('form', { name: 'Add a provider' });
  const check = form.getByRole('button', { name: /Check connection/ });
  // Scoped to the form: a hidden terminal line can otherwise coincidentally match digits like "401".
  const result = form.locator('p').last();

  await page.getByLabel('API endpoint').fill('http://bad-host:9999/v1');
  await page.getByLabel('API key').fill('a-key');
  await page.getByLabel('Model name').fill('a-model');
  await check.click();
  await expect(result).toHaveText(/Not reachable/);

  await page.getByLabel('API endpoint').fill('http://localhost:9999/v1');
  await page.getByLabel('API key').fill('a-wrong-key');
  await check.click();
  await expect(result).toHaveText(/401/);

  await page.getByLabel('API key').fill('a-good-key');
  await page.getByLabel('Model name').fill('a-missing-model');
  await check.click();
  await expect(result).toHaveText(/isn't listed/);

  await page.getByLabel('Model name').fill('a-fine-model');
  await check.click();
  await expect(result).toHaveText('✅ Reachable, model listed.');

  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('add, edit (keeping the key), assign an agent, and delete a custom provider', async ({ page }) => {
  await openProviders(page);

  // Add: the key is never shown or prefilled, and never sits in the page after saving.
  await page.getByRole('button', { name: /Add provider/ }).click();
  await page.getByLabel('API endpoint').fill('http://localhost:9999/v1');
  await page.getByLabel('API key').fill('super-secret-key');
  await page.getByLabel('Model name').fill('demo-model');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('demo-model', { exact: false }).first()).toBeVisible(); // name defaults to the model name
  await expect(page.locator('body')).not.toContainText('super-secret-key');
  expect(await page.content()).not.toContain('super-secret-key');

  // Edit: the key field starts empty with its hint, and leaving it empty keeps the current key.
  await page.getByRole('button', { name: 'Edit' }).click();
  const keyField = page.getByLabel('API key');
  await expect(keyField).toHaveValue('');
  await expect(keyField).toHaveAttribute('placeholder', 'leave empty to keep the current key');
  await page.getByLabel('Name', { exact: true }).fill('My Test Provider');
  await page.getByLabel('Model name').fill('demo-model-2');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('My Test Provider')).toBeVisible();
  await expect(page.getByText(/🔑 key set/)).toBeVisible(); // the key survived the edit

  // Hire an agent (by name, through the API: the demo's own simulated hiring/let-go churn makes a row count
  // unreliable) and put them on the new provider: its model shows read-only on the Team tab.
  const { repos } = await (await page.request.get('/api/state')).json();
  const agentName = `E2EProv-${Date.now() % 100000}`; // hireAgent truncates names to 24 chars: stay well under it
  const agent = await (await page.request.post(`/api/repos/${encodeURIComponent(repos[0].id)}/agents`, { data: { name: agentName } })).json();
  await page.getByRole('tab', { name: /Team/ }).click();
  // NameInput is an <input>, whose value hasText can't see, so match on the attribute; this also skips
  // CareerCard.tsx's stats table, which lists every agent by name too but not in an input.
  const row = page.locator('tr').filter({ has: page.locator(`input[value="${agentName}"]`) });
  await expect(row).toHaveCount(1);
  await row.getByLabel('Coding agent').selectOption({ label: 'My Test Provider' });
  const modelField = row.getByLabel('Model');
  await expect(modelField).toHaveValue('demo-model-2');
  await expect(modelField).toHaveAttribute('readonly', '');

  // Delete is refused (409, with the server's message) while that agent still uses it. Checked through
  // page.request (like e2e/attachments.spec.ts's refused-upload test), which the shared `page` fixture doesn't
  // treat as a failed request, since the UI's own Delete button would otherwise always have to succeed.
  const { custom } = await (await page.request.get('/api/providers')).json();
  const providerId = custom.find((p: { name: string }) => p.name === 'My Test Provider').id;
  const refused = await page.request.delete(`/api/providers/${providerId}`);
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toMatch(/still use this provider/);

  // Move the agent off it, then delete succeeds.
  await page.getByRole('tab', { name: /Team/ }).click();
  await row.getByLabel('Coding agent').selectOption({ value: '' });
  await page.getByRole('tab', { name: /Providers/ }).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('My Test Provider')).toHaveCount(0);

  // Leave the shared demo office as this spec found it: let the hired agent go.
  await page.request.delete(`/api/agents/${agent.id}`);
});

test('editing one provider then another shows the second one, and clearing a limit on edit removes it', async ({ page }) => {
  await openProviders(page);

  const add = async (model: string) => {
    await page.getByRole('button', { name: /Add provider/ }).click();
    await page.getByLabel('API endpoint').fill('http://localhost:9999/v1');
    await page.getByLabel('API key').fill('a-key');
    await page.getByLabel('Model name').fill(model);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(model, { exact: false }).first()).toBeVisible();
  };
  await add('model-a');
  await add('model-b');

  // Edit A, then edit B without saving: the form must show B's own fields, not A's (or A's still-typed edits).
  await page.locator('.provider-row').filter({ hasText: 'model-a' }).getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Model name')).toHaveValue('model-a');
  await page.getByLabel('Model name').fill('model-a-EDITED');
  await page.locator('.provider-row').filter({ hasText: 'model-b' }).getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Model name')).toHaveValue('model-b');

  // Set a context window, save, then clear it on a second edit: it must actually be removed, not kept.
  await page.getByLabel('Context window').fill('4096');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('model-b', { exact: false }).first()).toBeVisible();
  let { custom } = await (await page.request.get('/api/providers')).json();
  let providerB = custom.find((p: { model: string }) => p.model === 'model-b');
  expect(providerB.contextLimit).toBe(4096);

  await page.locator('.provider-row').filter({ hasText: 'model-b' }).getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Context window')).toHaveValue('4096');
  await page.getByLabel('Context window').fill('');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('model-b', { exact: false }).first()).toBeVisible();
  ({ custom } = await (await page.request.get('/api/providers')).json());
  providerB = custom.find((p: { model: string }) => p.model === 'model-b');
  expect(providerB.contextLimit).toBeUndefined();

  // Leave the shared demo office as this spec found it: model-a was never actually renamed (edit was cancelled
  // by switching to B without saving), so both providers are still named after their models.
  for (const p of custom) if (p.model === 'model-a' || p.model === 'model-b') await page.request.delete(`/api/providers/${p.id}`);
});

test('at phone width, the Providers tab fits with no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProviders(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

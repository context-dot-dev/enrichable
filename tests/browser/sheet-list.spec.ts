import { test, expect, type Page } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { Row, Sheet } from '../../src/lib/types';
import { SHEET_DATA_VERSION } from '../../src/lib/workspace';
import { sheetsResponse } from '../support/sheet-list';

/** A workspace of `count` sheets behind /api/sheets. Returns every request the app made to it, as `path?query`. */
async function workspace(page: Page, baseURL: string, count: number) {
	await page.context().addCookies([{ name: 'enrichable.session', value: memberCookie('sheet-list'), url: baseURL, httpOnly: true, sameSite: 'Lax' }]);
	const kinds = ['Solar installers', 'Fintech leads', 'Coffee roasters'];
	const entries = Array.from({ length: count }, (_, index) => {
		const sheet: Sheet = { id: `sheet-${index}`, name: `${kinds[index % 3]} ${index}`, columns: [{ id: 'company', name: 'Company', type: 'source', width: 180, createdAt: 1 }], filters: [], sort: null, dataVersion: SHEET_DATA_VERSION, createdAt: index, updatedAt: index, revision: 1 };
		const rows: Row[] = [{ id: `row-${index}`, sheetId: sheet.id, order: 0, createdAt: 1, cells: { company: { v: `Company ${index}`, s: 'done', t: 1 } } }];
		return { sheet, rows };
	});
	const requests: string[] = [];
	await page.route('**/api/context/usage*', (route) => route.fulfill({ json: { credits: 25000, used: 0 } }));
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: false, context: false, typesafe: false, passwordRequired: false } }));
	await page.route('**/api/sheets**', async (route) => {
		const url = new URL(route.request().url());
		requests.push(`${url.pathname}${url.search}`);
		if (url.pathname === '/api/sheets') return route.fulfill({ json: sheetsResponse(url.href, entries) });
		const entry = entries.find(({ sheet }) => url.pathname === `/api/sheets/${sheet.id}`);
		return entry ? route.fulfill({ json: { ...entry, next: null } }) : route.fulfill({ status: 404, json: { error: 'Sheet not found in this workspace.' } });
	});
	await page.goto('/app');
	await page.getByRole('dialog').waitFor();
	await page.getByRole('button', { name: 'Close', exact: true }).click();
	return requests;
}

test.afterEach(async ({ page }) => { expect(await page.pageErrors()).toEqual([]); });

test('a large workspace is listed a page at a time and searched by the workspace, and rows load only for the sheet opened', async ({ page, baseURL }) => {
	const requests = await workspace(page, baseURL!, 60);
	const cards = page.getByRole('list', { name: 'Sheets' }).getByRole('listitem');
	const pages = page.getByRole('navigation', { name: 'Sheet pages' });
	await expect(page.getByText('60 sheets', { exact: true })).toBeVisible();
	await expect(cards).toHaveCount(24);
	await expect(cards.first()).toContainText('Coffee roasters 59');
	await expect(pages).toContainText('1–24 of 60');
	await expect(pages).toContainText('Page 1 of 3');
	await expect(pages.getByRole('button', { name: 'Previous' })).toBeDisabled();
	// Starting the app reads the sheet index and one page of the list: no sheet's rows.
	expect(requests.filter((request) => request.startsWith('/api/sheets/'))).toEqual([]);
	expect(new Set(requests)).toEqual(new Set(['/api/sheets?view=index', '/api/sheets?offset=0&limit=24']));

	// The sidebar lists the newest sheets and links to the rest.
	const sidebar = page.locator('#sidebar-sheets').getByRole('listitem');
	await expect(sidebar).toHaveCount(11);
	await expect(sidebar.first()).toHaveText('Coffee roasters 59');
	await expect(sidebar.last()).toHaveText('All 60 sheets');

	await pages.getByRole('button', { name: 'Next' }).click();
	await pages.getByRole('button', { name: 'Next' }).click();
	await expect(pages).toContainText('49–60 of 60');
	await expect(pages).toContainText('Page 3 of 3');
	await expect(cards).toHaveCount(12);
	await expect(pages.getByRole('button', { name: 'Next' })).toBeDisabled();
	expect(requests).toContain('/api/sheets?offset=48&limit=24');

	// Searching asks the workspace and starts on the first page.
	const search = page.getByRole('searchbox', { name: 'Search sheets' });
	await search.fill('SOLAR');
	await expect(page.getByText('20 of 60 sheets', { exact: true })).toBeVisible();
	await expect(cards).toHaveCount(20);
	await expect(cards.first()).toContainText('Solar installers 57');
	await expect(pages).toHaveCount(0);
	expect(requests).toContain('/api/sheets?offset=0&limit=24&search=SOLAR');
	await search.fill('nothing like this');
	await expect(page.getByRole('status').filter({ hasText: 'No sheets match “nothing like this”.' })).toBeVisible();
	await page.getByRole('button', { name: 'Clear search', exact: true }).last().click();
	await expect(cards).toHaveCount(24);
	await expect(search).toHaveValue('');

	// Opening an older sheet loads that sheet alone, shows it in the sidebar, and Back returns to the same search.
	await search.fill('fintech leads 1');
	await expect(page.getByText('5 of 60 sheets', { exact: true })).toBeVisible();
	const before = requests.length;
	await cards.filter({ hasText: 'Fintech leads 1' }).last().getByRole('link').click();
	await expect(page.getByRole('gridcell').first()).toContainText('Company 1');
	expect(requests.slice(before).filter((request) => request.startsWith('/api/sheets/'))).toEqual(['/api/sheets/sheet-1?offset=0']);
	await expect(page.locator('#sidebar-sheets').getByRole('link', { name: 'Fintech leads 1', exact: true })).toHaveAttribute('aria-current', 'page');
	await page.getByRole('link', { name: 'Back to sheets' }).click();
	await expect(search).toHaveValue('fintech leads 1');
	await expect(page.getByText('5 of 60 sheets', { exact: true })).toBeVisible();
	// The sidebar's Sheets link shows the whole workspace again.
	await page.locator('#app-navigation').getByRole('link', { name: 'Sheets', exact: true }).click();
	await expect(search).toHaveValue('');
	await expect(pages).toContainText('Page 1 of 3');
});

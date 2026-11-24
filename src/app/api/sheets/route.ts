import { apiRoute, readJson } from '@/lib/server/api-route';
import { WorkspaceStore } from '@/lib/server/workspace-store';
import { summarizeSheet, type SheetPage } from '@/lib/sheet-summary';
import { parseInput, sheetListSchema } from '@/lib/workspace';

/** `?view=index` answers every sheet's index entry; otherwise one page of summaries (`search`, `offset`, `limit`). */
export const GET = apiRoute('sheets.list', async ({ account, database, request }) => {
	const params = new URL(request.url).searchParams, store = new WorkspaceStore(database);
	if (params.get('view') === 'index') return { sheets: await store.index(account) };
	const { entries, total } = await store.list(account, parseInput(sheetListSchema, Object.fromEntries(params)));
	return { sheets: entries.map((entry) => summarizeSheet(entry.sheet, entry.rowCount, entry.previewRows)), total } satisfies SheetPage;
});
export const POST = apiRoute('sheets.create', async ({ account, database, request }) => new WorkspaceStore(database).create(account, await readJson(request)));

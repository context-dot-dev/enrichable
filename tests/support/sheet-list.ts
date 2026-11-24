import { indexEntry, PREVIEW_COLUMNS, PREVIEW_ROWS, summarizeSheet } from '../../src/lib/sheet-summary';
import type { Row, Sheet } from '../../src/lib/types';

/** GET /api/sheets as the app asks it: always with a query (`?view=index`, or a page's `?offset=`). */
export const SHEET_LIST_URL = /\/api\/sheets\?/;

/** What GET /api/sheets answers for a workspace holding `entries`: its sheet index, or the asked page of summaries. */
export function sheetsResponse(url: string, entries: Array<{ sheet: Sheet; rows?: Row[]; rowCount?: number }> = []) {
	const params = new URL(url).searchParams;
	if (params.get('view') === 'index') return { sheets: entries.map(({ sheet }) => indexEntry(sheet)) };
	const search = (params.get('search') ?? '').trim().toLowerCase(), offset = Number(params.get('offset') ?? 0), limit = Number(params.get('limit') ?? 24);
	const matching = entries.filter(({ sheet }) => sheet.name.toLowerCase().includes(search)).sort((a, b) => b.sheet.updatedAt - a.sheet.updatedAt);
	return {
		sheets: matching.slice(offset, offset + limit).map(({ sheet, rows = [], rowCount }) => summarizeSheet(sheet, rowCount ?? rows.length, rows.slice(0, PREVIEW_ROWS).map((row) => sheet.columns.slice(0, PREVIEW_COLUMNS).map((column) => row.cells[column.id]?.v ?? null)))),
		total: matching.length,
	};
}

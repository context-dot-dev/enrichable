import type { CellValue, Column, Sheet } from './types';

/** What the workspace knows of one sheet without its definition or rows. Every sheet's entry makes up the sheet index. */
export type SheetIndexEntry = { id: string; revision: number; name: string; createdAt: number };

/** One sheet as the Sheets list shows it: counts, and the first cells of its first rows. */
export type SheetSummary = {
	id: string; name: string; revision: number; createdAt: number; updatedAt: number;
	rowCount: number; columnCount: number; aiColumnCount: number;
	preview: { columns: Array<Pick<Column, 'id' | 'name' | 'type'>>; rows: CellValue[][] };
};

/** A page of the sheets matching a search, most recently edited first, and how many match in all. */
export type SheetPage = { sheets: SheetSummary[]; total: number };
export type SheetListQuery = { search?: string; offset?: number; limit?: number };

export const PREVIEW_COLUMNS = 3;
export const PREVIEW_ROWS = 3;

/** `previewRows` holds each of the first rows' values for the first `PREVIEW_COLUMNS` columns, in column order. */
export function summarizeSheet(sheet: Sheet, rowCount: number, previewRows: CellValue[][]): SheetSummary {
	const columns = sheet.columns.slice(0, PREVIEW_COLUMNS).map(({ id, name, type }) => ({ id, name, type }));
	return {
		id: sheet.id, name: sheet.name, revision: sheet.revision ?? 0, createdAt: sheet.createdAt, updatedAt: sheet.updatedAt,
		rowCount, columnCount: sheet.columns.length, aiColumnCount: sheet.columns.filter((column) => column.type === 'enriched').length,
		preview: { columns, rows: previewRows.slice(0, PREVIEW_ROWS).map((row) => columns.map((_, index) => row[index] ?? null)) },
	};
}

export const indexEntry = (sheet: Sheet): SheetIndexEntry => ({ id: sheet.id, revision: sheet.revision ?? 0, name: sheet.name, createdAt: sheet.createdAt });

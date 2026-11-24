/** What the Sheets list shows: the search box's text, the search the workspace was last asked for, and the page. */
export type SheetListView = { draft: string; search: string; page: number };

const INITIAL: SheetListView = { draft: '', search: '', page: 1 };
const SEARCH_DELAY_MS = 250;

/**
 * Kept outside the page so the list is where the user left it after opening a sheet and coming back. Typing searches
 * once it pauses, and a new search starts on the first page. The sidebar's Sheets link resets it.
 */
function createSheetListView() {
	let view = INITIAL;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const listeners = new Set<() => void>();
	const set = (next: SheetListView) => { view = next; for (const listener of listeners) listener(); };
	const commit = () => {
		clearTimeout(timer); timer = undefined;
		const search = view.draft.trim();
		if (search !== view.search) set({ ...view, search, page: 1 });
	};
	return {
		type(draft: string) {
			set({ ...view, draft });
			clearTimeout(timer);
			// Clearing the box shows the whole list at once.
			if (draft.trim()) timer = setTimeout(commit, SEARCH_DELAY_MS); else commit();
		},
		/** Search now, without waiting for typing to pause (Enter). */
		commit,
		setPage(page: number) { if (page !== view.page) set({ ...view, page: Math.max(1, page) }); },
		reset() { clearTimeout(timer); timer = undefined; if (view !== INITIAL) set(INITIAL); },
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		getSnapshot: () => view,
		getServerSnapshot: () => INITIAL,
	};
}

export const sheetListView = createSheetListView();

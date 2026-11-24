import type { SheetIndexEntry } from './sheet-summary';

/** The workspace's sheets as navigation needs them: newest first by creation, so editing a sheet never moves it. */
export type SheetDirectory = { ready: boolean; sheets: readonly SheetIndexEntry[] };

const EMPTY: SheetDirectory = { ready: false, sheets: [] };
const newestFirst = (a: SheetIndexEntry, b: SheetIndexEntry) => b.createdAt - a.createdAt || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);

/**
 * Every sheet in the workspace by ID, in memory: its name, creation time and latest known revision, never its
 * definition or rows. The workspace sends the whole index (live or polled, see db.ts) and this tab's own changes are
 * noted as they commit. It answers what the cache cannot once a workspace outgrows it: which sheets exist, what they
 * are called, how many there are, and whether a cached copy is behind.
 */
function createSheetIndex() {
	let entries = new Map<string, SheetIndexEntry>();
	let ready = false, version = 0, directory = EMPTY;
	const listeners = new Set<() => void>();
	/** `listed` is true when a sheet was added, removed, renamed or re-dated: only then does the directory change. */
	const changed = (listed: boolean) => {
		version++;
		if (listed) directory = { ready, sheets: [...entries.values()].sort(newestFirst) };
		for (const listener of listeners) listener();
	};
	const sameListing = (a: SheetIndexEntry | undefined, b: SheetIndexEntry) => a !== undefined && a.name === b.name && a.createdAt === b.createdAt;
	return {
		get: (sheetId: string) => entries.get(sheetId),
		get size() { return entries.size; },
		ids: () => [...entries.keys()],
		names: () => [...entries.values()].map((entry) => entry.name),
		/** The workspace's whole index, replacing what was known. */
		replace(next: readonly SheetIndexEntry[]) {
			const incoming = new Map(next.map((entry) => [entry.id, entry]));
			const listed = !ready || incoming.size !== entries.size || next.some((entry) => !sameListing(entries.get(entry.id), entry));
			const moved = listed || next.some((entry) => entries.get(entry.id)!.revision !== entry.revision);
			entries = incoming; ready = true;
			if (moved) changed(listed);
		},
		/** A sheet this tab created, loaded or saved. Never lowers a revision: only the workspace's index may. */
		note(entry: SheetIndexEntry) {
			const known = entries.get(entry.id);
			if (known && known.revision > entry.revision) return;
			if (known && known.revision === entry.revision && sameListing(known, entry)) return;
			entries.set(entry.id, entry);
			changed(!sameListing(known, entry));
		},
		remove(sheetId: string) { if (entries.delete(sheetId)) changed(true); },
		/** Another account's workspace is about to load. */
		reset() { entries = new Map(); ready = false; version++; directory = EMPTY; for (const listener of listeners) listener(); },
		subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		/** Changes whenever anything in the index does, a revision included. */
		getVersion: () => version,
		/** Changes only when a sheet is added, removed or renamed. */
		getDirectory: () => directory,
		getServerDirectory: () => EMPTY,
	};
}

export const sheetIndex = createSheetIndex();

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { applyLiveIndex, connectWorkspace, createSheet, createSheetFromRecords, db, deleteSheet, listSheets, loadSheet, onSheetRemoved, refreshWorkspace, sheetCurrent, updateSheet, watchSheet } from '../src/lib/db';
import { sheetIndex } from '../src/lib/sheet-index';
import { CloudError } from '../src/lib/sheet-remote';
import type { Row, Sheet } from '../src/lib/types';
import { MAX_SHEETS } from '../src/lib/workspace';
import { MemoryRemote } from './support/memory-remote';

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

const sheet = (id: string, name = id): Sheet => ({ id, name, columns: [{ id: 'value', name: 'Value', type: 'source', width: 180, createdAt: 0 }], filters: [], sort: null, createdAt: 0, updatedAt: 0 });
const row = (sheetId: string, value: string): Row => ({ id: `${sheetId}-${value}`, sheetId, order: 0, createdAt: 0, cells: { value: { v: value, s: 'done', t: 1 } } });
/** This tab hears about teammates' changes only through the sheet index. */
const announce = () => applyLiveIndex(remote.liveIndex());
const cached = async (sheetId: string) => (await db.sheets.get(sheetId))!;
const since = (seen: number) => remote.calls.slice(seen).map((call) => call.method === 'read' ? `read ${call.sheetId}` : call.method);
const value = async (sheetId: string) => (await db.rows.where('sheetId').equals(sheetId).first())?.cells.value.v;

test('following a workspace reads its sheet index: no sheet is downloaded until it is opened', async () => {
	for (let index = 0; index < 60; index++) await remote.create(sheet(`bulk${index}`, `Bulk ${index}`), [row(`bulk${index}`, 'Saved')]);
	const seen = remote.calls.length;
	await refreshWorkspace();
	assert.deepEqual(since(seen), ['index']);
	assert.deepEqual([await db.sheets.count(), await db.rows.count()], [0, 0]);
	assert.deepEqual([sheetIndex.size, sheetIndex.get('bulk59')], [60, { id: 'bulk59', revision: 1, name: 'Bulk 59', createdAt: 0 }]);
	// The Sheets list asks the workspace for one searched page.
	const page = await listSheets({ search: 'bulk 5', offset: 0, limit: 5 });
	assert.deepEqual([page.total, page.sheets.length, page.sheets[0].rowCount, page.sheets[0].preview.rows], [11, 5, 1, [['Saved']]]);
	assert.equal(await loadSheet('bulk7'), true);
	assert.deepEqual([await db.sheets.count(), await value('bulk7')], [1, 'Saved']);
});

test('list actions work on sheets a teammate created or edited after this tab loaded', async () => {
	await remote.create(sheet('created', 'Teammate sheet'), [row('created', 'Saved')]);
	await announce();
	assert.equal(await db.sheets.get('created'), undefined, 'known from the index, not downloaded');
	assert.equal(sheetIndex.get('created')?.name, 'Teammate sheet');

	// Rename loads the sheet first, so the change is made against a real revision and keeps the rows.
	await updateSheet('created', { name: 'Renamed' });
	assert.equal(remote.snapshot('created')!.sheet.name, 'Renamed');
	assert.equal(sheetCurrent(await cached('created')), true);
	assert.equal(await db.rows.where('sheetId').equals('created').count(), 1);
	assert.deepEqual([sheetIndex.get('created')?.name, sheetIndex.get('created')?.revision], ['Renamed', 2], 'this tab\'s own change is indexed without waiting to hear it back');

	// A teammate edits it again: this tab is behind, but the list shows (and deletes) the revision it saw.
	remote.edit('created', (grid) => { grid.sheet.name = 'Edited remotely'; grid.rows = [row('created', 'Newer')]; });
	await announce();
	assert.equal(sheetCurrent(await cached('created')), false);
	assert.equal(sheetIndex.get('created')?.name, 'Edited remotely');
	await deleteSheet('created');
	assert.equal(remote.snapshot('created'), undefined);
	assert.deepEqual([await db.sheets.get('created'), sheetIndex.get('created')], [undefined, undefined]);

	// The edit lands between the index event and the click: one fresh retry, no conflict for the user.
	await remote.create(sheet('busy'), []);
	await announce();
	remote.edit('busy', () => {});
	const removals = remote.calls.length;
	await deleteSheet('busy');
	assert.equal(remote.snapshot('busy'), undefined);
	assert.deepEqual(remote.calls.slice(removals), [{ method: 'remove', sheetId: 'busy', revision: 1 }, { method: 'remove', sheetId: 'busy', revision: 2 }]);

	// A sheet the index has not announced is deleted at the revision the list showed.
	await remote.create(sheet('unannounced'), []);
	await deleteSheet('unannounced', { name: 'unannounced', revision: 1 });
	assert.equal(remote.snapshot('unannounced'), undefined);

	// A sheet that keeps changing is not deleted out from under the people editing it.
	await remote.create(sheet('editing'), []);
	await announce();
	remote.before = (call) => { if (call.method === 'remove') remote.edit('editing', () => {}); };
	await assert.rejects(deleteSheet('editing'), /“editing” is being edited right now/);
	remote.before = undefined;
	assert.ok(remote.snapshot('editing') && sheetIndex.get('editing'));
	await deleteSheet('editing');
});

test('opening a sheet loads its rows, and a sheet deleted on the server leaves the cache', async () => {
	const removed: string[] = [];
	const stop = onSheetRemoved((sheetId) => removed.push(sheetId));
	try {
		await remote.create(sheet('opened'), [row('opened', 'Visible')]);
		await remote.create(sheet('listed'), []);
		await announce();
		assert.equal(await loadSheet('opened'), true);
		assert.equal(await value('opened'), 'Visible');
		remote.drop('opened');
		assert.equal(await loadSheet('opened'), false);
		assert.deepEqual([await db.sheets.get('opened'), sheetIndex.get('opened')], [undefined, undefined]);
		// Missing from the index is not proof; the workspace saying it has no such sheet is.
		await loadSheet('listed');
		remote.drop('listed');
		const seen = remote.calls.length;
		await announce();
		assert.deepEqual(since(seen), ['read listed']);
		assert.deepEqual([await db.sheets.get('listed'), sheetIndex.get('listed')], [undefined, undefined]);
		assert.deepEqual(removed, ['opened', 'listed']);
	} finally { stop(); }
});

test('an index older than a sheet this tab just created keeps the sheet', async () => {
	const stale = remote.liveIndex();
	const created = await createSheet('Just created');
	const seen = remote.calls.length;
	await applyLiveIndex(stale);
	assert.deepEqual(since(seen), [`read ${created.id}`]);
	assert.deepEqual([(await cached(created.id)).name, sheetIndex.get(created.id)?.name], ['Just created', 'Just created']);
});

test('polling reloads the sheet open in this tab; other cached sheets wait until they are opened', async () => {
	await remote.create(sheet('open'), [row('open', 'Old')]);
	await remote.create(sheet('closed'), [row('closed', 'Old')]);
	await loadSheet('open');
	await loadSheet('closed');
	const edit = (sheetId: string) => remote.edit(sheetId, (grid) => { grid.rows[0].cells.value.v = 'New'; });
	const unwatch = watchSheet('open');
	try {
		edit('open'); edit('closed');
		let seen = remote.calls.length;
		await refreshWorkspace();
		assert.deepEqual(since(seen), ['index', 'read open']);
		assert.deepEqual([await value('open'), await value('closed'), sheetCurrent(await cached('open')), sheetCurrent(await cached('closed'))], ['New', 'Old', true, false]);
		// Live, the open sheet follows its own subscription: the index alone reloads nothing.
		edit('open');
		seen = remote.calls.length;
		await announce();
		assert.deepEqual([since(seen), sheetCurrent(await cached('open'))], [[], false]);
	} finally { unwatch(); }
	assert.equal(await loadSheet('closed'), true);
	assert.deepEqual([await value('closed'), sheetCurrent(await cached('closed'))], ['New', true]);
});

test('names and the sheet quota are checked against the whole workspace, not only the sheets opened here', async () => {
	await remote.create(sheet('untitled', 'Untitled'), []);
	await announce();
	assert.equal((await createSheet()).name, 'Untitled 2');
	const creates = () => remote.calls.filter((call) => call.method === 'create').length;
	const made = creates();
	await applyLiveIndex([...remote.liveIndex(), ...Array.from({ length: MAX_SHEETS }, (_, index) => ({ id: `filler${index}`, revision: 1, name: `Filler ${index}`, created_at: 0 }))]);
	await assert.rejects(createSheet('One too many'), /up to 1.000 sheets/);
	assert.equal(creates(), made, 'a full workspace is refused before asking it');
	await announce();
	assert.equal((await createSheet('Room again')).name, 'Room again');
});

test('CSV import creates the sheet and its rows in one request; a stray value keeps a website column as text', async () => {
	const seen = remote.calls.length;
	const imported = await createSheetFromRecords('Leads', [{ Company: 'Acme', Domain: 'https://www.acme.example/' }, { Company: 'Orbit', Domain: 'orbit.example' }]);
	assert.deepEqual(remote.calls.slice(seen).map((call) => call.method), ['create']);
	assert.equal(remote.snapshot(imported.id)!.rows.length, 2);
	const domain = imported.columns.find((column) => column.name === 'Domain')!;
	assert.equal(domain.format, 'website');
	assert.deepEqual((await db.rows.where('sheetId').equals(imported.id).sortBy('order')).map((entry) => entry.cells[domain.id].v), ['acme.example', 'orbit.example']);

	const loose = await createSheetFromRecords('Loose', [{ Domain: 'n/a' }, { Domain: 'orbit.example' }]);
	assert.equal(loose.columns[0].format, 'text');
	assert.deepEqual((await db.rows.where('sheetId').equals(loose.id).toArray()).map((entry) => entry.cells[loose.columns[0].id].v).sort(), ['n/a', 'orbit.example']);

	remote.before = () => { throw new CloudError('Workspace temporarily unavailable.', 503); };
	const count = await db.sheets.count();
	await assert.rejects(createSheetFromRecords('Failed', [{ Company: 'Acme' }]), /temporarily unavailable/);
	remote.before = undefined;
	assert.equal(await db.sheets.count(), count, 'a failed import leaves no empty sheet behind');
});

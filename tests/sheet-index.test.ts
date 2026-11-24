import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sheetIndex } from '../src/lib/sheet-index';
import { sheetListView } from '../src/lib/sheet-list-view';

const entry = (id: string, revision = 1, name = id, createdAt = 0) => ({ id, revision, name, createdAt });

test('the directory lists sheets newest first and changes only when a sheet is added, removed or renamed', (t) => {
	sheetIndex.reset();
	let notified = 0;
	t.after(sheetIndex.subscribe(() => { notified++; }));
	assert.deepEqual(sheetIndex.getDirectory(), { ready: false, sheets: [] });
	sheetIndex.replace([entry('old', 1, 'Old', 1), entry('new', 1, 'New', 3), entry('middle', 1, 'Middle', 2)]);
	const listed = sheetIndex.getDirectory();
	assert.deepEqual([listed.ready, listed.sheets.map((sheet) => sheet.name), sheetIndex.size, notified], [true, ['New', 'Middle', 'Old'], 3, 1]);

	// A sheet that is only edited (every saved cell) leaves the sidebar's list as it is, yet the index has moved.
	const version = sheetIndex.getVersion();
	sheetIndex.replace([entry('old', 1, 'Old', 1), entry('new', 5, 'New', 3), entry('middle', 1, 'Middle', 2)]);
	assert.equal(sheetIndex.getDirectory(), listed);
	assert.deepEqual([sheetIndex.get('new')?.revision, sheetIndex.getVersion() > version, notified], [5, true, 2]);
	// The same index again tells nobody anything.
	sheetIndex.replace([entry('old', 1, 'Old', 1), entry('new', 5, 'New', 3), entry('middle', 1, 'Middle', 2)]);
	assert.equal(notified, 2);

	sheetIndex.replace([entry('new', 6, 'Renamed', 3), entry('middle', 1, 'Middle', 2)]);
	assert.deepEqual(sheetIndex.getDirectory().sheets.map((sheet) => sheet.name), ['Renamed', 'Middle']);
	assert.deepEqual([sheetIndex.get('old'), sheetIndex.names().sort(), sheetIndex.ids().sort()], [undefined, ['Middle', 'Renamed'], ['middle', 'new']]);
});

test('this tab\'s own saves are noted at once and never lower a revision; only the workspace\'s index may', () => {
	sheetIndex.reset();
	sheetIndex.replace([entry('sheet', 4, 'Sheet')]);
	const listed = sheetIndex.getDirectory();
	sheetIndex.note(entry('sheet', 5, 'Sheet'));
	assert.deepEqual([sheetIndex.get('sheet')?.revision, sheetIndex.getDirectory()], [5, listed]);
	// A copy read before a teammate's newer edit must not hide that the workspace has moved on.
	sheetIndex.note(entry('sheet', 3, 'Older name'));
	assert.deepEqual(sheetIndex.get('sheet'), entry('sheet', 5, 'Sheet'));
	sheetIndex.note(entry('created', 1, 'Created here', 9));
	assert.deepEqual(sheetIndex.getDirectory().sheets.map((sheet) => sheet.id), ['created', 'sheet']);
	// A sheet deleted and made again under the same ID starts over at revision 1.
	sheetIndex.replace([entry('sheet', 1, 'Sheet')]);
	assert.deepEqual([sheetIndex.get('sheet')?.revision, sheetIndex.size], [1, 1]);
	sheetIndex.remove('sheet');
	assert.deepEqual(sheetIndex.getDirectory(), { ready: true, sheets: [] });
});

test('the Sheets list searches once typing pauses, starts a new search on its first page, and resets', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	sheetListView.reset();
	sheetListView.setPage(3);
	sheetListView.type('sol');
	sheetListView.type(' solar ');
	assert.deepEqual(sheetListView.getSnapshot(), { draft: ' solar ', search: '', page: 3 }, 'nothing is asked while typing');
	t.mock.timers.tick(250);
	assert.deepEqual(sheetListView.getSnapshot(), { draft: ' solar ', search: 'solar', page: 1 });
	sheetListView.setPage(2);
	// Surrounding spaces are not a new search, so the page stays.
	sheetListView.type('solar');
	t.mock.timers.tick(250);
	assert.deepEqual(sheetListView.getSnapshot(), { draft: 'solar', search: 'solar', page: 2 });
	// Enter searches at once; clearing the box shows everything at once.
	sheetListView.type('wind');
	sheetListView.commit();
	assert.deepEqual(sheetListView.getSnapshot(), { draft: 'wind', search: 'wind', page: 1 });
	sheetListView.type('');
	assert.deepEqual(sheetListView.getSnapshot(), { draft: '', search: '', page: 1 });
	sheetListView.type('pending');
	sheetListView.reset();
	t.mock.timers.tick(250);
	assert.deepEqual(sheetListView.getSnapshot(), { draft: '', search: '', page: 1 }, 'a reset cancels a search that was about to start');
});

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Account } from '../../src/lib/auth-identity';
import { provideRouteContext } from '../../src/lib/server/api-route';
import { cloudSheets } from '../../src/lib/sheet-cloud';
import { refused, type SheetRemote } from '../../src/lib/sheet-remote';
import type { CellValue, Column, Row, Sheet } from '../../src/lib/types';
import * as collection from '../../src/app/api/sheets/route';
import * as item from '../../src/app/api/sheets/[id]/route';
import { testDatabase } from '../support/database';
import { MemoryRemote } from '../support/memory-remote';

/* The scenarios every SheetRemote adapter must pass. Running them against the in-memory adapter the browser-side tests
   use and against the browser's own adapter, served by the real /api/sheets handlers on PGlite, keeps the fake honest:
   same revisions, quotas, Admission and refusals, down to the statuses the routes send. */

const actor: Account = { issuer: 'https://remote-contract.invalid', organization: { id: 'org', name: 'Org' }, user: { id: 'alice', email: 'alice@example.com', email_verified: true }, partition: 'alice' };

type Handler = (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>;
const handlers: { sheets: Record<string, Handler>; sheet: Record<string, Handler> } = { sheets: { GET: (request) => collection.GET(request), POST: (request) => collection.POST(request) }, sheet: { GET: item.GET, PATCH: item.PATCH, DELETE: item.DELETE } };

/** cloudSheets as the browser runs it, its fetch answered by the route handlers with a signed-in account and a fresh database. */
async function routes(t: TestContext): Promise<SheetRemote> {
	const { database } = await testDatabase(t);
	t.after(provideRouteContext((run) => run({ account: actor, database })));
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(new URL(String(input), 'https://enrichable.test'), init);
		const id = /^\/api\/sheets\/([^/]+)$/.exec(new URL(request.url).pathname)?.[1];
		const handler = id === undefined ? handlers.sheets[request.method] : handlers.sheet[request.method];
		return handler ? handler(request, { params: Promise.resolve({ id: decodeURIComponent(id ?? '') }) }) : new Response(null, { status: 405 });
	});
	return cloudSheets;
}

const adapters: Array<[string, (t: TestContext) => Promise<SheetRemote>]> = [['in memory', async () => new MemoryRemote()], ['cloudSheets through /api/sheets on PGlite', routes]];
/** One scenario, run against each adapter. */
function contract(name: string, scenario: (remote: SheetRemote) => Promise<void>) {
	test(`SheetRemote: ${name}`, async (t) => {
		for (const [adapter, open] of adapters) await t.test(adapter, async (t) => scenario(await open(t)));
	});
}

const notes: Column = { id: 'notes', name: 'Notes', type: 'source', width: 180, createdAt: 0 };
const site: Column = { id: 'site', name: 'Website', type: 'source', width: 180, format: 'website', createdAt: 0 };
const sheet = (id: string, columns = [notes, site]): Sheet => ({ id, name: id, columns, filters: [], sort: null, createdAt: 0, updatedAt: 0 });
const row = (sheetId: string, id: string, order: number, cells: Record<string, CellValue> = {}): Row => ({ id, sheetId, order, createdAt: 0, cells: Object.fromEntries(Object.entries(cells).map(([column, v]) => [column, { v, s: 'done', t: 1 }])) });
const status = (code: number, message?: RegExp) => (error: unknown) => refused(error, code) && (!message || message.test(error.message));

contract('a created sheet is stored as parsed at revision 1, and reads return every row in order', async (remote) => {
	// A field the browser keeps for itself never reaches the workspace.
	const created = await remote.create({ ...sheet('s'), localOnly: true } as Sheet, [row('s', 'b', 1, { notes: 'second' }), row('s', 'a', 0, { notes: 'first' })]);
	assert.deepEqual(created, { ...sheet('s'), revision: 1 });
	assert.deepEqual(await remote.index(), [{ id: 's', revision: 1, name: 's', createdAt: 0 }]);
	const snapshot = await remote.read('s');
	assert.deepEqual(snapshot?.sheet, { ...sheet('s'), revision: 1 });
	assert.deepEqual(snapshot?.rows.map((entry) => entry.cells.notes.v), ['first', 'second']);
	assert.equal(await remote.read('missing'), null);
	await assert.rejects(remote.create(sheet('s'), []), status(409, /already exists/));
	await assert.rejects(remote.create(sheet('t'), [row('t', 'a', 0)]), status(409, /already used by another sheet/));
});

contract('a patch applies only against the current revision', async (remote) => {
	await remote.create(sheet('s'), [row('s', 'a', 0, { notes: 'old' }), row('s', 'b', 1)]);
	const saved = await remote.patch({ revision: 1, sheet: { ...sheet('s'), name: 'Renamed' }, rows: [row('s', 'a', 0, { notes: 'new' }), row('s', 'c', 2)], deleted: ['b'] });
	assert.equal(saved?.revision, 2);
	const snapshot = (await remote.read('s'))!;
	assert.deepEqual([snapshot.sheet.name, snapshot.sheet.revision, snapshot.sheet.updatedAt], ['Renamed', 2, saved!.updatedAt]);
	assert.deepEqual(snapshot.rows.map((entry) => [entry.id, entry.cells.notes?.v]), [['a', 'new'], ['c', undefined]]);
	assert.equal(await remote.patch({ revision: 1, sheet: sheet('s'), rows: [], deleted: [] }), null, 'a stale revision is a conflict');
	assert.equal((await remote.read('s'))!.sheet.name, 'Renamed');
	await assert.rejects(remote.patch({ revision: 1, sheet: sheet('gone'), rows: [], deleted: [] }), status(404));
});

contract('written values pass Admission, while values stored earlier never block other cells', async (remote) => {
	// Creating a sheet stores rows as given, as an import from an older client did.
	await remote.create(sheet('s'), [row('s', 'a', 0, { site: 'n/a', notes: 'hello' })]);
	assert.equal((await remote.patch({ revision: 1, sheet: sheet('s'), rows: [row('s', 'a', 0, { site: 'n/a', notes: 'edited' })], deleted: [] }))?.revision, 2);
	await assert.rejects(remote.patch({ revision: 2, sheet: sheet('s'), rows: [row('s', 'a', 0, { site: 'still n/a', notes: 'edited' })], deleted: [] }), status(422, /does not fit/));
	await assert.rejects(remote.patch({ revision: 2, sheet: sheet('s', [{ ...notes, format: 'currency' }, site]), rows: [], deleted: [] }), status(422, /“hello”|“edited”/), 'a column whose format changed has every cell checked');
	assert.equal((await remote.read('s'))!.sheet.revision, 2);
});

contract('a workspace holds a thousand sheets and a sheet a thousand rows', async (remote) => {
	await remote.create(sheet('full'), Array.from({ length: 1000 }, (_, order) => row('full', `r${order}`, order)));
	await assert.rejects(remote.patch({ revision: 1, sheet: sheet('full'), rows: [row('full', 'extra', 1000)], deleted: [] }), status(422, /1,000 rows/));
	for (let index = 1; index < 1000; index++) await remote.create(sheet(`s${index}`), []);
	await assert.rejects(remote.create(sheet('one-too-many'), []), status(422, /up to 1,000 sheets/));
	assert.equal((await remote.index()).length, 1000);
	// A full workspace is still read a page at a time.
	const page = await remote.list({ offset: 990, limit: 24 });
	assert.deepEqual([page.total, page.sheets.length], [1000, 10]);
	assert.deepEqual([(await remote.list({ search: 's99' })).total, (await remote.list({ search: 'full' })).sheets[0].rowCount], [11, 1000]);
});

contract('the sheet list is paged, most recently edited first, and searched by name; the index lists every sheet', async (remote) => {
	const named = (id: string, name: string, updatedAt: number, columns = [notes, site]): Sheet => ({ ...sheet(id, columns), name, createdAt: updatedAt, updatedAt });
	await remote.create(named('a', 'Solar installers', 1), [row('a', 'a1', 0, { notes: 'first', site: 'one.example' }), row('a', 'a2', 1, { notes: 'second' }), row('a', 'a3', 2), row('a', 'a4', 3)]);
	await remote.create(named('b', 'Fintech leads 100%', 3, [notes, site, { ...notes, id: 'extra', name: 'Extra' }, { ...notes, id: 'ai', name: 'Summary', type: 'enriched', op: { kind: 'template', template: '{{Notes}}' } }]), []);
	await remote.create(named('c', 'solar_farms', 2), []);
	assert.deepEqual((await remote.index()).sort((x, y) => x.id.localeCompare(y.id)), [{ id: 'a', revision: 1, name: 'Solar installers', createdAt: 1 }, { id: 'b', revision: 1, name: 'Fintech leads 100%', createdAt: 3 }, { id: 'c', revision: 1, name: 'solar_farms', createdAt: 2 }]);

	const all = await remote.list();
	assert.deepEqual([all.total, all.sheets.map((entry) => entry.id)], [3, ['b', 'c', 'a']]);
	// A summary carries counts and the first cells of the first rows, never the definition or every row.
	assert.deepEqual(all.sheets[2], { id: 'a', name: 'Solar installers', revision: 1, createdAt: 1, updatedAt: 1, rowCount: 4, columnCount: 2, aiColumnCount: 0, preview: { columns: [{ id: 'notes', name: 'Notes', type: 'source' }, { id: 'site', name: 'Website', type: 'source' }], rows: [['first', 'one.example'], ['second', null], [null, null]] } });
	assert.deepEqual([all.sheets[0].columnCount, all.sheets[0].aiColumnCount, all.sheets[0].preview.columns.length, all.sheets[0].preview.rows], [4, 1, 3, []]);

	assert.deepEqual((await remote.list({ offset: 1, limit: 1 })).sheets.map((entry) => entry.id), ['c']);
	assert.deepEqual(await remote.list({ offset: 3 }), { sheets: [], total: 3 }, 'a page past the end is empty and still counts the matches');
	const solar = await remote.list({ search: ' SOLAR ' });
	assert.deepEqual([solar.total, solar.sheets.map((entry) => entry.id)], [2, ['c', 'a']], 'case and surrounding spaces are ignored');
	assert.deepEqual((await remote.list({ search: 'solar', offset: 1 })).sheets.map((entry) => entry.id), ['a']);
	// Characters a pattern would treat specially match only themselves.
	assert.deepEqual((await remote.list({ search: '%' })).sheets.map((entry) => entry.id), ['b']);
	assert.deepEqual((await remote.list({ search: 'r_f' })).sheets.map((entry) => entry.id), ['c']);
	assert.deepEqual((await remote.list({ search: 'solar farms' })).total, 0);
	await assert.rejects(remote.list({ limit: 101 }), status(400));

	// An edit moves a sheet to the front, and its new name is the one searched and indexed.
	const saved = await remote.patch({ revision: 1, sheet: { ...named('a', 'Wind installers', 1) }, rows: [], deleted: [] });
	assert.deepEqual((await remote.list()).sheets.map((entry) => [entry.id, entry.revision]), [['a', 2], ['b', 1], ['c', 1]]);
	assert.deepEqual((await remote.list({ search: 'solar' })).sheets.map((entry) => entry.id), ['c']);
	assert.deepEqual((await remote.index()).find((entry) => entry.id === 'a'), { id: 'a', revision: saved!.revision, name: 'Wind installers', createdAt: 1 });
});

contract('a delete at a stale revision keeps the sheet and names its revision; a missing sheet is already deleted', async (remote) => {
	await remote.create(sheet('s'), []);
	await remote.patch({ revision: 1, sheet: { ...sheet('s'), name: 'Edited' }, rows: [], deleted: [] });
	assert.equal(await remote.remove('s', 1), 2);
	assert.equal((await remote.read('s'))?.sheet.revision, 2);
	assert.equal(await remote.remove('s', 2), null);
	assert.equal(await remote.read('s'), null);
	assert.equal(await remote.remove('s', 2), null);
	await assert.rejects(remote.remove('s', 0), status(400));
});

contract('malformed sheets and rows are refused before anything is stored', async (remote) => {
	await assert.rejects(remote.create(sheet('s', [notes, notes]), []), status(400, /Duplicate/));
	await assert.rejects(remote.create(sheet('s'), [row('other', 'a', 0)]), status(400, /belong to the sheet/));
	await assert.rejects(remote.create(sheet('s'), [{ ...row('s', 'a', 0), cells: { unknown: { v: 'x', s: 'done', t: 1 } } }]), status(400, /belong to the sheet/));
	await assert.rejects(remote.create({ ...sheet('s'), name: '' }, []), status(400));
	await remote.create(sheet('s'), []);
	await assert.rejects(remote.patch({ revision: 0, sheet: sheet('s'), rows: [], deleted: [] }), status(400));
	assert.deepEqual((await remote.index()).map((entry) => entry.revision), [1]);
});

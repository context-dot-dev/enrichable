import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { loadEnvConfig } from '@next/env';
import { WorkspaceStore } from '../../src/lib/server/workspace-store';
import { MAX_SHEETS } from '../../src/lib/workspace';
import { withDatabase, workspaceId, type Database } from '../../src/lib/server/database';
import type { Account } from '../../src/lib/auth-identity';
import type { Row, Sheet } from '../../src/lib/types';
import { testDatabase } from '../support/database';

test('Postgres workspaces share by verified organization, isolate tenants, enforce quotas and reject stale edits', { timeout: 90_000 }, async (t) => {
	const live = process.env.ENRICHABLE_LIVE_DB_TEST === 'true';
	loadEnvConfig(process.cwd());
	const prefix = `test-${randomUUID()}`;
	const actor = (user: string, org = 'one', issuer = 'https://workspace-tests.invalid'): Account => ({ issuer, user: { id: user, email: `${user}@example.com`, email_verified: true }, organization: { id: `${prefix}-${org}`, name: 'Test workspace' }, partition: user });
	const alice = actor('alice'), bob = actor('bob'), stranger = actor('eve', 'two'), otherIssuer = actor('alice', 'one', 'https://other-issuer.invalid');
	if (!live) return scenario((await testDatabase(t)).database);
	await withDatabase(async (database) => {
		try { await scenario(database); }
		finally {
			await database.transaction(async (sql) => {
				for (const account of [alice, stranger, otherIssuer]) {
					await sql.query('DELETE FROM enrichable.sheets WHERE workspace_id=$1', [workspaceId(account)]);
					await sql.query('DELETE FROM enrichable.workspaces WHERE id=$1', [workspaceId(account)]);
				}
			});
		}
	});

	async function scenario(database: Database) {
		const store = new WorkspaceStore(database);
		const sheet = (id: string): Sheet => ({ id, name: id, columns: [{ id: 'name', name: 'Name', type: 'source', width: 200, createdAt: 1 }], filters: [], sort: null, createdAt: 1, updatedAt: 1 });
		const row = (id: string, sheetId = 'shared'): Row => ({ id, sheetId, order: Number(id.replace(/\D/g, '')) || 0, cells: { name: { v: id, s: 'done', t: 1 } }, createdAt: 1 });
		await store.create(alice, { sheet: sheet('shared'), rows: [row('r0')] });
		assert.equal((await store.list(bob)).entries[0].sheet.id, 'shared');
		assert.deepEqual((await store.index(bob)).map((entry) => entry.id), ['shared']);
		for (const outsider of [stranger, otherIssuer]) assert.deepEqual([await store.list(outsider), await store.index(outsider)], [{ entries: [], total: 0 }, []]);
		await assert.rejects(store.get(stranger, 'shared'), /not found/);
		await assert.rejects(store.patch(stranger, 'shared', { revision: 1, sheet: sheet('shared'), rows: [], deleted: [] }), /not found/);
		await assert.rejects(store.remove(stranger, 'shared', 1), /changed or was deleted/);
		assert.equal((await store.patch(bob, 'shared', { revision: 1, sheet: { ...sheet('shared'), name: 'Bob edited' }, rows: [], deleted: [] })).revision, 2);
		await assert.rejects(store.patch(alice, 'shared', { revision: 1, sheet: sheet('shared'), rows: [row('r1')], deleted: [] }), /Another member/);
		if (live) console.log('Live database: tenant isolation and stale-edit checks passed.');
		// Fill the workspace to nine short of its quota in one statement; the quota itself is raced below.
		await database.transaction(async (sql) => {
			await sql.query(`INSERT INTO enrichable.sheets (workspace_id, id, data, created_by, updated_by)
				SELECT $1, 'seed' || n, jsonb_build_object('id', 'seed' || n, 'name', 'Seeded ' || n, 'columns', '[]'::jsonb, 'filters', '[]'::jsonb, 'sort', NULL, 'createdAt', n, 'updatedAt', n), 'seed', 'seed' FROM generate_series(1, $2::int) n`, [workspaceId(alice), MAX_SHEETS - 10]);
		}, { workspace: alice });
		const creations = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => store.create(alice, { sheet: sheet(`s${i}`), rows: [] })));
		assert.equal(creations.filter((entry) => entry.status === 'fulfilled').length, 9);
		assert.equal((await store.index(bob)).length, MAX_SHEETS);
		// A full workspace lists a page at a time and searches names in the database.
		const listed = await store.list(bob, { offset: 0, limit: 24 });
		assert.deepEqual([listed.total, listed.entries.length], [MAX_SHEETS, 24]);
		assert.deepEqual((await store.list(bob, { offset: MAX_SHEETS - 5, limit: 24 })).entries.length, 5);
		const seeded = await store.list(bob, { search: 'seeded 98', limit: 100 });
		assert.deepEqual([seeded.total, seeded.entries.map((entry) => entry.sheet.name)], [11, ['Seeded 989', 'Seeded 988', 'Seeded 987', 'Seeded 986', 'Seeded 985', 'Seeded 984', 'Seeded 983', 'Seeded 982', 'Seeded 981', 'Seeded 980', 'Seeded 98']]);
		if (live) console.log('Live database: concurrent sheet-quota checks passed.');
		await store.patch(alice, 'shared', { revision: 2, sheet: sheet('shared'), rows: Array.from({ length: 999 }, (_, i) => row(`r${i + 1}`)), deleted: [] });
		const shared = (await store.list(bob, { search: 'shared' })).entries[0];
		// The first rows' values for the first three column positions; the sheet has one column.
		assert.deepEqual([shared.rowCount, shared.previewRows], [1000, [['r0', null, null], ['r1', null, null], ['r2', null, null]]]);
		await assert.rejects(store.patch(bob, 'shared', { revision: 3, sheet: sheet('shared'), rows: [row('overflow')], deleted: [] }), /1,000/);
		assert.equal((await store.get(bob, 'shared')).sheet.revision, 3);
		const whole = await store.snapshot(bob, 'shared');
		assert.deepEqual([whole.sheet.revision, whole.rows.length, whole.rows[0].id, whole.rows[999].id], [3, 1000, 'r0', 'r999'], 'one read returns every row in order');
		await assert.rejects(store.snapshot(stranger, 'shared'), /not found/);
		if (live) console.log('Live database: row-quota rollback checks passed.');
		await assert.rejects(store.get(bob, 'shared', 100, 2), /Sheet changed/);
		const page = await store.get(bob, 'shared', 900, 3);
		assert.equal(page.rows.length, 100);
		await assert.rejects(store.patch(alice, 's0', { revision: 1, sheet: sheet('s0'), rows: [row('r0', 's0')], deleted: [] }), /another sheet/);
		await assert.rejects(store.patch(alice, 'shared', { revision: 3, sheet: sheet('shared'), rows: [row('foreign', 's0')], deleted: [] }), /Rows must belong/);
		await store.remove(bob, 'shared', 3);
		assert.equal((await store.list(alice)).total, MAX_SHEETS - 1);
		await store.create(bob, { sheet: sheet('replacement'), rows: [] });
		assert.equal((await store.list(alice)).total, MAX_SHEETS);
	}
});

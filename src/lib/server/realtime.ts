import 'server-only';
import { createRealtime, rawSql } from '@neon/realtime/server';
import type { Account } from '../auth-identity';
import type { Collaborator, LiveSheetEntry } from '../collaboration';
import type { IndexRow } from '../workspace-realtime';
import { configuredUrl } from './deployment';
import { workspaceId } from './database';
import { collaboratorIdentity } from './workspace-store';

/** The sheet index: one small row per sheet, so a workspace with a thousand sheets stays cheap to follow. Definitions,
    row counts and previews are read a page at a time through /api/sheets. */
export const WORKSPACE_LIVE_SQL = `SELECT id, revision, data->>'name' AS name, (data->>'createdAt')::double precision AS created_at FROM enrichable.sheets WHERE workspace_id = $1`;
export const SHEET_LIVE_SQL = `SELECT 'sheet'::text AS kind, id, revision, data FROM enrichable.sheets WHERE workspace_id = $1 AND id = $2
UNION ALL SELECT 'row'::text AS kind, id, 0::integer AS revision, data FROM enrichable.sheet_rows WHERE workspace_id = $1 AND sheet_id = $2`;
export const PRESENCE_LIVE_SQL = 'SELECT client_id, user_id, name, color, row_id, column_id, updated_at FROM enrichable.sheet_presence WHERE workspace_id = $1 AND sheet_id = $2';

export function realtimeConfig() {
	if (process.env.ENRICHABLE_REALTIME_ENABLED === 'false' || !process.env.NEON_REALTIME_URL || !process.env.NEON_REALTIME_SECRET || !process.env.DATABASE_URL) return null;
	const endpoint = configuredUrl('NEON_REALTIME_URL', process.env.NEON_REALTIME_URL);
	if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
	if (endpoint.protocol !== 'wss:' && !(process.env.NODE_ENV !== 'production' && endpoint.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname))) throw new Error('Invalid realtime endpoint.');
	return { url: endpoint.toString(), secret: process.env.NEON_REALTIME_SECRET, db: decodeURIComponent(configuredUrl('DATABASE_URL', process.env.DATABASE_URL).pathname.slice(1)) };
}

/** Never accept SQL, workspace IDs, credentials, or user identity from the browser. */
export async function sealWorkspaceQueries(account: Account, sheetId?: string) {
	const config = realtimeConfig();
	if (!config) return { enabled: false as const };
	const server = createRealtime({ secret: config.secret, db: config.db });
	const workspace = workspaceId(account);
	const index = await server.seal({ query: rawSql<IndexRow>(WORKSPACE_LIVE_SQL, [workspace]) });
	const sheet = sheetId ? await server.seal({ query: rawSql<LiveSheetEntry>(SHEET_LIVE_SQL, [workspace, sheetId]) }) : undefined;
	const presence = sheetId ? await server.seal({ query: rawSql<Collaborator>(PRESENCE_LIVE_SQL, [workspace, sheetId]) }) : undefined;
	return { enabled: true as const, url: config.url, userId: collaboratorIdentity(account).userId, index, sheet, presence };
}

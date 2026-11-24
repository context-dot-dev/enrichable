'use client';

import { createSheet, deleteSheet, duplicateSheet, emptyCell, id, listSheets, newColumn, updateSheet } from '@/lib/db';
import { verifyKeys } from '@/lib/api';
import { ENTITY_COLUMNS, type PopulateRequest } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, NameDialog } from '@/components/ui/dialog';
import { MenuButton } from '@/components/ui/menu';
import { useToast } from '@/components/ui/toast';
import { ArrowUpRight, ChevronLeft, ChevronRight, Copy, MoreHorizontal, Pencil, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { PageColumn } from './page-header';
import { useSettings } from './settings-context';
import { ImportCsvDialog } from '@/components/sheet/import-csv-dialog';
import { FindRowsComposer, type FindRowsDraft } from '@/components/sheet/populate-dialog';
import { FailureFix, type ConnectionIssue } from '@/components/sheet/halted-banner';
import { populateRunner } from '@/lib/populate-runner';
import { sheetNameFromPrompt } from '@/lib/populate-limit';
import { trackEvent } from '@/lib/analytics';
import { sheetIndex } from '@/lib/sheet-index';
import { sheetListView } from '@/lib/sheet-list-view';
import type { SheetPage, SheetSummary } from '@/lib/sheet-summary';
import { MAX_SHEETS, SHEET_PAGE_SIZE } from '@/lib/workspace';

// The sheet page still imports NameDialog from here.
export { NameDialog };

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const currentMinute = () => Math.floor(Date.now() / 60_000) * 60_000;
const subscribeClock = (onTick: () => void) => {
	const timer = setInterval(onTick, 15_000);
	return () => clearInterval(timer);
};
/** Client-only (no server snapshot), so relative times never mismatch hydration, and they stay current. */
const useNow = () => useSyncExternalStore(subscribeClock, currentMinute, () => null);

function relativeTime(timestamp: number, now: number): string {
	const minutes = Math.round((now - timestamp) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days} d ago`;
	return dateFormat.format(timestamp);
}

const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

/** While sheets keep changing (a run, a teammate typing), the list re-reads its page at most this often. */
const REFRESH_MS = 2_000;

type Listed = { key: string; page: SheetPage };

/**
 * One page of the workspace's sheets, searched and ordered by the workspace. It is read again whenever the sheet index
 * moves (a sheet created, renamed, edited or deleted here or by a teammate), the last page staying up meanwhile.
 */
function useSheetList(search: string, page: number) {
	const key = `${page}\n${search}`;
	const [listed, setListed] = useState<Listed | null>(null);
	const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let stopped = false, reading = false, again = false, waitingForTab = false, last = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const read = async () => {
			if (reading) { again = true; return; }
			reading = true; last = Date.now();
			try {
				const result = await listSheets({ search, offset: (page - 1) * SHEET_PAGE_SIZE, limit: SHEET_PAGE_SIZE });
				if (!stopped) { setListed({ key, page: result }); setFailure(null); }
			} catch (error) {
				if (!stopped) setFailure({ key, message: message(error, 'Could not load your sheets.') });
			} finally {
				reading = false;
				if (again) { again = false; schedule(); }
			}
		};
		function schedule() {
			if (stopped || timer !== undefined) return;
			timer = setTimeout(() => {
				timer = undefined;
				if (document.hidden) waitingForTab = true; else void read();
			}, Math.max(0, last + REFRESH_MS - Date.now()));
		}
		const onVisible = () => { if (!document.hidden && waitingForTab) { waitingForTab = false; schedule(); } };
		void read();
		const unsubscribe = sheetIndex.subscribe(schedule);
		document.addEventListener('visibilitychange', onVisible);
		return () => { stopped = true; clearTimeout(timer); unsubscribe(); document.removeEventListener('visibilitychange', onVisible); };
	}, [key, search, page, attempt]);
	return {
		/** The last page read, which may still be the previous search or page while `pending`. */
		listed: listed?.page,
		pending: listed?.key !== key,
		error: failure?.key === key ? failure.message : null,
		reload: () => setAttempt((value) => value + 1),
	};
}

export function SheetsPage() {
	const { selfHosted, ready, hasKeys, openKeys } = useSettings();
	const router = useRouter();
	const { toast } = useToast();
	const now = useNow();
	const directory = useSyncExternalStore(sheetIndex.subscribe, sheetIndex.getDirectory, sheetIndex.getServerDirectory);
	const view = useSyncExternalStore(sheetListView.subscribe, sheetListView.getSnapshot, sheetListView.getServerSnapshot);
	const { listed, pending, error, reload } = useSheetList(view.search, view.page);
	const [dialog, setDialog] = useState<null | 'new' | 'import'>(null);
	const [renaming, setRenaming] = useState<SheetSummary | null>(null);
	const [deleting, setDeleting] = useState<SheetSummary | null>(null);
	const top = useRef<HTMLElement>(null);
	const count = directory.sheets.length;
	const full = count >= MAX_SHEETS;
	const pages = listed ? Math.max(1, Math.ceil(listed.total / SHEET_PAGE_SIZE)) : 1;
	// Deleting the last sheets of the last page leaves it empty: show the page that is now last.
	useEffect(() => { if (listed && !pending && view.page > pages) sheetListView.setPage(pages); }, [listed, pending, view.page, pages]);
	const goToPage = (page: number) => { sheetListView.setPage(page); top.current?.scrollIntoView({ block: 'start' }); };

	/** One empty row to type into, created with the sheet. */
	async function createBlank() {
		try {
			const columns = [newColumn({ name: 'Name', type: 'source' }), newColumn({ name: 'Website', type: 'source', format: 'url' })];
			const sheetId = id();
			const sheet = await createSheet(undefined, columns, { id: sheetId, rows: [{ id: id(), sheetId, order: 0, createdAt: Date.now(), cells: Object.fromEntries(columns.map((column) => [column.id, emptyCell()])) }] });
			trackEvent('sheet_created', { source: 'blank' });
			router.push(`/app/sheets/${sheet.id}`);
		} catch (error) { toast(message(error, 'Could not create a sheet.'), 'error'); }
	}

	/** The sheet exists only once the user asks for rows. Discovery keeps streaming into it after navigation. */
	async function findRows(request: PopulateRequest) {
		const taken = new Set(sheetIndex.names().map((name) => name.toLowerCase()));
		const base = sheetNameFromPrompt(request.query) || { companies: 'Companies', people: 'People', websites: 'Websites' }[request.entity];
		let name = base;
		for (let suffix = 2; taken.has(name.toLowerCase()); suffix++) name = `${base} ${suffix}`;
		const columns = ENTITY_COLUMNS[request.entity].map((column) => newColumn({ name: column.name, type: 'source', width: column.width, format: column.format }));
		const sheet = await createSheet(name, columns, { populate: request });
		trackEvent('sheet_created', { source: request.entity });
		trackEvent('rows_requested', { kind: request.entity });
		void populateRunner.start(sheet, request, { handoff: true });
		router.push(`/app/sheets/${sheet.id}?find=1&entity=${request.entity}`);
	}

	// Connections are still loading right after the page appears: only a workspace known to lack keys is sent to setup.
	const starts = { onFind: findRows, needsKeys: ready && !hasKeys, onNeedKeys: openKeys, onImport: () => setDialog('import'), onBlank: () => { setDialog(null); void createBlank(); } };
	const first = listed ? (view.page - 1) * SHEET_PAGE_SIZE + 1 : 0;

	return (
		<PageColumn>
			<header ref={top} className="flex scroll-mt-10 flex-col gap-2">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
					<div className="flex min-w-0 items-baseline gap-3">
						<h1 className="text-h4 text-fg">Sheets</h1>
						{directory.ready && <SheetCount count={count} matching={view.search && listed && !pending ? listed.total : undefined} />}
					</div>
					{!!count && (
						<div className="flex min-w-0 flex-1 items-center justify-end gap-2 max-sm:basis-full">
							<SearchBox value={view.draft} searching={pending && !!view.search} />
							<Button variant="brand" size="sm" disabled={full} onClick={() => setDialog('new')} className="max-sm:min-h-11"><Plus strokeWidth={1.75} /> New sheet</Button>
						</div>
					)}
				</div>
				{full && <p className="text-body-sm text-fg-muted">Your workspace holds up to {MAX_SHEETS.toLocaleString()} sheets. Delete one to make room for another.</p>}
			</header>
			{!directory.ready || (count > 0 && !listed && !error) ? (
				<div className="grid gap-5 sm:grid-cols-2">
					{[0, 1, 2].map((index) => <div key={index} className="skeleton h-64 rounded-xl" />)}
				</div>
			) : count === 0 ? (
				<section aria-labelledby="sheets-empty-title" className="flex flex-col items-center gap-7 pt-6 pb-10 sm:pt-14">
					<div className="flex max-w-lg flex-col items-center gap-2.5 text-center">
						<span aria-hidden className="mb-1 grid size-11 place-items-center rounded-xl bg-blue-10 text-brand"><Sparkles className="size-5" strokeWidth={1.5} /></span>
						<h2 id="sheets-empty-title" className="text-h3 tracking-[-0.02em] text-fg">Start with the rows you want</h2>
						<p className="text-body text-fg-muted">Describe a list and an agent finds it on the web, row by row. Then add AI columns that answer questions about each row.</p>
					</div>
					<div className="w-full max-w-2xl"><NewSheet {...starts} /></div>
				</section>
			) : (
				<>
					{error && (
						<p role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-fg">
							<span>{error}</span>
							<Button variant="link" onClick={reload}>Retry</Button>
						</p>
					)}
					{listed && listed.sheets.length === 0 && !pending && view.search && (
						<div role="status" className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line px-6 py-14 text-center">
							<p className="text-body text-fg">No sheets match “{view.search}”.</p>
							<Button size="sm" onClick={() => sheetListView.reset()}>Clear search</Button>
						</div>
					)}
					{listed && listed.sheets.length > 0 && (
						<ul aria-label="Sheets" aria-busy={pending || undefined} className={clsx('grid grid-cols-1 gap-5 transition-opacity duration-150 sm:grid-cols-2', pending && 'opacity-60')}>
							{listed.sheets.map((sheet) => (
								<li key={sheet.id} className="group relative min-w-0 rounded-xl border border-line bg-surface shadow-[0_2px_3px_-2px_rgb(0_0_0/0.06)] transition-[border-color,box-shadow] duration-200 hover:border-line-strong hover:shadow-[0_8px_24px_-12px_rgb(0_0_0/0.15)] focus-within:border-line-strong">
									<a href={`/app/sheets/${sheet.id}`} onClick={(event) => { event.preventDefault(); router.push(`/app/sheets/${sheet.id}`); }} className="flex h-full w-full min-w-0 flex-col rounded-xl p-5 pb-4">
										<span className="mb-5 flex flex-col gap-1 pr-11 sm:pr-8">
											<span className="truncate text-[19px] leading-7 font-medium tracking-[-0.035em] text-neutral-90">{sheet.name}</span>
											<span className="min-h-4 text-[11px] text-fg-subtle">{now !== null && `Edited ${relativeTime(sheet.updatedAt, now)}`}</span>
										</span>
										<SheetPreview sheet={sheet} />
										<span className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-2 text-[11px] leading-4 text-fg-subtle tabular-nums">
											<span>{sheet.rowCount.toLocaleString()} rows<span aria-hidden="true" className="mx-2 text-neutral-20">/</span>{sheet.columnCount} columns</span>
											<span className="flex items-center gap-3">
												{sheet.aiColumnCount > 0 && <span className="inline-flex items-center gap-1 text-fg-muted"><Sparkles aria-hidden="true" className="size-3 text-brand" strokeWidth={1.5} />{sheet.aiColumnCount} AI {sheet.aiColumnCount === 1 ? 'column' : 'columns'}</span>}
												<ArrowUpRight aria-hidden="true" className="size-3.5 text-neutral-30 transition-colors group-hover:text-fg group-focus-within:text-fg" strokeWidth={1.5} />
											</span>
										</span>
									</a>
									<div className="absolute top-3 right-3 sm:top-5 sm:right-4">
										<MenuButton
											align="right"
											label={`Actions for ${sheet.name}`}
											className="grid size-11 place-items-center rounded-md text-fg-subtle sm:size-7 transition-colors hover:bg-tint/[0.05] hover:text-fg"
											items={[
												{ label: 'Rename', icon: <Pencil />, onSelect: () => setRenaming(sheet) },
												{ label: 'Duplicate', icon: <Copy />, disabled: full, onSelect: () => void duplicateSheet(sheet.id).then(reload, (error) => toast(message(error, 'Could not duplicate this sheet.'), 'error')) },
												{ separator: true, label: '' },
												{ label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => setDeleting(sheet) },
											]}
										>
											<MoreHorizontal className="size-4" strokeWidth={1.75} />
										</MenuButton>
									</div>
								</li>
							))}
						</ul>
					)}
					{listed && pages > 1 && (
						<nav aria-label="Sheet pages" className="flex flex-wrap items-center justify-between gap-3 text-body-sm text-fg-muted tabular-nums">
							<span>{first.toLocaleString()}–{(first + listed.sheets.length - 1).toLocaleString()} of {listed.total.toLocaleString()}</span>
							<span className="flex items-center gap-2">
								<Button size="sm" disabled={view.page <= 1} onClick={() => goToPage(view.page - 1)}><ChevronLeft strokeWidth={1.75} /> Previous</Button>
								<span aria-current="page" className="px-1">Page {view.page.toLocaleString()} of {pages.toLocaleString()}</span>
								<Button size="sm" disabled={view.page >= pages} onClick={() => goToPage(view.page + 1)}>Next <ChevronRight strokeWidth={1.75} /></Button>
							</span>
						</nav>
					)}
				</>
			)}
			{dialog === 'new' && (
				<Dialog unframed title="New sheet" onClose={() => setDialog(null)} size="lg">
					<NewSheet {...starts} autoFocus onClose={() => setDialog(null)} />
				</Dialog>
			)}
			{dialog === 'import' && <ImportCsvDialog onClose={() => setDialog(null)} onImported={(sheetId) => router.push(`/app/sheets/${sheetId}`)} />}
			{renaming && <NameDialog title="Rename sheet" initial={renaming.name} confirmLabel="Rename" onClose={() => setRenaming(null)} onSubmit={async (name) => { await updateSheet(renaming.id, { name }); reload(); }} />}
			{deleting && (
				<ConfirmDialog
					title={`Delete “${deleting.name}”?`}
					description={selfHosted ? 'This removes the sheet and all its rows. Export it first if you want a copy.' : 'This removes the sheet and all its rows for everyone in your workspace. Export it first if you want a copy.'}
					confirmLabel="Delete sheet"
					danger
					onClose={() => setDeleting(null)}
					onConfirm={async () => {
						await deleteSheet(deleting.id, deleting);
						reload();
						toast(`Deleted “${deleting.name}”`);
					}}
				/>
			)}
		</PageColumn>
	);
}

/** How many sheets the workspace holds, or how many of them match the search. The limit joins the count only once the
    workspace is close to it. */
function SheetCount({ count, matching }: { count: number; matching?: number }) {
	const sheets = `${count.toLocaleString()} ${count === 1 ? 'sheet' : 'sheets'}`;
	const className = clsx('text-body-sm tabular-nums', count >= MAX_SHEETS ? 'text-warning' : 'text-fg-subtle');
	if (matching !== undefined) return <span className={className}>{matching.toLocaleString()} of {sheets}</span>;
	if (count < MAX_SHEETS * 0.9) return <span className={className}>{sheets}</span>;
	return <span className={className}><span aria-hidden>{count.toLocaleString()} / {MAX_SHEETS.toLocaleString()} sheets</span><span className="sr-only">{count.toLocaleString()} of {MAX_SHEETS.toLocaleString()} sheets used</span></span>;
}

/** Searches sheet names in the workspace as typing pauses, or at once on Enter. */
function SearchBox({ value, searching }: { value: string; searching: boolean }) {
	return (
		<div role="search" className="relative min-w-0 flex-1 sm:max-w-64">
			<Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-subtle" strokeWidth={1.75} />
			<input
				type="search" value={value} aria-label="Search sheets" placeholder="Search sheets" autoComplete="off" spellCheck={false} aria-busy={searching || undefined}
				onChange={(event) => sheetListView.type(event.target.value)}
				onKeyDown={(event) => { if (event.key === 'Enter') sheetListView.commit(); else if (event.key === 'Escape' && value) { event.stopPropagation(); sheetListView.type(''); } }}
				className="h-8 w-full min-w-0 rounded-lg border border-line bg-surface pr-8 pl-8 text-body-sm text-fg outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-fg-subtle hover:border-line-strong focus:border-brand focus:shadow-[0_0_0_3px_rgb(37_99_235/0.12)] max-md:min-h-11 [&::-webkit-search-cancel-button]:appearance-none"
			/>
			{value && (
				<button type="button" aria-label="Clear search" onClick={() => sheetListView.type('')} className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-tint/[0.05] hover:text-fg max-md:size-9">
					<X className="size-3.5" strokeWidth={1.75} />
				</button>
			)}
		</div>
	);
}

/** A rejected Context.dev or OpenAI key, or used-up credit, found before a sheet exists for the search. A check that can't run never blocks. */
async function requiredKeyIssue(): Promise<{ error: string; issue: ConnectionIssue } | null> {
	try {
		const { context, openai } = await verifyKeys({ only: ['context', 'openai'] });
		if (!context.ok && context.issue) return { error: context.message ?? 'Context.dev rejected the API key.', issue: { reason: context.issue === 'key' ? 'credential_invalid' : 'credits_exhausted', provider: 'context' } };
		if (!openai.ok && (openai.issue === 'key' || openai.issue === 'billing')) return { error: openai.message ?? 'OpenAI rejected the API key.', issue: { reason: openai.issue === 'key' ? 'credential_invalid' : 'credits_exhausted', provider: 'openai' } };
	} catch { /* The search reports the same problem with its fix. */ }
	return null;
}

/** Find rows into a new sheet, or start from a CSV or a blank sheet. */
function NewSheet({ onFind, needsKeys, onNeedKeys, onImport, onBlank, onClose, autoFocus }: { onFind: (request: PopulateRequest) => Promise<void>; needsKeys: boolean; onNeedKeys: () => void; onImport: () => void; onBlank: () => void; onClose?: () => void; autoFocus?: boolean }) {
	const [draft, setDraft] = useState<FindRowsDraft>({ entity: 'companies', query: '', countries: [] });
	const [state, setState] = useState<{ status: 'idle' | 'creating' } | { status: 'failed'; error: string; issue?: ConnectionIssue }>({ status: 'idle' });
	// One sheet per submit, even if Cmd+Enter and a click land before the busy state renders.
	const inFlight = useRef(false);
	async function submit(request: PopulateRequest) {
		if (inFlight.current) return;
		if (needsKeys) { onNeedKeys(); return; }
		inFlight.current = true;
		setState({ status: 'creating' });
		try {
			const problem = await requiredKeyIssue();
			if (problem) { setState({ status: 'failed', ...problem }); inFlight.current = false; return; }
			await onFind(request);
		} catch (error) { setState({ status: 'failed', error: message(error, 'Could not create the sheet. Try again.') }); inFlight.current = false; }
	}
	return (
		<FindRowsComposer draft={draft} onDraftChange={(next) => { setDraft(next); if (state.status === 'failed') setState({ status: 'idle' }); }} onSubmit={(request) => void submit(request)} busy={state.status === 'creating'} error={state.status === 'failed' ? state.error : null} errorAction={state.status === 'failed' && state.issue && <FailureFix issue={state.issue} />} onClose={onClose} autoFocus={autoFocus}>
			<p className="populate-shelf">
				<span>or</span>
				<button type="button" onClick={onImport}>Import CSV</button>
				<span aria-hidden>·</span>
				<button type="button" onClick={onBlank}>Blank sheet</button>
			</p>
		</FindRowsComposer>
	);
}

function SheetPreview({ sheet }: { sheet: SheetSummary }) {
	const { columns, rows } = sheet.preview;
	return (
		<span aria-hidden="true" className="relative block h-[116px] w-full min-w-0 overflow-hidden rounded-md border border-line bg-canvas [mask-image:linear-gradient(to_bottom,black_65%,transparent)]">
			<span className="grid h-8 border-b border-line bg-neutral-5" style={{ gridTemplateColumns: `24px repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))` }}>
				<span className="border-r border-line-subtle" />
				{columns.map((column) => <span key={column.id} className="flex min-w-0 items-center gap-1.5 border-r border-line-subtle px-2 text-[10px] font-medium text-fg-muted last:border-r-0">{column.type === 'enriched' && <Sparkles className="size-2.5 shrink-0 text-brand" />}<span className="truncate">{column.name}</span></span>)}
			</span>
			{[0, 1, 2].map((index) => (
				<span key={index} className="grid h-7 border-b border-line-subtle bg-surface" style={{ gridTemplateColumns: `24px repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))` }}>
					<span className="flex items-center justify-center border-r border-line-subtle bg-neutral-5/50 font-mono text-[9px] text-neutral-30">{index + 1}</span>
					{columns.map((column, position) => {
						const value = rows[index]?.[position];
						const text = value === null || value === undefined ? '' : Array.isArray(value) ? value.join(', ') : String(value);
						return <span key={column.id} className="truncate border-r border-line-subtle px-2 py-1.5 text-[10px] text-fg-subtle last:border-r-0">{text}</span>;
					})}
				</span>
			))}
			{sheet.rowCount === 0 && <span className="absolute inset-x-6 top-12 text-center text-[10px] text-fg-subtle">No rows yet</span>}
		</span>
	);
}

/*
 * Approval mode: a task with "Ask before changing existing notes" does not
 * change a note that already exists. Each such change (adding its result to a
 * note, replacing its result note, or an edit the AI proposes) waits in a list
 * until the user approves or rejects it. Pure helpers live here; applying a
 * change is in main.ts.
 */

export type PendingKind = 'append' | 'replace' | 'edit';

export interface PendingChange {
	id: string;
	jobId: string;
	taskNumber: number;
	taskTitle: string;
	createdAt: string;
	kind: PendingKind;
	/** Vault path of the note to change. */
	path: string;
	/** The block to add ("append") or the note's complete new content. */
	content: string;
	/** "append": the heading to add under. */
	heading?: string;
	/** "append": the note is a daily note (created from the daily note template if missing). */
	dailyNote?: boolean;
}

export const MAX_PENDING = 100;

export const PENDING_KIND_LABELS: Record<PendingKind, string> = {
	append: 'Add the result to this note',
	replace: 'Replace the result note',
	edit: 'Edit proposed by the AI',
};

/** What the AI is told when a task asks before changing existing notes. */
export const APPROVAL_INSTRUCTION = [
	'Do not edit, rename or delete existing notes yourself; the user approves every change to an existing note.',
	'To change a note, put its complete new content in a block like this, one block per note:',
	'<ai-scheduler-edit path="Folder/Note.md">',
	'the complete new content of the note',
	'</ai-scheduler-edit>',
	'Everything outside these blocks is saved as your result as usual.',
].join('\n');

const EDIT_PATTERN = /<ai-scheduler-edit\s+path\s*=\s*"([^"]+)"\s*>\n?([\s\S]*?)\n?<\/ai-scheduler-edit>/gi;

/** Splits a reply into the AI's proposed edits and the rest of the reply. */
export function extractEdits(reply: string): { edits: Array<{ path: string; content: string }>; rest: string } {
	const edits: Array<{ path: string; content: string }> = [];
	const rest = String(reply || '').replace(new RegExp(EDIT_PATTERN.source, 'gi'), (_match: string, path: string, content: string) => {
		edits.push({ path: path.trim(), content });
		return '';
	}).replace(/\n{3,}/g, '\n\n').trim();
	return { edits, rest };
}

/**
 * A vault path for a proposed edit: ".md" added when missing, and null for
 * anything outside the vault or inside a hidden folder such as .obsidian.
 */
export function editTargetPath(raw: string): string | null {
	let path = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
	if (!path || /^[a-z]:/i.test(path)) return null;
	const parts = path.split('/');
	if (parts.some(part => !part.trim() || part === '..' || part === '.' || part.startsWith('.'))) return null;
	if (!/\.md$/i.test(path)) path = `${path}.md`;
	return path;
}

export function normalizePendingChanges(raw: unknown): PendingChange[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
		.filter(entry => typeof entry.id === 'string' && typeof entry.path === 'string' && typeof entry.content === 'string'
			&& ['append', 'replace', 'edit'].includes(String(entry.kind)))
		.map(entry => ({
			id: entry.id as string,
			jobId: typeof entry.jobId === 'string' ? entry.jobId : '',
			taskNumber: Number(entry.taskNumber) || 0,
			taskTitle: typeof entry.taskTitle === 'string' ? entry.taskTitle : 'Task',
			createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
			kind: entry.kind as PendingKind,
			path: entry.path as string,
			content: entry.content as string,
			...(typeof entry.heading === 'string' && entry.heading ? { heading: entry.heading } : {}),
			...(entry.dailyNote === true ? { dailyNote: true } : {}),
		}))
		.slice(0, MAX_PENDING);
}

export type DiffLine = { type: 'same' | 'add' | 'remove'; text: string };

const MAX_DIFF_LINES = 1500;

/**
 * A line diff of `before` → `after` (longest common subsequence). Very long
 * notes fall back to "everything removed, everything added".
 */
export function lineDiff(before: string, after: string): DiffLine[] {
	const a = before.split('\n');
	const b = after.split('\n');
	if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
		return [...a.map(text => ({ type: 'remove' as const, text })), ...b.map(text => ({ type: 'add' as const, text }))];
	}
	const rows = a.length + 1;
	const cols = b.length + 1;
	const table = new Uint16Array(rows * cols);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * cols + j] = a[i] === b[j]
				? table[(i + 1) * cols + j + 1] + 1
				: Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
		}
	}
	const result: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			result.push({ type: 'same', text: a[i] });
			i++;
			j++;
		} else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
			result.push({ type: 'remove', text: a[i++] });
		} else {
			result.push({ type: 'add', text: b[j++] });
		}
	}
	while (i < a.length) result.push({ type: 'remove', text: a[i++] });
	while (j < b.length) result.push({ type: 'add', text: b[j++] });
	return result;
}

/** The diff with long unchanged stretches folded to `context` lines around each change. */
export function foldDiff(diff: DiffLine[], context = 3): Array<DiffLine | { type: 'fold'; count: number }> {
	const keep = diff.map(line => line.type !== 'same');
	const near = keep.map((_, index) => {
		for (let k = Math.max(0, index - context); k <= Math.min(diff.length - 1, index + context); k++) if (keep[k]) return true;
		return false;
	});
	const result: Array<DiffLine | { type: 'fold'; count: number }> = [];
	let folded = 0;
	diff.forEach((line, index) => {
		if (near[index]) {
			if (folded) result.push({ type: 'fold', count: folded });
			folded = 0;
			result.push(line);
		} else {
			folded++;
		}
	});
	if (folded) result.push({ type: 'fold', count: folded });
	return result;
}

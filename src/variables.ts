/*
 * {{variables}} in task instructions, result file names and headings, filled
 * in when a task runs. Dates are formatted by an injected formatter (moment in
 * the app) so this stays pure and testable. Unknown {{names}} are left as they
 * are, so Templater-style or other plugins' syntax passes through untouched.
 */

/** Formats a date with a moment.js format string, e.g. "YYYY-MM-DD". */
export type DateFormatter = (date: Date, format: string) => string;

export interface VariableContext {
	now: Date;
	format: DateFormatter;
	taskTitle: string;
	/** Start of the last successful run, or null if it never ran. */
	lastRun: Date | null;
	/** Vault path of today's daily note. */
	dailyNotePath?: () => string;
	/** Notes changed since the last run; only computed when the text asks for it. */
	changedNotes?: () => string[];
}

export interface VariableHelp {
	name: string;
	description: string;
}

/** Shown in the task editor and taught to the planner. */
export const VARIABLE_HELP: VariableHelp[] = [
	{ name: '{{date}}', description: 'today, e.g. 2026-10-17' },
	{ name: '{{time}}', description: 'the current time, e.g. 09:00' },
	{ name: '{{yesterday}}', description: "yesterday's date" },
	{ name: '{{tomorrow}}', description: "tomorrow's date" },
	{ name: '{{weekday}}', description: 'the day name, e.g. Monday' },
	{ name: '{{week}}', description: 'the week, e.g. 2026-W42' },
	{ name: '{{month}}', description: 'the month, e.g. 2026-10' },
	{ name: '{{date:FORMAT}}', description: 'today in your own format, e.g. {{date:DD MMM YYYY}}' },
	{ name: '{{last_run}}', description: 'when the task last ran successfully' },
	{ name: '{{changed_notes}}', description: 'links to the notes changed since the last run' },
	{ name: '{{daily_note}}', description: "a link to today's daily note" },
	{ name: '{{task}}', description: 'the task title' },
];

const MAX_CHANGED_NOTES = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(date: Date, days: number): Date {
	// Calendar days, so a DST change doesn't land on the wrong date.
	const result = new Date(date.getTime());
	result.setDate(result.getDate() + days);
	return result;
}

/** A wikilink to a vault path, without the .md extension. */
export function wikiLink(path: string): string {
	return `[[${path.replace(/\.md$/i, '')}]]`;
}

function changedNotesList(paths: string[]): string {
	if (!paths.length) return '(no notes changed)';
	const shown = paths.slice(0, MAX_CHANGED_NOTES).map(path => `- ${wikiLink(path)}`);
	if (paths.length > MAX_CHANGED_NOTES) shown.push(`- …and ${paths.length - MAX_CHANGED_NOTES} more`);
	return shown.join('\n');
}

/** True if the text uses any variable this module knows. */
export function hasVariables(text: string): boolean {
	return /\{\{\s*(date|time|datetime|yesterday|tomorrow|weekday|week|month|last_run|changed_notes|daily_note|task)\b[^}]*\}\}/i.test(String(text || ''));
}

/**
 * Replaces known {{variables}} in `text`. `forFilename` keeps the result
 * usable in a note name (lists and links become plain text, slashes and
 * colons are replaced).
 */
export function expandVariables(text: string, context: VariableContext, forFilename = false): string {
	if (!text || !text.includes('{{')) return text;
	const { now, format } = context;
	const expanded = text.replace(/\{\{\s*([a-z_]+)(?::([^}]*))?\s*\}\}/gi, (match: string, rawName: string, custom?: string) => {
		const name = rawName.toLowerCase();
		switch (name) {
			case 'date':
				return format(now, custom?.trim() || 'YYYY-MM-DD');
			case 'time':
				return format(now, custom?.trim() || 'HH:mm');
			case 'datetime':
				return format(now, custom?.trim() || 'YYYY-MM-DD HH:mm');
			case 'yesterday':
				return format(addDays(now, -1), custom?.trim() || 'YYYY-MM-DD');
			case 'tomorrow':
				return format(addDays(now, 1), custom?.trim() || 'YYYY-MM-DD');
			case 'weekday':
				return format(now, 'dddd');
			case 'week':
				return format(now, 'GGGG-[W]WW');
			case 'month':
				return format(now, 'YYYY-MM');
			case 'last_run':
				return context.lastRun ? format(context.lastRun, custom?.trim() || 'YYYY-MM-DD HH:mm') : 'never';
			case 'task':
				return context.taskTitle;
			case 'daily_note': {
				if (!context.dailyNotePath) return match;
				const path = context.dailyNotePath();
				return forFilename ? path.replace(/\.md$/i, '').split('/').pop() || '' : wikiLink(path);
			}
			case 'changed_notes': {
				if (!context.changedNotes || forFilename) return match;
				return changedNotesList(context.changedNotes());
			}
			default:
				return match;
		}
	});
	return forFilename ? expanded.replace(/[\\/:*?"<>|]/g, '-') : expanded;
}

/** The changed-notes window: since the last successful run, or the last day for a first run. */
export function changedSince(lastRun: Date | null, now: Date): Date {
	return lastRun || new Date(now.getTime() - DAY_MS);
}

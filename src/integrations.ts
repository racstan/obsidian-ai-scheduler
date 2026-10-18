/*
 * Working with other community plugins, all optional and detected at run time:
 * Dataview queries inside a task's instructions, result notes formatted for
 * the Tasks plugin, and result notes built from a template (run through
 * Templater when it is installed).
 */
import type { App, TFile } from 'obsidian';

/** `{{dataview: LIST FROM #project}}`: replaced by the query's Markdown result when the task runs. */
const DATAVIEW_PATTERN = /\{\{\s*dataview\s*:\s*([\s\S]+?)\s*\}\}/gi;
const MAX_QUERY_RESULT = 20_000;

interface DataviewApi {
	queryMarkdown?: (query: string, originFile?: string) => Promise<{ successful: boolean; value?: string; error?: string }>;
}

interface TemplaterPlugin {
	templater?: { overwrite_file_commands?: (file: TFile, activeFile?: boolean) => Promise<void> };
}

function plugins(app: App): Record<string, unknown> {
	return (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins ?? {};
}

export function hasDataviewQueries(text: string): boolean {
	return new RegExp(DATAVIEW_PATTERN.source, 'i').test(String(text || ''));
}

/** The queries in `text`, in order. */
export function dataviewQueries(text: string): string[] {
	return [...String(text || '').matchAll(new RegExp(DATAVIEW_PATTERN.source, 'gi'))].map(match => match[1]);
}

/** Replaces every `{{dataview: …}}` in `text` with `results[i]`. */
export function replaceDataviewQueries(text: string, results: string[]): string {
	let index = 0;
	return String(text || '').replace(new RegExp(DATAVIEW_PATTERN.source, 'gi'), () => results[index++] ?? '');
}

/**
 * Runs the Dataview queries in `text` and puts their results in place. Without
 * Dataview, or when a query fails, a short note explains why, so the AI (and
 * the run history) can tell the result is missing.
 */
export async function expandDataviewQueries(app: App, text: string, originPath = ''): Promise<string> {
	const queries = dataviewQueries(text);
	if (!queries.length) return text;
	const api = (plugins(app).dataview as { api?: DataviewApi } | undefined)?.api;
	const results: string[] = [];
	for (const query of queries) {
		if (!api || typeof api.queryMarkdown !== 'function') {
			results.push(`(Dataview is not installed or enabled, so this query was skipped: ${query})`);
			continue;
		}
		try {
			const result = await api.queryMarkdown(query, originPath);
			const value = result.successful ? String(result.value ?? '').trim() : `(Dataview query failed: ${result.error || 'unknown error'})`;
			results.push(value.length > MAX_QUERY_RESULT ? `${value.slice(0, MAX_QUERY_RESULT)}\n…(result shortened)` : value || '(The Dataview query returned nothing.)');
		} catch (error) {
			results.push(`(Dataview query failed: ${(error as Error)?.message || String(error)})`);
		}
	}
	return replaceDataviewQueries(text, results);
}

/** Asks the AI to write action items as Tasks-plugin task lines. */
export const TASKS_INSTRUCTION = 'Write every action item as a Markdown task line, "- [ ] what to do". When an item has a date, add it in the Tasks plugin format, e.g. "- [ ] Send the report 📅 2026-10-20".';

/**
 * Makes task lines consistent for the Tasks plugin: "* [ ]", "-[]" and similar
 * become "- [ ] ", and open tasks get `tag` (e.g. "#ai") when given.
 */
export function formatAsTasks(text: string, tag = ''): string {
	const cleanTag = tag.trim().replace(/^#*/, '');
	let inFence = false;
	return String(text || '').split('\n').map(line => {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		if (inFence) return line;
		const match = /^(\s*)[-*+]\s*\[( |x|X)?\]\s*(.*)$/.exec(line);
		if (!match) return line;
		const done = match[2] === 'x' || match[2] === 'X';
		let rest = match[3];
		if (!done && cleanTag && !new RegExp(`(^|\\s)#${cleanTag.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\s|$)`).test(rest)) {
			rest = `${rest} #${cleanTag}`.trim();
		}
		return `${match[1]}- [${done ? 'x' : ' '}] ${rest}`;
	}).join('\n');
}

/** A result note from a template: `{{result}}` is replaced by the result, or the result goes at the end. */
export function fillTemplate(template: string, result: string): string {
	if (/\{\{\s*result\s*\}\}/i.test(template)) return template.replace(/\{\{\s*result\s*\}\}/gi, () => result);
	const base = template.replace(/\s+$/, '');
	return base ? `${base}\n\n${result}` : result;
}

/** Runs Templater's commands (`<% … %>`) in `file` when Templater is installed. Returns whether it ran. */
export async function runTemplater(app: App, file: TFile): Promise<boolean> {
	const templater = (plugins(app)['templater-obsidian'] as TemplaterPlugin | undefined)?.templater;
	if (!templater || typeof templater.overwrite_file_commands !== 'function') return false;
	await templater.overwrite_file_commands(file);
	return true;
}

export function isPluginEnabled(app: App, id: string): boolean {
	return Boolean(plugins(app)[id]);
}

/*
 * Pure helpers for where a task's result is written: the output mode, the
 * block added to an existing note, insertion under a heading, and the path of
 * today's daily note.
 */
import { JobOutput, OUTPUT_MODES, OutputMode } from './types';
import { DateFormatter } from './variables';

export const OUTPUT_MODE_LABELS: Record<OutputMode, string> = {
	new: 'A new note each run',
	replace: 'Replace one note each run',
	append: 'Add to one note',
	daily: "Add to today's daily note",
};

/** The output mode, including for tasks saved before modes existed. */
export function outputMode(output: JobOutput | null | undefined): OutputMode {
	if (output?.mode && OUTPUT_MODES.includes(output.mode)) return output.mode;
	// Before modes, a fixed file name meant "replace that note".
	return output?.filename ? 'replace' : 'new';
}

/** The block added to an existing note for one run. */
export function appendBlock(title: string, stamp: string, reply: string): string {
	return `**${title}** · ${stamp}\n\n${reply.trim()}\n`;
}

function headingMatch(line: string): { level: number; text: string } | null {
	const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
	return match ? { level: match[1].length, text: match[2] } : null;
}

/**
 * Adds `block` to `content`: at the end, or at the end of the section under
 * `heading` (matched case-insensitively, any level, with or without the #s).
 * A missing heading is created at the end of the note as a level-2 heading.
 */
export function insertBlock(content: string, block: string, heading?: string): string {
	const body = content.replace(/\s+$/, '');
	const wanted = String(heading || '').replace(/^#+\s*/, '').trim();
	if (!wanted) return body ? `${body}\n\n${block}` : block;

	const lines = body.split('\n');
	let inFence = false;
	let start = -1;
	let level = 0;
	let end = lines.length;
	for (let index = 0; index < lines.length; index++) {
		if (/^\s*(```|~~~)/.test(lines[index])) inFence = !inFence;
		if (inFence) continue;
		const found = headingMatch(lines[index]);
		if (!found) continue;
		if (start < 0) {
			if (found.text.toLowerCase() === wanted.toLowerCase()) {
				start = index;
				level = found.level;
			}
		} else if (found.level <= level) {
			end = index;
			break;
		}
	}
	if (start < 0) {
		const prefix = body ? `${body}\n\n` : '';
		return `${prefix}## ${wanted}\n\n${block}`;
	}
	// Place the block after the section's last non-empty line.
	let insertAt = end;
	while (insertAt > start + 1 && !lines[insertAt - 1].trim()) insertAt--;
	const before = lines.slice(0, insertAt).join('\n');
	const after = lines.slice(end).join('\n');
	const blockText = block.replace(/\s+$/, '');
	return after
		? `${before}\n\n${blockText}\n\n${after}\n`
		: `${before}\n\n${blockText}\n`;
}

export interface DailyNoteSettings {
	folder?: string;
	format?: string;
}

/** Vault path of the daily note for `date`, from the Daily notes core plugin's settings. */
export function dailyNotePath(settings: DailyNoteSettings | null | undefined, date: Date, format: DateFormatter): string {
	const folder = String(settings?.folder || '').trim().replace(/^\/+|\/+$/g, '');
	const name = format(date, String(settings?.format || '').trim() || 'YYYY-MM-DD');
	return folder ? `${folder}/${name}.md` : `${name}.md`;
}

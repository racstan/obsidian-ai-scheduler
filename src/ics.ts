/*
 * iCalendar (.ics, RFC 5545) export of upcoming scheduled runs, so they can be
 * imported into (or subscribed to from) Google Calendar, Outlook, Apple
 * Calendar, etc. One-way and offline: the plugin only writes a file.
 */
import { Job } from './types';
import { getScheduleOccurrencesInRange } from './schedule';

/** Most runs exported per task, so an every-minute cron can't produce a huge file. */
const MAX_RUNS_PER_JOB = 500;
/** Runs are shown as short events; the actual AI run time varies. */
const EVENT_MINUTES = 15;

/** Escapes TEXT values (RFC 5545 §3.3.11). */
function escapeText(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r?\n/g, '\\n');
}

/** UTC date-time in iCalendar basic format, e.g. 20261008T070000Z. */
function icsDate(date: Date): string {
	return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Folds lines longer than 75 octets (RFC 5545 §3.1), never splitting a UTF-8 character. */
function foldLine(line: string): string {
	const encoder = new TextEncoder();
	if (encoder.encode(line).length <= 75) return line;
	const parts: string[] = [];
	let current = '';
	let size = 0;
	for (const char of line) {
		const bytes = encoder.encode(char).length;
		// Continuation lines start with a space, which counts toward their 75 octets.
		const limit = parts.length ? 74 : 75;
		if (size + bytes > limit) {
			parts.push(current);
			current = '';
			size = 0;
		}
		current += char;
		size += bytes;
	}
	parts.push(current);
	return parts.join('\r\n ');
}

/**
 * Builds a calendar of every enabled, time-based task's runs between `from`
 * and `to`. UIDs are stable per task and run time, and DTSTAMP comes from the
 * task, so the file only changes when the schedule does (calendar apps then
 * update events in place rather than duplicating them).
 */
export function buildIcs(jobs: Job[], from: Date, to: Date): string {
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//AI Scheduler//Obsidian plugin//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		'X-WR-CALNAME:AI Scheduler',
	];
	for (const job of jobs) {
		if (!job.enabled || job.schedule.kind === 'event') continue;
		const stamp = icsDate(new Date(job.createdAt || 0));
		const description = job.prompt.length > 1000 ? `${job.prompt.slice(0, 1000)}…` : job.prompt;
		for (const start of getScheduleOccurrencesInRange(job.schedule, from, to, MAX_RUNS_PER_JOB)) {
			const end = new Date(start.getTime() + EVENT_MINUTES * 60000);
			lines.push(
				'BEGIN:VEVENT',
				`UID:${job.id}-${icsDate(start)}@ai-scheduler`,
				`DTSTAMP:${stamp}`,
				`DTSTART:${icsDate(start)}`,
				`DTEND:${icsDate(end)}`,
				`SUMMARY:${escapeText(`AI: ${job.title}`)}`,
				`DESCRIPTION:${escapeText(description)}`,
				'CATEGORIES:AI Scheduler',
				'TRANSP:TRANSPARENT',
				'END:VEVENT',
			);
		}
	}
	lines.push('END:VCALENDAR');
	return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

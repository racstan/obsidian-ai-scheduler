/*
 * Google Calendar (early access): the pure parts, so they can be tested
 * without Google or Obsidian. Turning events into text for prompts, deciding
 * which AI Scheduler runs belong in the user's "AI Scheduler" calendar, and
 * when a "before calendar events" task should run.
 */
import { Job } from '../types';
import { getScheduleOccurrencesInRange, waitsForTrigger } from '../schedule';

/** The parts of a Google Calendar event the plugin uses. */
export interface CalendarEvent {
	id: string;
	calendarId: string;
	title: string;
	/** ISO start; for all-day events, the date at local midnight. */
	start: string;
	end: string;
	allDay: boolean;
	location?: string;
	description?: string;
	/** Video call link, if any. */
	link?: string;
	attendees?: string[];
	/** The user's own response: declined events never trigger tasks. */
	declined?: boolean;
}

/** Turns one item of the Calendar API's events.list into a CalendarEvent, or null for cancelled ones. */
export function parseApiEvent(raw: Record<string, unknown>, calendarId: string): CalendarEvent | null {
	if (!raw || raw.status === 'cancelled' || typeof raw.id !== 'string') return null;
	const start = raw.start as { dateTime?: string; date?: string } | undefined;
	const end = raw.end as { dateTime?: string; date?: string } | undefined;
	const allDay = !start?.dateTime;
	const startIso = start?.dateTime ?? (start?.date ? localDate(start.date).toISOString() : null);
	const endIso = end?.dateTime ?? (end?.date ? localDate(end.date).toISOString() : startIso);
	if (!startIso || !endIso) return null;
	const attendees = Array.isArray(raw.attendees) ? raw.attendees as Array<Record<string, unknown>> : [];
	const self = attendees.find(attendee => attendee.self === true);
	const conference = (raw.conferenceData as { entryPoints?: Array<{ entryPointType?: string; uri?: string }> } | undefined)?.entryPoints
		?.find(entry => entry.entryPointType === 'video')?.uri;
	return {
		id: raw.id,
		calendarId,
		title: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary : '(No title)',
		start: startIso,
		end: endIso,
		allDay,
		...(typeof raw.location === 'string' && raw.location ? { location: raw.location } : {}),
		...(typeof raw.description === 'string' && raw.description ? { description: raw.description } : {}),
		...(conference || typeof raw.hangoutLink === 'string' ? { link: conference || raw.hangoutLink as string } : {}),
		...(attendees.length ? {
			attendees: attendees
				.filter(attendee => attendee.self !== true && attendee.resource !== true)
				.map(attendee => text(attendee.displayName) || text(attendee.email))
				.filter(Boolean),
		} : {}),
		...(self?.responseStatus === 'declined' ? { declined: true } : {}),
	};
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function localDate(date: string): Date {
	const [year, month, day] = date.split('-').map(Number);
	return new Date(year, month - 1, day);
}

const MAX_DESCRIPTION = 400;

/** Events as a Markdown list for a prompt, e.g. "- 09:00–09:30 Standup (Zoom) with Sam, Jo". */
export function formatEvents(events: CalendarEvent[], formatTime: (date: Date) => string, withDay = false, formatDay?: (date: Date) => string): string {
	if (!events.length) return '(No events.)';
	return events.map(event => {
		const start = new Date(event.start);
		const day = withDay && formatDay ? `${formatDay(start)} ` : '';
		const when = event.allDay ? `${day}all day` : `${day}${formatTime(start)}–${formatTime(new Date(event.end))}`;
		const parts = [`- ${when} ${event.title}`];
		if (event.location) parts.push(`(${event.location})`);
		if (event.attendees?.length) parts.push(`with ${event.attendees.slice(0, 8).join(', ')}${event.attendees.length > 8 ? ` and ${event.attendees.length - 8} more` : ''}`);
		if (event.link) parts.push(`· ${event.link}`);
		return parts.join(' ');
	}).join('\n');
}

/** One event in full, for {{event}} in a "before calendar events" task. */
export function describeEvent(event: CalendarEvent, formatDateTime: (date: Date) => string): string {
	const lines = [
		`Title: ${event.title}`,
		`When: ${event.allDay ? 'all day' : `${formatDateTime(new Date(event.start))} to ${formatDateTime(new Date(event.end))}`}`,
	];
	if (event.location) lines.push(`Where: ${event.location}`);
	if (event.link) lines.push(`Video call: ${event.link}`);
	if (event.attendees?.length) lines.push(`Attendees: ${event.attendees.join(', ')}`);
	if (event.description) {
		const text = event.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
		lines.push(`Description: ${text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION)}…` : text}`);
	}
	return lines.join('\n');
}

/** Does an event match a "before calendar events" task's title filter (comma-separated words, any of them)? */
export function eventMatches(event: CalendarEvent, filter: string | undefined): boolean {
	if (event.allDay || event.declined) return false;
	const words = String(filter || '').split(',').map(word => word.trim().toLowerCase()).filter(Boolean);
	return !words.length || words.some(word => event.title.toLowerCase().includes(word));
}

/** The key that marks an event occurrence as already handled by a task. */
export function eventKey(event: CalendarEvent): string {
	return `${event.calendarId}/${event.id}@${event.start}`;
}

/**
 * For a "before calendar events" task: the next event it should run for and
 * when, skipping events it already ran for and ones that already started.
 * An event that is closer than the chosen minutes (added late, or the computer
 * was asleep) runs the task right away, as long as it has not started.
 */
export function nextMeetingTrigger(job: Job, events: CalendarEvent[], now: number): { at: string; event: CalendarEvent } | null {
	if (job.schedule.kind !== 'meeting') return null;
	const minutes = Math.max(0, Number(job.schedule.minutesBefore ?? 10));
	const fired = new Set(job.firedEvents ?? []);
	const candidates = events
		.filter(event => eventMatches(event, job.schedule.eventMatch) && !fired.has(eventKey(event)))
		.map(event => ({ event, at: new Date(event.start).getTime() - minutes * 60_000 }))
		.filter(({ event }) => new Date(event.start).getTime() > now)
		.sort((a, b) => a.at - b.at);
	const first = candidates[0];
	return first ? { at: new Date(Math.max(first.at, now)).toISOString(), event: first.event } : null;
}

/** A Google Calendar event id for one run (base32hex: a–v and 0–9), stable for the same task and time. */
export function runEventId(jobId: string, start: Date): string {
	const text = `${jobId}|${start.toISOString()}`;
	// Two 32-bit FNV-1a hashes with different seeds give a 64-bit id; collisions are not a concern at this size.
	const hash = (seed: number) => {
		let value = seed;
		for (let index = 0; index < text.length; index++) {
			value ^= text.charCodeAt(index);
			value = Math.imul(value, 16777619) >>> 0;
		}
		return value.toString(32).padStart(7, '0');
	};
	return `ais${hash(2166136261)}${hash(84696351)}`;
}

/** A run as it appears in the "AI Scheduler" calendar. */
export interface RunEvent {
	id: string;
	jobId: string;
	title: string;
	description: string;
	start: string;
	end: string;
}

const RUN_MINUTES = 15;
const MAX_RUNS_PER_TASK = 100;
const MAX_RUN_EVENTS = 500;

/** The runs that should be in the "AI Scheduler" calendar between `from` and `to`. */
export function desiredRunEvents(jobs: Job[], from: Date, to: Date): RunEvent[] {
	const events: RunEvent[] = [];
	for (const job of jobs) {
		if (!job.enabled || waitsForTrigger(job.schedule)) continue;
		// "Runs N times then done": only the runs left.
		const limit = Number(job.schedule.maxIterations) > 0 ? Math.max(0, Number(job.schedule.maxIterations) - Number(job.runCount || 0)) : MAX_RUNS_PER_TASK;
		if (!limit) continue;
		const prompt = Array.from(job.prompt);
		const description = `${prompt.length > 600 ? `${prompt.slice(0, 600).join('')}…` : job.prompt}\n\nScheduled by AI Scheduler (task #${job.taskNumber}).`;
		for (const start of getScheduleOccurrencesInRange(job.schedule, from, to, Math.min(limit, MAX_RUNS_PER_TASK))) {
			events.push({
				id: runEventId(job.id, start),
				jobId: job.id,
				title: `AI: ${job.title}`,
				description,
				start: start.toISOString(),
				end: new Date(start.getTime() + RUN_MINUTES * 60_000).toISOString(),
			});
		}
	}
	return events.sort((a, b) => a.start.localeCompare(b.start)).slice(0, MAX_RUN_EVENTS);
}

/** What to add to and remove from the "AI Scheduler" calendar so it matches `desired`. */
export function planRunSync(desired: RunEvent[], existing: Array<{ id: string; start: string; title?: string }>): { create: RunEvent[]; remove: string[] } {
	const existingIds = new Set(existing.map(event => event.id));
	const wanted = new Map(desired.map(event => [event.id, event]));
	return {
		create: desired.filter(event => !existingIds.has(event.id)),
		// Only events this plugin made (its id prefix); anything the user added stays.
		remove: existing.filter(event => event.id.startsWith('ais') && !wanted.has(event.id)).map(event => event.id),
	};
}

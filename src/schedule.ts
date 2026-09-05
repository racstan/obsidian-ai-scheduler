/*
 * Schedule math ported from the original main.js, extended with the cron
 * schedule kind. All kinds resolve to a concrete next-run timestamp so the
 * 15s dispatcher can treat every job uniformly.
 */
import { cronNext, cronUpcoming, describeCron, formatLocalRun, validateCron } from './cron';
import { Job, MultiRule, TaskSchedule } from './types';
import { formatDate } from './util';

export function parseClock(value: unknown): { hour: number; minute: number } {
	const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
	return match ? { hour: Number(match[1]), minute: Number(match[2]) } : { hour: 22, minute: 0 };
}

export function validClock(value: unknown): boolean {
	return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(value || '').trim());
}

export function nextDailyRun(time: string, from: Date = new Date()): string {
	const clock = parseClock(time);
	const candidate = new Date(from);
	candidate.setHours(clock.hour, clock.minute, 0, 0);
	if (candidate <= from) candidate.setDate(candidate.getDate() + 1);
	return candidate.toISOString();
}

export function nextWeeklyRun(time: string, days: number[] | undefined, from: Date = new Date()): string {
	const clock = parseClock(time);
	const wanted = Array.isArray(days) && days.length ? days.map(Number) : [from.getDay()];
	for (let offset = 0; offset <= 7; offset++) {
		const candidate = new Date(from);
		candidate.setDate(candidate.getDate() + offset);
		candidate.setHours(clock.hour, clock.minute, 0, 0);
		if (wanted.includes(candidate.getDay()) && candidate > from) return candidate.toISOString();
	}
	return nextDailyRun(time, from);
}

export function normalizeMaxIterations(value: unknown): number | null {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : null;
}

export function normalizeMultiRules(rules: unknown): MultiRule[] {
	if (!Array.isArray(rules)) return [];
	return (rules as Array<Record<string, unknown>>).map(rule => {
		const days = Array.isArray(rule && rule.days) ? (rule.days as unknown[]) : [];
		const times = Array.isArray(rule && rule.times)
			? (rule.times as unknown[])
			: (rule && rule.time ? [rule.time] : []);
		return {
			days: [...new Set(days.map(Number).filter(day => day >= 0 && day <= 6))].sort((a, b) => a - b),
			times: [...new Set(times.map(time => String(time).trim()).filter(validClock))].sort(),
		};
	}).filter(rule => rule.days.length && rule.times.length);
}

export function nextMultiRun(rules: unknown, from: Date = new Date()): string | null {
	const normalized = normalizeMultiRules(rules);
	let next: Date | null = null;
	for (let offset = 0; offset <= 7; offset++) {
		const day = new Date(from);
		day.setDate(day.getDate() + offset);
		for (const rule of normalized) {
			if (!rule.days.includes(day.getDay())) continue;
			for (const time of rule.times) {
				const clock = parseClock(time);
				const candidate = new Date(day);
				candidate.setHours(clock.hour, clock.minute, 0, 0);
				if (candidate <= from) continue;
				if (!next || candidate < next) next = candidate;
			}
		}
	}
	return next ? next.toISOString() : null;
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseDayToken(token: string): number[] {
	const normalized = String(token || '').trim().toLowerCase();
	const exactLong = DAY_NAMES.findIndex(name => name.toLowerCase() === normalized);
	const exact = exactLong >= 0 ? exactLong : DAY_SHORT_NAMES.findIndex(name => name.toLowerCase() === normalized);
	if (exact >= 0) return [exact];
	const match = /^([a-z]+)\s*-\s*([a-z]+)$/.exec(normalized);
	if (!match) return [];
	const startLong = DAY_NAMES.findIndex(name => name.toLowerCase().startsWith(match[1]));
	const start = startLong >= 0 ? startLong : DAY_SHORT_NAMES.findIndex(name => name.toLowerCase().startsWith(match[1]));
	const endLong = DAY_NAMES.findIndex(name => name.toLowerCase().startsWith(match[2]));
	const end = endLong >= 0 ? endLong : DAY_SHORT_NAMES.findIndex(name => name.toLowerCase().startsWith(match[2]));
	if (start < 0 || end < 0) return [];
	const days: number[] = [];
	for (let day = start; ; day = (day + 1) % 7) {
		days.push(day);
		if (day === end) break;
	}
	return days;
}

export function parseMultiRulesText(value: string): MultiRule[] {
	const source = String(value || '').trim();
	if (!source) return [];
	try {
		const parsed = JSON.parse(source);
		if (Array.isArray(parsed)) return normalizeMultiRules(parsed);
	} catch (_) { /* use the readable line format below */ }
	const rules: MultiRule[] = [];
	for (const line of source.split(/\r?\n/)) {
		const match = /^(.+?)\s*=\s*(.+)$/.exec(line.trim());
		if (!match) continue;
		const days = match[1].split(',').flatMap(parseDayToken);
		const times = match[2].split(',').map(value => value.trim()).filter(validClock);
		rules.push({ days, times });
	}
	return normalizeMultiRules(rules);
}

export function formatMultiRules(rules: unknown): string {
	return normalizeMultiRules(rules)
		.map(rule => `${rule.days.map(day => DAY_SHORT_NAMES[day]).join(', ')} = ${rule.times.join(', ')}`)
		.join('\n');
}

function legacyField(schedule: TaskSchedule, key: string): unknown {
	return (schedule as unknown as Record<string, unknown>)[key];
}

export function scheduleMinutes(schedule: TaskSchedule): number {
	if (schedule.kind === 'hourly') return 60;
	const minutes = Number(schedule.intervalMinutes || legacyField(schedule, 'everyMinutes') || (Number(legacyField(schedule, 'everyHours') || 0) * 60));
	return Number.isFinite(minutes) ? minutes : NaN;
}

export function getScheduleNextRun(schedule: TaskSchedule | null | undefined, from: Date = new Date()): string | null {
	if (!schedule || schedule.kind === 'event') return null;
	if (schedule.kind === 'once') {
		const date = new Date(schedule.at as string);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	if (schedule.kind === 'weekly') return validClock(schedule.time) ? nextWeeklyRun(schedule.time as string, schedule.days, from) : null;
	if (schedule.kind === 'multi') return nextMultiRun(schedule.rules, from);
	if (schedule.kind === 'hourly' || schedule.kind === 'interval') {
		const minutes = scheduleMinutes(schedule);
		if (!Number.isFinite(minutes) || minutes <= 0) return null;
		return new Date(from.getTime() + minutes * 60000).toISOString();
	}
	if (schedule.kind === 'cron') {
		if (!schedule.expression || validateCron(schedule.expression)) return null;
		const next = cronNext(schedule.expression, from);
		return next ? next.toISOString() : null;
	}
	return validClock(schedule.time) ? nextDailyRun(schedule.time as string, from) : null;
}

/** The cron expression equivalent of a schedule, when one can express it exactly. */
export function cronFormFor(schedule: TaskSchedule): string | null {
	if (!schedule) return null;
	if (schedule.kind === 'cron') return schedule.expression || null;
	if (schedule.kind === 'daily' && validClock(schedule.time)) {
		const clock = parseClock(schedule.time);
		return `${clock.minute} ${clock.hour} * * *`;
	}
	if (schedule.kind === 'weekly' && validClock(schedule.time) && Array.isArray(schedule.days) && schedule.days.length) {
		const clock = parseClock(schedule.time);
		return `${clock.minute} ${clock.hour} * * ${[...new Set(schedule.days.map(Number))].sort((a, b) => a - b).join(',')}`;
	}
	if (schedule.kind === 'multi') {
		const rules = normalizeMultiRules(schedule.rules);
		if (!rules.length) return null;
		const firstTimes = JSON.stringify(rules[0].times);
		if (!rules.every(rule => JSON.stringify(rule.times) === firstTimes)) return null;
		const days = [...new Set(rules.flatMap(rule => rule.days))].sort((a, b) => a - b);
		if (!days.length || !rules[0].times.length) return null;
		const clock = parseClock(rules[0].times[0]);
		return `${clock.minute} ${clock.hour} * * ${days.join(',')}`;
	}
	return null;
}

/** Concrete upcoming run times for any schedule kind, formatted for preview tables. */
export function previewSchedule(schedule: TaskSchedule | null | undefined, count = 3, from: Date = new Date()): string[] {
	if (!schedule) return [];
	if (schedule.kind === 'event') return ['fires on vault activity'];
	if (schedule.kind === 'cron') {
		if (!schedule.expression || validateCron(schedule.expression)) return [];
		return cronUpcoming(schedule.expression, count, from).map(formatLocalRun);
	}
	const runs: string[] = [];
	let cursor = from;
	for (let index = 0; index < count; index++) {
		const next = getScheduleNextRun(schedule, cursor);
		if (!next) break;
		runs.push(formatLocalRun(new Date(next)));
		cursor = new Date(new Date(next).getTime() + 1000);
	}
	return runs;
}

export function describeSchedule(job: { schedule?: TaskSchedule; nextRunAt?: string | null }): string {
	const schedule = job.schedule || ({} as TaskSchedule);
	if (schedule.kind === 'daily') return `daily at ${schedule.time}`;
	if (schedule.kind === 'weekly') {
		const days = (schedule.days || []).map(Number).filter(day => DAY_SHORT_NAMES[day]).map(day => DAY_SHORT_NAMES[day]);
		return `weekly ${days.join(', ') || 'at the selected days'} at ${schedule.time}`;
	}
	if (schedule.kind === 'multi') return formatMultiRules(schedule.rules).replace(/\n/g, ' · ') || 'multiple times';
	if (schedule.kind === 'hourly') return `every hour${schedule.maxIterations ? ` · ${schedule.maxIterations} iterations` : ''}`;
	if (schedule.kind === 'interval') {
		const minutes = Number(schedule.intervalMinutes || legacyField(schedule, 'everyMinutes') || (Number(legacyField(schedule, 'everyHours') || 0) * 60) || 0);
		const cadence = minutes % 60 === 0 ? `every ${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `every ${minutes} minutes`;
		return `${cadence}${schedule.maxIterations ? ` · ${schedule.maxIterations} iterations` : ''}`;
	}
	if (schedule.kind === 'event') return `when ${schedule.event || 'the vault changes'}`;
	if (schedule.kind === 'cron') {
		const expression = schedule.expression || '';
		const description = describeCron(expression);
		return description === 'Invalid cron expression' ? `cron ${expression || '(empty)'}` : `${description} · ${expression}`;
	}
	return job.nextRunAt ? formatDate(job.nextRunAt) : 'not scheduled';
}

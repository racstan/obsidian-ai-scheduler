/*
 * Schedule math ported and extended with every N days/weeks/months/years,
 * initial starting time anchors, and run-for-N-times limits.
 */
import { cronNext, cronUpcoming, describeCron, formatLocalRun, validateCron } from './cron';
import { MultiRule, TaskSchedule } from './types';
import { formatDate } from './util';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTH_SHORT_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseClock(value: unknown): { hour: number; minute: number } {
	const str = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
	const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(str);
	return match ? { hour: Number(match[1]), minute: Number(match[2]) } : { hour: 9, minute: 0 };
}

export function validClock(value: unknown): boolean {
	const str = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
	return /^([01]?\d|2[0-3]):[0-5]\d$/.test(str);
}

/**
 * Parses a schedule anchor. A bare "YYYY-MM-DD" (what date inputs produce) is a
 * local calendar date; `new Date("YYYY-MM-DD")` would be UTC midnight, which is
 * the previous day west of UTC.
 */
export function parseAnchor(startAt: string | undefined): Date | null {
	if (!startAt) return null;
	const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startAt.trim());
	const date = dateOnly
		? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
		: new Date(startAt);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Calendar-day number of a local date; differences are exact across DST changes. */
function dayNumber(date: Date): number {
	return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
}

export function nextDailyRun(time: string, everyDays = 1, startAt?: string, from: Date = new Date()): string {
	const clock = parseClock(time);
	const step = Number.isInteger(everyDays) && everyDays > 1 ? everyDays : 1;

	const anchor = parseAnchor(startAt);
	if (anchor) {
		anchor.setHours(clock.hour, clock.minute, 0, 0);
		if (anchor > from) return anchor.toISOString();
		// Count calendar days (not 24h blocks) and step with setDate so the wall
		// time stays fixed across DST transitions.
		const elapsedDays = dayNumber(from) - dayNumber(anchor);
		let offset = Math.floor(elapsedDays / step) * step;
		let candidate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + offset, clock.hour, clock.minute, 0, 0);
		while (candidate <= from) {
			offset += step;
			candidate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + offset, clock.hour, clock.minute, 0, 0);
		}
		return candidate.toISOString();
	}

	const candidate = new Date(from);
	candidate.setHours(clock.hour, clock.minute, 0, 0);
	if (candidate <= from) {
		candidate.setDate(candidate.getDate() + step);
	}
	return candidate.toISOString();
}

export function nextWeeklyRun(time: string, days: number[] | undefined, everyWeeks = 1, startAt?: string, from: Date = new Date()): string {
	const clock = parseClock(time);
	const wanted = Array.isArray(days) && days.length
		? [...new Set(days.map(Number).filter(d => d >= 0 && d <= 6))].sort((a, b) => a - b)
		: [from.getDay()];
	const stepWeeks = Number.isInteger(everyWeeks) && everyWeeks > 1 ? everyWeeks : 1;

	for (let offset = 0; offset <= 7 * stepWeeks * 4; offset++) {
		const candidate = new Date(from);
		candidate.setDate(candidate.getDate() + offset);
		candidate.setHours(clock.hour, clock.minute, 0, 0);
		if (candidate <= from) continue;
		if (wanted.includes(candidate.getDay())) {
			const anchor = stepWeeks > 1 ? parseAnchor(startAt) : null;
			if (anchor) {
				const diffWeeks = Math.floor((dayNumber(candidate) - dayNumber(anchor)) / 7);
				if (diffWeeks >= 0 && diffWeeks % stepWeeks !== 0) continue;
			}
			return candidate.toISOString();
		}
	}
	return nextDailyRun(time, 1, undefined, from);
}

export function nextMonthlyRun(time: string, dayOfMonth = 1, everyMonths = 1, startAt?: string, from: Date = new Date()): string {
	const clock = parseClock(time);
	const targetDay = Number.isInteger(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 31 ? dayOfMonth : 1;
	const stepMonths = Number.isInteger(everyMonths) && everyMonths > 1 ? everyMonths : 1;

	let year = from.getFullYear();
	let month = from.getMonth();

	// Enough months to reach the next step even for long "every N months" cadences.
	for (let i = 0; i < 48 * stepMonths; i++) {
		const daysInMonth = new Date(year, month + 1, 0).getDate();
		const clampedDay = Math.min(targetDay, daysInMonth);
		const candidate = new Date(year, month, clampedDay, clock.hour, clock.minute, 0, 0);

		if (candidate > from) {
			const anchor = stepMonths > 1 ? parseAnchor(startAt) : null;
			if (anchor) {
				const monthDiff = (year - anchor.getFullYear()) * 12 + (month - anchor.getMonth());
				if (monthDiff >= 0 && monthDiff % stepMonths !== 0) {
					month += 1;
					if (month > 11) {
						year += Math.floor(month / 12);
						month = month % 12;
					}
					continue;
				}
			}
			return candidate.toISOString();
		}

		month += 1;
		if (month > 11) {
			year += Math.floor(month / 12);
			month = month % 12;
		}
	}
	return nextDailyRun(time, 1, undefined, from);
}

export function nextYearlyRun(time: string, targetMonth = 1, targetDay = 1, from: Date = new Date()): string {
	const clock = parseClock(time);
	const monthIdx = Number.isInteger(targetMonth) && targetMonth >= 1 && targetMonth <= 12 ? targetMonth - 1 : 0;
	const day = Number.isInteger(targetDay) && targetDay >= 1 && targetDay <= 31 ? targetDay : 1;

	const currentYear = from.getFullYear();
	const daysInMonthThisYear = new Date(currentYear, monthIdx + 1, 0).getDate();
	const candidateThisYear = new Date(currentYear, monthIdx, Math.min(day, daysInMonthThisYear), clock.hour, clock.minute, 0, 0);

	if (candidateThisYear > from) {
		return candidateThisYear.toISOString();
	}

	const nextYear = currentYear + 1;
	const daysInMonthNextYear = new Date(nextYear, monthIdx + 1, 0).getDate();
	const candidateNextYear = new Date(nextYear, monthIdx, Math.min(day, daysInMonthNextYear), clock.hour, clock.minute, 0, 0);
	return candidateNextYear.toISOString();
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
		const parsed = JSON.parse(source) as unknown;
		if (Array.isArray(parsed)) return normalizeMultiRules(parsed);
	} catch { /* use the readable line format below */ }
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
	if (schedule.kind === 'daily') {
		return validClock(schedule.time) ? nextDailyRun(schedule.time as string, schedule.everyDays || 1, schedule.startAt, from) : null;
	}
	if (schedule.kind === 'weekly') {
		return validClock(schedule.time) ? nextWeeklyRun(schedule.time as string, schedule.days, schedule.everyWeeks || 1, schedule.startAt, from) : null;
	}
	if (schedule.kind === 'monthly') {
		return validClock(schedule.time) ? nextMonthlyRun(schedule.time as string, schedule.dayOfMonth || 1, schedule.everyMonths || 1, schedule.startAt, from) : null;
	}
	if (schedule.kind === 'yearly') {
		return validClock(schedule.time) ? nextYearlyRun(schedule.time as string, schedule.month || 1, schedule.dayOfMonth || 1, from) : null;
	}
	if (schedule.kind === 'multi') return nextMultiRun(schedule.rules, from);
	if (schedule.kind === 'hourly' || schedule.kind === 'interval') {
		const minutes = scheduleMinutes(schedule);
		if (!Number.isFinite(minutes) || minutes <= 0) return null;
		const anchor = parseAnchor(schedule.startAt);
		if (anchor) {
			if (anchor > from) return anchor.toISOString();
			const elapsed = from.getTime() - anchor.getTime();
			const steps = Math.floor(elapsed / (minutes * 60000)) + 1;
			return new Date(anchor.getTime() + steps * minutes * 60000).toISOString();
		}
		if (schedule.time && validClock(schedule.time)) {
			const clock = parseClock(schedule.time);
			const anchorToday = new Date(from);
			anchorToday.setHours(clock.hour, clock.minute, 0, 0);
			if (anchorToday > from) return anchorToday.toISOString();
			const elapsed = from.getTime() - anchorToday.getTime();
			const steps = Math.floor(elapsed / (minutes * 60000)) + 1;
			return new Date(anchorToday.getTime() + steps * minutes * 60000).toISOString();
		}
		return new Date(from.getTime() + minutes * 60000).toISOString();
	}
	if (schedule.kind === 'cron') {
		if (!schedule.expression || validateCron(schedule.expression)) return null;
		const next = cronNext(schedule.expression, from);
		return next ? next.toISOString() : null;
	}
	return validClock(schedule.time) ? nextDailyRun(schedule.time as string, 1, undefined, from) : null;
}

/** The cron expression equivalent of a schedule, when one can express it exactly. */
export function cronFormFor(schedule: TaskSchedule): string | null {
	if (!schedule) return null;
	if (schedule.kind === 'cron') return schedule.expression || null;
	if (schedule.kind === 'daily' && validClock(schedule.time) && (!schedule.everyDays || schedule.everyDays === 1)) {
		const clock = parseClock(schedule.time);
		return `${clock.minute} ${clock.hour} * * *`;
	}
	if (schedule.kind === 'weekly' && validClock(schedule.time) && (!schedule.everyWeeks || schedule.everyWeeks === 1) && Array.isArray(schedule.days) && schedule.days.length) {
		const clock = parseClock(schedule.time);
		return `${clock.minute} ${clock.hour} * * ${[...new Set(schedule.days.map(Number))].sort((a, b) => a - b).join(',')}`;
	}
	if (schedule.kind === 'monthly' && validClock(schedule.time) && (!schedule.everyMonths || schedule.everyMonths === 1)) {
		const clock = parseClock(schedule.time);
		return `${clock.minute} ${clock.hour} ${schedule.dayOfMonth || 1} * *`;
	}
	if (schedule.kind === 'yearly' && validClock(schedule.time)) {
		const clock = parseClock(schedule.time);
		return `${clock.minute} ${clock.hour} ${schedule.dayOfMonth || 1} ${schedule.month || 1} *`;
	}
	if (schedule.kind === 'multi') {
		const rules = normalizeMultiRules(schedule.rules);
		if (!rules.length) return null;
		const firstTimes = JSON.stringify(rules[0].times);
		if (!rules.every(rule => JSON.stringify(rule.times) === firstTimes)) return null;
		const days = [...new Set(rules.flatMap(rule => rule.days))].sort((a, b) => a - b);
		if (!days.length || !rules[0].times.length) return null;
		const clocks = rules[0].times.map(parseClock);
		const minutes = [...new Set(clocks.map(c => c.minute))];
		if (minutes.length === 1) {
			const hours = [...new Set(clocks.map(c => c.hour))].sort((a, b) => a - b);
			return `${minutes[0]} ${hours.join(',')} * * ${days.join(',')}`;
		}
		return clocks.map(c => `${c.minute} ${c.hour} * * ${days.join(',')}`).join('; ');
	}
	return null;
}

/** Concrete upcoming run times for any schedule kind, formatted for preview tables. */
export function previewSchedule(schedule: TaskSchedule | null | undefined, count = 3, from: Date = new Date()): string[] {
	if (!schedule) return [];
	if (schedule.kind === 'event') return ['fires on vault activity'];
	if (schedule.kind === 'once') {
		const date = new Date(schedule.at as string);
		return Number.isNaN(date.getTime()) ? [] : [formatLocalRun(date)];
	}
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
	let desc = '';
	if (schedule.kind === 'daily') {
		if (schedule.everyDays && schedule.everyDays > 1) {
			desc = `every ${schedule.everyDays} days at ${schedule.time || '09:00'}${schedule.startAt ? ` starting ${formatDate(schedule.startAt)}` : ''}`;
		} else {
			desc = `daily at ${schedule.time || '09:00'}`;
		}
	} else if (schedule.kind === 'weekly') {
		const days = (schedule.days || []).map(Number).filter(day => DAY_SHORT_NAMES[day]).map(day => DAY_SHORT_NAMES[day]);
		if (schedule.everyWeeks && schedule.everyWeeks > 1) {
			desc = `every ${schedule.everyWeeks} weeks on ${days.join(', ') || 'selected days'} at ${schedule.time || '09:00'}`;
		} else {
			desc = `weekly on ${days.join(', ') || 'selected days'} at ${schedule.time || '09:00'}`;
		}
	} else if (schedule.kind === 'monthly') {
		const every = schedule.everyMonths && schedule.everyMonths > 1 ? `every ${schedule.everyMonths} months` : 'monthly';
		desc = `${every} on day ${schedule.dayOfMonth || 1} at ${schedule.time || '09:00'}`;
	} else if (schedule.kind === 'yearly') {
		const monthName = MONTH_NAMES[schedule.month || 1] || 'January';
		desc = `yearly on ${monthName} ${schedule.dayOfMonth || 1} at ${schedule.time || '09:00'}`;
	} else if (schedule.kind === 'multi') {
		desc = formatMultiRules(schedule.rules).replace(/\n/g, ' · ') || 'multiple times';
	} else if (schedule.kind === 'hourly') {
		desc = `every hour${schedule.time ? ` from ${schedule.time} each day` : ''}`;
	} else if (schedule.kind === 'interval') {
		const minutes = Number(schedule.intervalMinutes || legacyField(schedule, 'everyMinutes') || (Number(legacyField(schedule, 'everyHours') || 0) * 60) || 0);
		const cadence = minutes % 60 === 0 ? `every ${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `every ${minutes} minutes`;
		// With a start time the count restarts at that time every day (see
		// getScheduleNextRun), so say so instead of implying a continuous cadence.
		desc = `${cadence}${schedule.time ? ` from ${schedule.time} each day` : schedule.startAt ? ` starting ${formatDate(schedule.startAt)}` : ''}`;
	} else if (schedule.kind === 'event') {
		desc = `when ${schedule.event || 'the vault changes'}`;
	} else if (schedule.kind === 'cron') {
		const expression = schedule.expression || '';
		const description = describeCron(expression);
		desc = description === 'Invalid cron expression' ? `cron ${expression || '(empty)'}` : `${description} · ${expression}`;
	} else if (schedule.kind === 'once') {
		const at = schedule.at || job.nextRunAt;
		desc = at ? `once at ${formatDate(at)}` : 'once (time pending)';
	} else {
		desc = job.nextRunAt ? formatDate(job.nextRunAt) : 'not scheduled';
	}

	if (schedule.maxIterations && Number(schedule.maxIterations) > 0) {
		desc += ` · runs for ${schedule.maxIterations} time${Number(schedule.maxIterations) === 1 ? '' : 's'} then done`;
	}
	return desc;
}

/**
 * Calculates all scheduled run times for a given schedule within a date range [start, end].
 * Capped by max to prevent runaway on high-frequency schedules.
 */
export function getScheduleOccurrencesInRange(
	schedule: TaskSchedule | null | undefined,
	start: Date,
	end: Date,
	max = 100,
): Date[] {
	if (!schedule || schedule.kind === 'event') return [];
	if (schedule.kind === 'once') {
		if (!schedule.at) return [];
		const date = new Date(schedule.at);
		if (!Number.isNaN(date.getTime()) && date >= start && date <= end) {
			return [date];
		}
		return [];
	}
	const occurrences: Date[] = [];
	let cursor = new Date(start.getTime() - 1000);
	const seen = new Set<number>();
	while (occurrences.length < max) {
		const nextIso = getScheduleNextRun(schedule, cursor);
		if (!nextIso) break;
		const nextDate = new Date(nextIso);
		const timeMs = nextDate.getTime();
		if (Number.isNaN(timeMs) || nextDate > end) break;
		if (!seen.has(timeMs)) {
			seen.add(timeMs);
			occurrences.push(nextDate);
		}
		cursor = new Date(Math.max(timeMs + 1000, cursor.getTime() + 1000));
	}
	return occurrences;
}


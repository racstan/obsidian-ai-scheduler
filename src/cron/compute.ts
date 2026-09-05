/*
 * Cron schedule computation: match, next, prev, upcoming.
 *
 * The algorithm resolves candidates field by field (month, then day, then
 * hour, then minute) using local wall-clock setters, which keeps behaviour
 * predictable across DST transitions: a scheduled wall time that does not
 * exist on a transition day is skipped, and an ambiguous wall time fires once.
 * Searches are bounded so impossible expressions (e.g. `0 0 30 2 *`) return
 * null instead of looping forever.
 */
import { CronExpression, parseCron } from './parse';

const MAX_SEARCH_YEARS = 4;
// Each loop iteration advances at least one minute or jumps a field level, so
// a generous guard only ever fires on malformed input that still parses.
const MAX_ITERATIONS = 1_000_000;

function dayMatches(expression: CronExpression, date: Date): boolean {
	const domOk = expression.dom.includes(date.getDate());
	const dowOk = expression.dow.includes(date.getDay());
	if (expression.domRestricted && expression.dowRestricted) return domOk || dowOk;
	if (expression.domRestricted) return domOk;
	if (expression.dowRestricted) return dowOk;
	return true;
}

function nextDayStart(date: Date): Date {
	const next = new Date(date.getTime());
	next.setDate(next.getDate() + 1);
	next.setHours(0, 0, 0, 0);
	return next;
}

function prevDayEnd(date: Date): Date {
	const previous = new Date(date.getTime());
	previous.setDate(previous.getDate() - 1);
	previous.setHours(23, 59, 0, 0);
	return previous;
}

function firstAllowedMinuteAtOrAfter(expression: CronExpression, date: Date, after: boolean): Date {
	const minutes = expression.minute;
	const current = date.getMinutes();
	if (after) {
		const candidate = minutes.find(minute => minute > current);
		if (candidate !== undefined) {
			const next = new Date(date.getTime());
			next.setMinutes(candidate, 0, 0);
			return next;
		}
		// Past the last allowed minute of this hour: try the next allowed hour.
		return nextAllowedHourStart(expression, date);
	}
	const candidate = [...minutes].reverse().find(minute => minute < current);
	if (candidate !== undefined) {
		const previous = new Date(date.getTime());
		previous.setMinutes(candidate, 0, 0);
		return previous;
	}
	// Roll to the previous allowed hour's last allowed minute; the loop
	// re-checks the hour field from there.
	const previous = new Date(date.getTime());
	previous.setHours(date.getHours() - 1, minutes[minutes.length - 1], 0, 0);
	return previous;
}

function nextAllowedHourStart(expression: CronExpression, date: Date): Date {
	const current = date.getHours();
	const candidate = expression.hour.find(hour => hour > current);
	if (candidate !== undefined) {
		const next = new Date(date.getTime());
		next.setHours(candidate, expression.minute[0], 0, 0);
		return next;
	}
	return nextDayStart(date);
}

function prevAllowedHourEnd(expression: CronExpression, date: Date): Date {
	const current = date.getHours();
	const candidate = [...expression.hour].reverse().find(hour => hour < current);
	const lastMinute = expression.minute[expression.minute.length - 1];
	if (candidate !== undefined) {
		const previous = new Date(date.getTime());
		previous.setHours(candidate, lastMinute, 0, 0);
		return previous;
	}
	return prevDayEnd(date);
}

function daysInMonth(year: number, monthIndex: number): number {
	return new Date(year, monthIndex + 1, 0).getDate();
}

function nextAllowedMonthStart(expression: CronExpression, date: Date): Date {
	const current = date.getMonth() + 1;
	const year = date.getFullYear();
	const candidate = expression.month.find(month => month > current);
	const month = candidate !== undefined ? candidate : expression.month[0];
	const monthYear = candidate !== undefined ? year : year + 1;
	return new Date(monthYear, month - 1, 1, 0, 0, 0, 0);
}

function prevAllowedMonthEnd(expression: CronExpression, date: Date): Date {
	const current = date.getMonth() + 1;
	const year = date.getFullYear();
	const candidate = [...expression.month].reverse().find(month => month < current);
	const month = candidate !== undefined ? candidate : expression.month[expression.month.length - 1];
	const monthYear = candidate !== undefined ? year : year - 1;
	return new Date(monthYear, month - 1, daysInMonth(monthYear, month - 1), 23, 59, 0, 0);
}

/** True when `date` falls exactly on a scheduled slot (second precision ignored). */
export function cronMatches(expression: CronExpression | string, date: Date): boolean {
	const parsed = typeof expression === 'string' ? parseCron(expression) : expression;
	return parsed.minute.includes(date.getMinutes())
		&& parsed.hour.includes(date.getHours())
		&& parsed.month.includes(date.getMonth() + 1)
		&& dayMatches(parsed, date);
}

/** The next scheduled instant strictly after `from`, or null within the search bound. */
export function cronNext(expression: CronExpression | string, from: Date = new Date()): Date | null {
	const parsed = typeof expression === 'string' ? parseCron(expression) : expression;
	let candidate = new Date(from.getTime());
	candidate.setSeconds(0, 0);
	if (candidate.getTime() <= from.getTime()) candidate = new Date(candidate.getTime() + 60000);
	const limitYear = from.getFullYear() + MAX_SEARCH_YEARS;
	for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
		if (candidate.getFullYear() > limitYear) return null;
		if (!parsed.month.includes(candidate.getMonth() + 1)) {
			candidate = nextAllowedMonthStart(parsed, candidate);
			continue;
		}
		if (!dayMatches(parsed, candidate)) {
			candidate = nextDayStart(candidate);
			continue;
		}
		if (!parsed.hour.includes(candidate.getHours())) {
			candidate = nextAllowedHourStart(parsed, candidate);
			continue;
		}
		if (!parsed.minute.includes(candidate.getMinutes())) {
			candidate = firstAllowedMinuteAtOrAfter(parsed, candidate, true);
			continue;
		}
		return candidate;
	}
	return null;
}

/** The most recent scheduled instant strictly before `from`, or null within the search bound. */
export function cronPrev(expression: CronExpression | string, from: Date = new Date()): Date | null {
	const parsed = typeof expression === 'string' ? parseCron(expression) : expression;
	let candidate = new Date(from.getTime());
	candidate.setSeconds(0, 0);
	if (candidate.getTime() >= from.getTime()) candidate = new Date(candidate.getTime() - 60000);
	const limitYear = from.getFullYear() - MAX_SEARCH_YEARS;
	for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
		if (candidate.getFullYear() < limitYear) return null;
		if (!parsed.month.includes(candidate.getMonth() + 1)) {
			candidate = prevAllowedMonthEnd(parsed, candidate);
			continue;
		}
		if (!dayMatches(parsed, candidate)) {
			candidate = prevDayEnd(candidate);
			continue;
		}
		if (!parsed.hour.includes(candidate.getHours())) {
			candidate = prevAllowedHourEnd(parsed, candidate);
			continue;
		}
		if (!parsed.minute.includes(candidate.getMinutes())) {
			candidate = firstAllowedMinuteAtOrAfter(parsed, candidate, false);
			continue;
		}
		return candidate;
	}
	return null;
}

/** The next `count` scheduled instants after `from`. */
export function cronUpcoming(expression: CronExpression | string, count: number, from: Date = new Date()): Date[] {
	const runs: Date[] = [];
	let cursor = from;
	for (let index = 0; index < count; index++) {
		const next = cronNext(expression, cursor);
		if (!next) break;
		runs.push(next);
		cursor = new Date(next.getTime() + 1);
	}
	return runs;
}

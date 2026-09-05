/*
 * Minimal, dependency-free cron expression parser for 5-field expressions.
 *
 * Semantics follow the classic vixie-cron / cron-parser conventions used by
 * obsidian-cron: star, lists, inclusive ranges (a-b), steps (a-b/n, star/n,
 * a/n), month names (JAN-DEC), weekday names (SUN-SAT), Sunday as 0 or 7,
 * and the standard OR rule when both day-of-month and day-of-week are
 * restricted. Expressions evaluate in the user's local time.
 */
export class CronParseError extends Error {}

export interface CronExpression {
	/** Original expression string. */
	expression: string;
	/** Allowed minutes 0-59, sorted. */
	minute: number[];
	/** Allowed hours 0-23, sorted. */
	hour: number[];
	/** Allowed days of month 1-31, sorted. */
	dom: number[];
	/** Allowed months 1-12, sorted. */
	month: number[];
	/** Allowed days of week 0-6 (Sunday 0), sorted. */
	dow: number[];
	/** True when the day-of-month field is a restriction (not a bare `*`). */
	domRestricted: boolean;
	/** True when the day-of-week field is a restriction (not a bare `*`). */
	dowRestricted: boolean;
}

const FIELD_NAMES = ['minute', 'hour', 'day of month', 'month', 'day of week'];
const FIELD_BOUNDS: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function fieldName(index: number): string {
	return FIELD_NAMES[index];
}

function parseValue(text: string, index: number): number {
	const trimmed = text.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed);
	const lower = trimmed.toLowerCase();
	const names = index === 3 ? MONTH_NAMES : index === 4 ? DOW_NAMES : null;
	if (names) {
		const offset = index === 3 ? 1 : 0;
		const exact = names.indexOf(lower);
		if (exact >= 0) return exact + offset;
		if (lower.length >= 3) {
			const matches = names.map((name, position) => name.startsWith(lower) ? position + offset : -1).filter(value => value >= 0);
			if (matches.length === 1) return matches[0];
			if (matches.length > 1) throw new CronParseError(`Field ${index + 1} (${fieldName(index)}): "${trimmed}" is ambiguous.`);
		}
	}
	throw new CronParseError(`Field ${index + 1} (${fieldName(index)}): "${trimmed}" is not a valid value.`);
}

function expandRange(min: number, max: number, step: number, lo: number, hi: number): number[] {
	const values: number[] = [];
	if (min <= max) {
		for (let value = min; value <= max; value += step) values.push(value);
	} else {
		// Wrapping range, e.g. FRI-MON or NOV-FEB: walk the calendar wrap.
		let value = min;
		for (;;) {
			values.push(value);
			if (value === max) break;
			value = value + 1 > hi ? lo : value + 1;
		}
	}
	return values;
}

function parseField(field: string, index: number): { values: number[]; wildcard: boolean } {
	const [lo, hi] = FIELD_BOUNDS[index];
	const parts = field.split(',');
	if (parts.some(part => part.trim() === '')) {
		throw new CronParseError(`Field ${index + 1} (${fieldName(index)}): empty list element.`);
	}
	const collected = new Set<number>();
	let wildcard = false;
	for (const rawPart of parts) {
		const part = rawPart.trim();
		let rangePart = part;
		let step = 1;
		const slash = part.indexOf('/');
		if (slash >= 0) {
			rangePart = part.slice(0, slash);
			const stepText = part.slice(slash + 1);
			if (!/^\d+$/.test(stepText) || Number(stepText) === 0) {
				throw new CronParseError(`Field ${index + 1} (${fieldName(index)}): step "${stepText}" must be a positive integer.`);
			}
			step = Number(stepText);
		}
		let min: number;
		let max: number;
		if (rangePart === '*') {
			min = lo;
			max = hi;
			if (parts.length === 1 && slash < 0) wildcard = true;
		} else if (rangePart === '') {
			throw new CronParseError(`Field ${index + 1} (${fieldName(index)}): missing value before step.`);
		} else {
			const dash = rangePart.indexOf('-');
			if (dash >= 0) {
				min = parseValue(rangePart.slice(0, dash), index);
				max = parseValue(rangePart.slice(dash + 1), index);
			} else {
				min = parseValue(rangePart, index);
				max = slash >= 0 ? hi : min;
			}
			if (min < lo || min > hi) {
				throw new CronParseError(`Field ${index + 1} (${fieldName(index)}): ${min} is out of range ${lo}-${hi}.`);
			}
			if (max < lo || max > hi) {
				throw new CronParseError(`Field ${index + 1} (${fieldName(index)}): ${max} is out of range ${lo}-${hi}.`);
			}
		}
		expandRange(min, max, step, lo, hi).forEach(value => collected.add(value));
	}
	let values = [...collected];
	if (index === 4) values = values.map(value => (value === 7 ? 0 : value));
	values = [...new Set(values)].sort((a, b) => a - b);
	return { values, wildcard };
}

export function parseCron(expression: string): CronExpression {
	const source = String(expression || '').trim().replace(/\s+/g, ' ');
	if (!source) throw new CronParseError('Cron expression is empty.');
	const fields = source.split(' ');
	if (fields.length !== 5) {
		throw new CronParseError(`A cron expression needs 5 fields (minute hour day-of-month month day-of-week); got ${fields.length}.`);
	}
	const [minute, hour, dom, month, dow] = fields.map((field, index) => parseField(field, index));
	return {
		expression: source,
		minute: minute.values,
		hour: hour.values,
		dom: dom.values,
		month: month.values,
		dow: dow.values,
		domRestricted: !dom.wildcard,
		dowRestricted: !dow.wildcard,
	};
}

/** Returns null when the expression is valid, otherwise a human-readable error. */
export function validateCron(expression: string): string | null {
	try {
		parseCron(expression);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

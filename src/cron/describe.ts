/*
 * Human-readable rendering of cron expressions, used by the planner results
 * table, the job editor, and schedule notes. Common patterns get polished
 * phrasing; everything else falls back to a composed field description.
 */
import { CronExpression, parseCron } from './parse';
import { cronUpcoming } from './compute';

const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (value: number): string => String(value).padStart(2, '0');

function clockTime(minute: number[], hour: number[]): string {
	return `${pad(hour[0])}:${pad(minute[0])}`;
}

function isUniformStep(values: number[], lo: number, hi: number): number | null {
	if (values.length < 2) return null;
	const step = values[1] - values[0];
	if (step <= 1) return null;
	for (let index = 0; index < values.length; index++) {
		if (values[index] !== lo + index * step) return null;
	}
	return values[values.length - 1] + step > hi ? step : null;
}

function rangesToList(values: number[]): Array<[number, number]> {
	const runs: Array<[number, number]> = [];
	for (const value of values) {
		const last = runs[runs.length - 1];
		if (last && last[1] + 1 === value) last[1] = value;
		else runs.push([value, value]);
	}
	return runs;
}

function joinNatural(items: string[]): string {
	if (items.length <= 1) return items.join('');
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function nameList(values: number[], names: string[], long: boolean): string {
	return joinNatural(rangesToList(values).map(([start, end]) => {
		if (start === end) return names[start];
		if (end - start >= 2) return `${names[start]}${long ? '' : ''} to ${names[end]}`;
		return `${names[start]} and ${names[end]}`;
	}));
}

function numberList(values: number[], noun: string): string {
	return joinNatural(rangesToList(values).map(([start, end]) => {
		if (start === end) return `${noun} ${start}`;
		return `${noun}s ${start} to ${end}`;
	}));
}

function timePhrase(expression: CronExpression): string {
	const { minute, hour } = expression;
	if (minute.length === 60 && hour.length === 24) return 'Every minute';
	const minuteStep = isUniformStep(minute, 0, 59);
	if (minuteStep && hour.length === 24) return `Every ${minuteStep} minutes`;
	const hourStep = isUniformStep(hour, 0, 23);
	if (hourStep && minute.length === 1) {
		return `Every ${hourStep === 1 ? 'hour' : `${hourStep} hours`}${minute[0] === 0 ? '' : ` at :${pad(minute[0])}`}`;
	}
	if (minute.length === 1 && hour.length === 1) return `at ${clockTime(minute, hour)}`;
	if (hour.length === 1) return `at ${pad(hour[0])} past ${joinNatural(minute.map(value => String(value)))}`;
	return `at minute ${joinNatural(minute.slice(0, 4).map(value => String(value)))}${minute.length > 4 ? ' and more' : ''} past hour ${joinNatural(hour.map(value => String(value)))}`;
}

function dayPhrase(expression: CronExpression): string {
	const domDays = expression.domRestricted ? expression.dom : null;
	const dowDays = expression.dowRestricted ? expression.dow : null;
	if (domDays && dowDays) {
		return `on ${numberList(domDays, 'day')} or ${nameList(dowDays, DOW_SHORT, false)}`;
	}
	if (domDays) {
		if (domDays.length === 31) return 'every day';
		return `on ${numberList(domDays, 'day')} of the month`;
	}
	if (dowDays) {
		if (dowDays.length === 7) return 'every day';
		return `on ${nameList(dowDays, DOW_LONG, true)}`;
	}
	return 'every day';
}

function monthPhrase(expression: CronExpression): string {
	if (expression.month.length === 12) return '';
	const names = rangesToList(expression.month).map(([start, end]) => {
		if (start === end) return MONTH_LONG[start - 1];
		return `${MONTH_LONG[start - 1]} to ${MONTH_LONG[end - 1]}`;
	});
	return ` in ${joinNatural(names)}`;
}

/** A short human-readable description, e.g. "Every 15 minutes" or "at 09:00, on Monday to Friday". */
export function describeCron(expression: string): string {
	let parsed: CronExpression;
	try {
		parsed = parseCron(expression);
	} catch (_) {
		return 'Invalid cron expression';
	}
	const dayPart = dayPhrase(parsed);
	const text = `${timePhrase(parsed)}${dayPart === 'every day' ? '' : `, ${dayPart}`}${monthPhrase(parsed)}`;
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Local "YYYY-MM-DD HH:mm" rendering used in schedule tables. */
export function formatLocalRun(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Formatted upcoming runs for preview tables; null means the expression is invalid or never matches. */
export function describeCronUpcoming(expression: string, count = 3, from: Date = new Date()): string[] | null {
	try {
		parseCron(expression);
	} catch (_) {
		return null;
	}
	const runs = cronUpcoming(expression, count, from);
	return runs.length ? runs.map(formatLocalRun) : null;
}

export { MONTH_SHORT, DOW_SHORT };

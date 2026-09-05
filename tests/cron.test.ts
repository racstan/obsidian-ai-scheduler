import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronMatches, cronNext, cronPrev, cronUpcoming, parseCron, validateCron } from '../src/cron';
import { describeCron, describeCronUpcoming, formatLocalRun } from '../src/cron/describe';

// Expectations are built with local Date constructors so the non-DST tests
// pass in any timezone. The DST-specific tests at the bottom require the
// runner (scripts/run-tests.mjs) to pin TZ=America/New_York.

function at(year: number, month1: number, day: number, hour = 0, minute = 0): Date {
	return new Date(year, month1 - 1, day, hour, minute, 0, 0);
}

test('parseCron expands lists, ranges, steps and names', () => {
	const parsed = parseCron('0,30 9-17 */2 * MON,FRI');
	assert.deepEqual(parsed.minute, [0, 30]);
	assert.deepEqual(parsed.hour, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
	assert.deepEqual(parsed.dom, [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31]);
	assert.deepEqual(parsed.month, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
	assert.deepEqual(parsed.dow, [1, 5]);
	assert.equal(parsed.dowRestricted, true);
});

test('parseCron treats 7 as Sunday and bare stars as unrestricted', () => {
	const parsed = parseCron('* * * * 7');
	assert.deepEqual(parsed.dow, [0]);
	assert.equal(parsed.dowRestricted, true);
	const plain = parseCron('*/15 * * * *');
	assert.equal(plain.domRestricted, false);
	assert.equal(plain.dowRestricted, false);
});

test('parseCron accepts wrapping ranges', () => {
	// FRI-MON walks the calendar wrap: Fri, Sat, Sun(7 -> 0), Mon.
	assert.deepEqual(parseCron('0 9 * * 5-1').dow, [0, 1, 5, 6]);
	assert.deepEqual(parseCron('0 0 * NOV-FEB *').month, [1, 2, 11, 12]);
});

test('parseCron rejects malformed expressions with useful messages', () => {
	assert.match(validateCron('')!, /empty/i);
	assert.match(validateCron('* * * *')!, /5 fields/);
	assert.match(validateCron('* * * * * *')!, /5 fields/);
	assert.match(validateCron('60 * * * *')!, /out of range/);
	assert.match(validateCron('*/0 * * * *')!, /step/);
	assert.match(validateCron('0 9 * * FOO')!, /not a valid value/);
	assert.match(validateCron('0 9 * *')!, /5 fields/);
	assert.equal(validateCron('*/15 * * * *'), null);
});

test('cronMatches checks minute, hour, month and day fields', () => {
	assert.equal(cronMatches('*/15 * * * *', at(2026, 9, 5, 14, 15)), true);
	assert.equal(cronMatches('*/15 * * * *', at(2026, 9, 5, 14, 16)), false);
	assert.equal(cronMatches('0 9 * * 1-5', at(2026, 9, 7, 9, 0)), true); // Monday
	assert.equal(cronMatches('0 9 * * 1-5', at(2026, 9, 6, 9, 0)), false); // Sunday
});

test('cronNext advances to the next matching slot strictly after `from`', () => {
	assert.equal(cronNext('*/15 * * * *', at(2026, 9, 5, 10, 7))!.getTime(), at(2026, 9, 5, 10, 15).getTime());
	assert.equal(cronNext('*/15 * * * *', at(2026, 9, 5, 10, 15))!.getTime(), at(2026, 9, 5, 10, 30).getTime());
	assert.equal(cronNext('30 9 * * *', at(2026, 9, 5, 10, 0))!.getTime(), at(2026, 9, 6, 9, 30).getTime());
	assert.equal(cronNext('0 9 * * 1-5', at(2026, 9, 5, 12, 0))!.getTime(), at(2026, 9, 7, 9, 0).getTime());
	assert.equal(cronNext('0 0 1 1 *', at(2026, 9, 5, 12, 0))!.getTime(), at(2027, 1, 1, 0, 0).getTime());
});

test('cronNext honours steps, lists and seconds truncation', () => {
	assert.equal(cronNext('15-45/15 * * * *', at(2026, 9, 5, 10, 0))!.getTime(), at(2026, 9, 5, 10, 15).getTime());
	assert.equal(cronNext('15-45/15 * * * *', at(2026, 9, 5, 10, 16))!.getTime(), at(2026, 9, 5, 10, 30).getTime());
	assert.equal(cronNext('15-45/15 * * * *', at(2026, 9, 5, 10, 46))!.getTime(), at(2026, 9, 5, 11, 15).getTime());
	assert.equal(cronNext('0,30 10 * * *', at(2026, 9, 5, 10, 31))!.getTime(), at(2026, 9, 6, 10, 0).getTime());
	assert.equal(cronNext('*/15 * * * *', new Date(2026, 8, 5, 10, 15, 20, 500))!.getTime(), at(2026, 9, 5, 10, 30).getTime());
});

test('cronNext supports weekday and month names', () => {
	assert.equal(cronNext('0 9 * * mon-fri', at(2026, 9, 5, 12, 0))!.getTime(), at(2026, 9, 7, 9, 0).getTime());
	assert.equal(cronNext('0 0 * JAN *', at(2026, 9, 5, 12, 0))!.getTime(), at(2027, 1, 1, 0, 0).getTime());
});

test('cronNext handles Sunday as 0 and 7', () => {
	assert.equal(cronNext('0 12 * * 7', at(2026, 9, 1, 0, 0))!.getTime(), at(2026, 9, 6, 12, 0).getTime());
	assert.equal(cronNext('0 12 * * 0', at(2026, 9, 1, 0, 0))!.getTime(), at(2026, 9, 6, 12, 0).getTime());
});

test('cronNext applies the standard OR rule when both day fields are restricted', () => {
	// 0 9 13 * 5 -> 09:00 on every Friday or on the 13th.
	assert.equal(cronNext('0 9 13 * 5', at(2026, 9, 1, 10, 0))!.getTime(), at(2026, 9, 4, 9, 0).getTime());
	assert.equal(cronNext('0 9 13 * 5', at(2026, 9, 5, 10, 0))!.getTime(), at(2026, 9, 11, 9, 0).getTime());
	assert.equal(cronNext('0 9 13 * 5', at(2026, 9, 12, 10, 0))!.getTime(), at(2026, 9, 13, 9, 0).getTime());
});

test('cronNext handles leap years and impossible dates', () => {
	assert.equal(cronNext('0 0 29 2 *', at(2026, 6, 1, 0, 0))!.getTime(), at(2028, 2, 29, 0, 0).getTime());
	assert.equal(cronNext('0 0 29 2 *', at(2028, 3, 1, 0, 0))!.getTime(), at(2032, 2, 29, 0, 0).getTime());
	assert.equal(cronNext('0 0 30 2 *', at(2026, 6, 1, 0, 0)), null);
});

test('cronPrev finds the most recent slot strictly before `from`', () => {
	assert.equal(cronPrev('30 9 * * *', at(2026, 9, 5, 10, 0))!.getTime(), at(2026, 9, 5, 9, 30).getTime());
	assert.equal(cronPrev('30 9 * * *', at(2026, 9, 5, 9, 0))!.getTime(), at(2026, 9, 4, 9, 30).getTime());
	assert.equal(cronPrev('*/15 * * * *', at(2026, 9, 5, 10, 0))!.getTime(), at(2026, 9, 5, 9, 45).getTime());
	assert.equal(cronPrev('0 9 * * 1-5', at(2026, 9, 7, 8, 0))!.getTime(), at(2026, 9, 4, 9, 0).getTime());
});

test('next and prev round-trip on matching slots', () => {
	const expressions = ['*/15 * * * *', '30 9 * * *', '0 9 * * 1-5', '0 0 29 2 *', '15 14 1 * *', '0 */3 * * *', '5 4 * 2 3'];
	const starts = [at(2026, 9, 5, 8, 3), at(2026, 12, 31, 23, 59), at(2027, 2, 27, 12, 0), at(2026, 2, 28, 6, 30)];
	for (const expression of expressions) {
		for (const start of starts) {
			const next = cronNext(expression, start);
			assert.ok(next, `${expression} should have a next run`);
			assert.ok(next.getTime() > start.getTime());
			assert.equal(cronMatches(expression, next), true, `${expression} next slot must match`);
			const prev = cronPrev(expression, next);
			assert.ok(prev, `${expression} should have a previous run`);
			assert.ok(prev.getTime() < next.getTime());
			assert.equal(cronMatches(expression, prev), true, `${expression} prev slot must match`);
			// Loose bound: quadrennial schedules (Feb 29) legitimately reach back years.
			assert.ok(prev.getTime() > start.getTime() - 4 * 366 * 24 * 3600 * 1000);
			const upcoming = cronUpcoming(expression, 3, start);
			assert.equal(upcoming.length, 3);
			assert.ok(upcoming[1].getTime() > upcoming[0].getTime());
			assert.ok(upcoming[2].getTime() > upcoming[1].getTime());
		}
	}
});

test('describeCron renders common patterns in plain English', () => {
	assert.equal(describeCron('*/15 * * * *'), 'Every 15 minutes');
	assert.equal(describeCron('* * * * *'), 'Every minute');
	assert.equal(describeCron('30 9 * * *'), 'At 09:30');
	assert.equal(describeCron('0 9 * * 1-5'), 'At 09:00, on Monday to Friday');
	assert.equal(describeCron('0 9 1 * *'), 'At 09:00, on day 1 of the month');
	assert.equal(describeCron('0 9 * * 1,3,5'), 'At 09:00, on Monday, Wednesday and Friday');
	assert.equal(describeCron('not a cron'), 'Invalid cron expression');
});

test('describeCronUpcoming formats local run times', () => {
	const runs = describeCronUpcoming('30 9 * * *', 2, at(2026, 9, 5, 10, 0));
	assert.deepEqual(runs, ['2026-09-06 09:30', '2026-09-07 09:30']);
	assert.equal(describeCronUpcoming('0 0 30 2 *', 3, at(2026, 9, 5)), null);
	assert.equal(formatLocalRun(at(2026, 9, 5, 14, 5)), '2026-09-05 14:05');
});

// --- DST-specific behaviour (requires TZ=America/New_York) ---

test('nonexistent spring-forward wall times are skipped', () => {
	// 2026-03-08: clocks jump 02:00 -> 03:00 in America/New_York, so 02:30
	// does not exist. The job runs on the following day instead.
	const next = cronNext('30 2 * * *', at(2026, 3, 8, 0, 0));
	assert.equal(next!.getTime(), at(2026, 3, 9, 2, 30).getTime());
	assert.equal(formatLocalRun(next!), '2026-03-09 02:30');
});

test('ambiguous fall-back wall times fire once at the first occurrence', () => {
	// 2026-11-01: 01:30 happens twice (EDT then EST). The schedule resolves
	// to the earlier instant.
	const next = cronNext('30 1 * * *', at(2026, 11, 1, 0, 0));
	assert.equal(formatLocalRun(next!), '2026-11-01 01:30');
	assert.equal(next!.getTime(), Date.UTC(2026, 10, 1, 5, 30));
});

test('unambiguous times around fall-back resolve to the real instants', () => {
	const next = cronNext('0 2 * * *', at(2026, 11, 1, 0, 0));
	assert.equal(next!.getTime(), Date.UTC(2026, 10, 1, 7, 0));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs } from '../src/ics';
import { normalizeJob } from '../src/settings';

const from = new Date(2026, 9, 8, 0, 0);
const to = new Date(2026, 9, 11, 0, 0); // three days

test('buildIcs lists each run of enabled time-based tasks as an event', () => {
	const daily = normalizeJob({ id: 'daily', title: 'Morning brief', prompt: 'Summarize', createdAt: '2026-10-01T00:00:00.000Z', schedule: { kind: 'daily', time: '07:00' } });
	const paused = normalizeJob({ id: 'paused', title: 'Paused', prompt: 'p', enabled: false, schedule: { kind: 'daily', time: '08:00' } });
	const event = normalizeJob({ id: 'event', title: 'On change', prompt: 'p', schedule: { kind: 'event', event: 'modify' } });
	const ics = buildIcs([daily, paused, event], from, to);
	assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
	assert.equal(ics.split('BEGIN:VEVENT').length - 1, 3, 'three daily runs, nothing for paused or event tasks');
	assert.ok(ics.includes('SUMMARY:AI: Morning brief'));
	const firstStart = new Date(2026, 9, 8, 7, 0).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	assert.ok(ics.includes(`UID:daily-${firstStart}@ai-scheduler`), 'UIDs are stable per task and run');
	assert.equal(buildIcs([daily], from, to), buildIcs([daily], from, to), 'output is deterministic');
});

test('buildIcs escapes text and folds long lines', () => {
	const job = normalizeJob({ title: 'Plan; review, then\nsummarize', prompt: 'x'.repeat(300), schedule: { kind: 'daily', time: '09:00' } });
	const ics = buildIcs([job], from, to);
	assert.ok(ics.includes('SUMMARY:AI: Plan\\; review\\, then\\nsummarize'));
	for (const line of ics.split('\r\n')) {
		assert.ok(new TextEncoder().encode(line).length <= 75, `line too long: ${line.slice(0, 30)}…`);
	}
	assert.ok(ics.includes('\r\n x'), 'long DESCRIPTION is folded onto continuation lines');
});

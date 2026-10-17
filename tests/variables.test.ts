import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateFormatter, VariableContext, changedSince, expandVariables, hasVariables } from '../src/variables';

// A tiny stand-in for moment covering the patterns used here.
const format: DateFormatter = (date, pattern) => {
	const pad = (n: number) => String(n).padStart(2, '0');
	const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
	return pattern
		.replace('GGGG-[W]WW', `${date.getFullYear()}-W??`)
		.replace('YYYY', String(date.getFullYear()))
		.replace('MM', pad(date.getMonth() + 1))
		.replace('DD', pad(date.getDate()))
		.replace('HH', pad(date.getHours()))
		.replace('mm', pad(date.getMinutes()))
		.replace('dddd', days[date.getDay()]);
};

function context(overrides: Partial<VariableContext> = {}): VariableContext {
	return {
		now: new Date(2026, 9, 17, 9, 5),
		format,
		taskTitle: 'Daily summary',
		lastRun: new Date(2026, 9, 16, 9, 0),
		dailyNotePath: () => 'Daily/2026-10-17.md',
		changedNotes: () => ['Projects/Alpha.md', 'Inbox.md'],
		...overrides,
	};
}

test('date variables are filled in, including custom formats', () => {
	const text = 'Today {{date}} at {{time}}, yesterday {{yesterday}}, tomorrow {{tomorrow}}, {{weekday}}, {{month}}, {{date:DD.MM.YYYY}}';
	assert.equal(
		expandVariables(text, context()),
		'Today 2026-10-17 at 09:05, yesterday 2026-10-16, tomorrow 2026-10-18, Saturday, 2026-10, 17.10.2026',
	);
});

test('yesterday crosses month boundaries by calendar day', () => {
	assert.equal(expandVariables('{{yesterday}}', context({ now: new Date(2026, 10, 1, 0, 30) })), '2026-10-31');
});

test('task, last run, daily note and changed notes', () => {
	assert.equal(expandVariables('{{task}} since {{last_run}}', context()), 'Daily summary since 2026-10-16 09:00');
	assert.equal(expandVariables('{{last_run}}', context({ lastRun: null })), 'never');
	assert.equal(expandVariables('See {{daily_note}}', context()), 'See [[Daily/2026-10-17]]');
	assert.equal(expandVariables('{{changed_notes}}', context()), '- [[Projects/Alpha]]\n- [[Inbox]]');
	assert.equal(expandVariables('{{changed_notes}}', context({ changedNotes: () => [] })), '(no notes changed)');
});

test('changed notes are only looked up when the text uses them', () => {
	let calls = 0;
	const counting = context({ changedNotes: () => { calls++; return []; } });
	expandVariables('{{date}} only', counting);
	assert.equal(calls, 0);
	expandVariables('{{changed_notes}}', counting);
	assert.equal(calls, 1);
});

test('long changed-note lists are capped', () => {
	const many = Array.from({ length: 60 }, (_, index) => `Note ${index}.md`);
	const lines = expandVariables('{{changed_notes}}', context({ changedNotes: () => many })).split('\n');
	assert.equal(lines.length, 51);
	assert.equal(lines[50], '- …and 10 more');
});

test('unknown variables and other plugins\' syntax pass through unchanged', () => {
	const text = '{{title}} <% tp.date.now() %> {{ unknown }} {single}';
	assert.equal(expandVariables(text, context()), text);
	assert.equal(hasVariables(text), false);
	assert.equal(hasVariables('Since {{ last_run }}'), true);
});

test('file names stay valid: no slashes, colons or links', () => {
	assert.equal(expandVariables('{{date:YYYY/MM}} {{time}}', context(), true), '2026-10 09-05');
	assert.equal(expandVariables('{{daily_note}} notes', context(), true), '2026-10-17 notes');
	assert.equal(expandVariables('{{changed_notes}}', context(), true), '{{changed_notes}}');
});

test('changedSince falls back to the last day for a first run', () => {
	const now = new Date(2026, 9, 17, 9, 0);
	assert.equal(changedSince(null, now).getTime(), now.getTime() - 24 * 60 * 60 * 1000);
	const last = new Date(2026, 9, 10);
	assert.equal(changedSince(last, now), last);
});

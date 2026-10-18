import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	CalendarEvent,
	describeEvent,
	desiredRunEvents,
	eventKey,
	eventMatches,
	formatEvents,
	nextMeetingTrigger,
	parseApiEvent,
	planRunSync,
	runEventId,
} from '../src/google/calendar';
import { emailFromIdToken } from '../src/google/auth';
import { normalizeJob, parseStoredData } from '../src/settings';
import { describeSchedule, getScheduleNextRun, waitsForTrigger } from '../src/schedule';
import { reconcileAfterRun } from '../src/engine';

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
	id: 'e1',
	calendarId: 'primary',
	title: 'Team standup',
	start: '2026-10-19T09:00:00.000Z',
	end: '2026-10-19T09:15:00.000Z',
	allDay: false,
	...overrides,
});

test('Calendar API events are parsed, cancelled ones dropped', () => {
	const parsed = parseApiEvent({
		id: 'abc',
		status: 'confirmed',
		summary: 'Design review',
		start: { dateTime: '2026-10-19T10:00:00+02:00' },
		end: { dateTime: '2026-10-19T11:00:00+02:00' },
		location: 'Room 4',
		hangoutLink: 'https://meet.google.com/x',
		attendees: [{ email: 'me@x.com', self: true, responseStatus: 'declined' }, { displayName: 'Sam' }, { email: 'jo@x.com' }, { email: 'room@x.com', resource: true }],
	}, 'primary');
	assert.ok(parsed);
	assert.equal(parsed.title, 'Design review');
	assert.equal(parsed.allDay, false);
	assert.equal(parsed.link, 'https://meet.google.com/x');
	assert.deepEqual(parsed.attendees, ['Sam', 'jo@x.com']);
	assert.equal(parsed.declined, true);
	assert.equal(parseApiEvent({ id: 'gone', status: 'cancelled' }, 'primary'), null);
	const allDay = parseApiEvent({ id: 'd', start: { date: '2026-10-20' }, end: { date: '2026-10-21' } }, 'primary');
	assert.equal(allDay?.allDay, true);
	assert.equal(allDay?.title, '(No title)');
	assert.equal(new Date(allDay!.start).getDate(), 20, 'all-day events start at local midnight');
});

test('Events are formatted for prompts', () => {
	const hhmm = (date: Date) => date.toISOString().slice(11, 16);
	assert.equal(formatEvents([], hhmm), '(No events.)');
	const text = formatEvents([event({ location: 'Zoom', attendees: ['Sam', 'Jo'] }), event({ id: 'e2', title: 'Holiday', allDay: true })], hhmm);
	assert.equal(text, '- 09:00–09:15 Team standup (Zoom) with Sam, Jo\n- all day Holiday');
	const many = formatEvents([event({ attendees: Array.from({ length: 10 }, (_, index) => `P${index}`) })], hhmm);
	assert.match(many, /and 2 more/);
	const full = describeEvent(event({ description: '<b>Agenda</b>\n\n1. Updates', link: 'https://meet' }), date => date.toISOString());
	assert.match(full, /Title: Team standup/);
	assert.match(full, /Video call: https:\/\/meet/);
	assert.match(full, /Description: Agenda 1\. Updates/);
});

test('Meeting tasks run before matching events, once per event', () => {
	const job = normalizeJob({ title: 'Prep', prompt: 'p', schedule: { kind: 'meeting', minutesBefore: 15, eventMatch: 'standup, 1:1' } });
	assert.equal(job.schedule.minutesBefore, 15);
	assert.equal(job.schedule.eventMatch, 'standup, 1:1');
	assert.equal(job.nextRunAt, null, 'waits for a calendar event');
	assert.ok(waitsForTrigger(job.schedule));
	assert.equal(getScheduleNextRun(job.schedule), null);
	assert.equal(describeSchedule(job), '15 minutes before calendar events with "standup" or "1:1" in the title');
	assert.equal(describeSchedule(normalizeJob({ title: 'T', prompt: 'p', schedule: { kind: 'meeting' } })), '10 minutes before each calendar event');
	assert.equal(describeSchedule(normalizeJob({ title: 'T', prompt: 'p', schedule: { kind: 'meeting', minutesBefore: 60 } })), '1 hour before each calendar event');

	assert.ok(eventMatches(event(), 'STANDUP'));
	assert.ok(eventMatches(event(), ''));
	assert.ok(!eventMatches(event(), 'interview'));
	assert.ok(!eventMatches(event({ allDay: true }), ''), 'all-day events never trigger');
	assert.ok(!eventMatches(event({ declined: true }), ''), 'declined events never trigger');

	const now = new Date('2026-10-19T08:00:00.000Z').getTime();
	const later = event({ id: 'e2', title: '1:1 with Sam', start: '2026-10-19T12:00:00.000Z', end: '2026-10-19T12:30:00.000Z' });
	const other = event({ id: 'e3', title: 'Lunch', start: '2026-10-19T08:30:00.000Z' });
	const next = nextMeetingTrigger(job, [later, other, event()], now);
	assert.equal(next?.event.id, 'e1');
	assert.equal(next?.at, '2026-10-19T08:45:00.000Z');

	job.firedEvents = [eventKey(event())];
	assert.equal(nextMeetingTrigger(job, [later, event()], now)?.event.id, 'e2', 'an event already handled is skipped');

	// Woke up after the trigger time, or the event was added late: runs right away.
	job.firedEvents = [];
	const late = new Date('2026-10-19T08:50:00.000Z').getTime();
	assert.equal(nextMeetingTrigger(job, [event()], late)?.at, new Date(late).toISOString());
	// The event already started: too late.
	assert.equal(nextMeetingTrigger(job, [event()], new Date('2026-10-19T09:01:00.000Z').getTime()), null);

	// After a run the task waits for the next event.
	job.nextRunAt = next!.at;
	reconcileAfterRun(job);
	assert.equal(job.nextRunAt, null);
	assert.equal(job.enabled, true);
});

test('Meeting task fields survive saving and loading', () => {
	const stored = normalizeJob({
		title: 'Prep',
		prompt: 'p',
		schedule: { kind: 'meeting', minutesBefore: 0 },
		triggerEvent: event(),
		firedEvents: ['a', 3, 'b'],
	});
	assert.equal(stored.schedule.minutesBefore, 0);
	assert.equal(describeSchedule(stored), 'at the start of each calendar event');
	assert.equal(stored.triggerEvent?.title, 'Team standup');
	assert.deepEqual(stored.firedEvents, ['a', 'b']);
	const reloaded = normalizeJob(JSON.parse(JSON.stringify(stored)) as Record<string, unknown>);
	assert.deepEqual(reloaded.triggerEvent, stored.triggerEvent);
	assert.equal(normalizeJob({ title: 'T', prompt: 'p', schedule: { kind: 'meeting' }, triggerEvent: { id: 1 } }).triggerEvent, undefined);
	assert.equal(normalizeJob({ title: 'T', prompt: 'p', schedule: { kind: 'daily', time: '09:00', minutesBefore: 5 } }).schedule.minutesBefore, undefined);
});

test('Google settings have safe defaults', () => {
	const { settings } = parseStoredData({ version: 6, settings: { googleRunDays: 500, googleCalendars: ['a', 'a', 7, 'b'], googleClientId: ' id ' }, jobs: [] });
	assert.equal(settings.googleShowRuns, false);
	assert.equal(settings.googleRunDays, 14);
	assert.deepEqual(settings.googleCalendars, ['a', 'b']);
	assert.equal(settings.googleClientId, 'id');
	assert.equal(settings.googleClientSecret, '');
});

test('Run events have stable, valid Google ids and sync by difference', () => {
	const start = new Date('2026-10-19T09:00:00.000Z');
	const id = runEventId('job-1', start);
	assert.equal(id, runEventId('job-1', start));
	assert.notEqual(id, runEventId('job-1', new Date(start.getTime() + 60_000)));
	assert.notEqual(id, runEventId('job-2', start));
	assert.match(id, /^[a-v0-9]{5,1024}$/, 'base32hex, as Google requires');

	const from = new Date('2026-10-19T00:00:00');
	const to = new Date('2026-10-21T23:59:00');
	const daily = normalizeJob({ title: 'Digest', prompt: 'Summarize', schedule: { kind: 'daily', time: '09:00' } }, from);
	const paused = normalizeJob({ title: 'Off', prompt: 'p', enabled: false, schedule: { kind: 'daily', time: '10:00' } }, from);
	const meeting = normalizeJob({ title: 'Prep', prompt: 'p', schedule: { kind: 'meeting' } }, from);
	const limited = normalizeJob({ title: 'Twice', prompt: 'p', runCount: 1, schedule: { kind: 'daily', time: '11:00', maxIterations: 2 } }, from);
	const desired = desiredRunEvents([daily, paused, meeting, limited], from, to);
	assert.equal(desired.filter(entry => entry.jobId === daily.id).length, 3);
	assert.equal(desired.filter(entry => entry.jobId === limited.id).length, 1, 'only the runs left');
	assert.ok(desired.every(entry => entry.jobId !== paused.id && entry.jobId !== meeting.id));
	assert.equal(desired[0].title, 'AI: Digest');
	assert.match(desired[0].description, /Summarize[\s\S]*task #/);

	const plan = planRunSync(desired, [
		{ id: desired[0].id, start: desired[0].start },
		{ id: 'aisstale', start: '2026-10-20T00:00:00.000Z' },
		{ id: 'usermade', start: '2026-10-20T00:00:00.000Z' },
	]);
	assert.equal(plan.create.length, desired.length - 1);
	assert.deepEqual(plan.remove, ['aisstale'], 'only events the plugin made are removed');
});

test('The email is read from the id token', () => {
	const payload = Buffer.from(JSON.stringify({ email: 'ana@example.com' })).toString('base64url');
	assert.equal(emailFromIdToken(`h.${payload}.s`), 'ana@example.com');
	assert.equal(emailFromIdToken('garbage'), undefined);
	assert.equal(emailFromIdToken(undefined), undefined);
});

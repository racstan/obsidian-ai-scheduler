/*
 * Google Calendar (early access): connecting the account, reading events for
 * prompts and "before calendar events" tasks, and keeping an "AI Scheduler"
 * calendar of upcoming runs. The sign-in is kept on the device (not in the
 * synced plugin data), so each computer connects on its own.
 */
import { Platform, moment, requestUrl } from 'obsidian';
import type { AISchedulerPlugin } from '../main';
import { Job } from '../types';
import { errorText } from '../util';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CALENDAR_API } from './config';
import { GoogleClient, GoogleSignInExpired, GoogleTokens, refreshTokens, revokeTokens, signIn } from './auth';
import {
	CalendarEvent,
	describeEvent,
	desiredRunEvents,
	eventKey,
	formatEvents,
	nextMeetingTrigger,
	parseApiEvent,
	planRunSync,
} from './calendar';

const TOKENS_KEY = 'google-tokens';
const APP_CALENDAR_KEY = 'google-app-calendar';
const APP_CALENDAR_NAME = 'AI Scheduler';
/** How often events are read again for meeting tasks. */
const POLL_MS = 5 * 60_000;
/** How long read events are reused for prompts. */
const EVENTS_CACHE_MS = 2 * 60_000;
const DAY_MS = 86_400_000;

type Moment = { format(pattern: string): string; startOf(unit: string): Moment; clone(): Moment; add(amount: number, unit: string): Moment; toDate(): Date; valueOf(): number };
// Obsidian's bundled moment; its typings describe the namespace, not the callable.
const time = (input: Date) => (moment as unknown as (input: Date) => Moment)(input);

export interface GoogleCalendarInfo {
	id: string;
	name: string;
	primary: boolean;
	color?: string;
}

/** {{today_events}} and the others, and the days each covers (from the start of today). */
export const EVENT_VARIABLES: Record<string, { from: number; days: number; withDay: boolean }> = {
	'{{today_events}}': { from: 0, days: 1, withDay: false },
	'{{tomorrow_events}}': { from: 1, days: 1, withDay: false },
	'{{week_events}}': { from: 0, days: 7, withDay: true },
};

export class GoogleCalendarService {
	/** Last problem syncing or reading, shown in the settings. */
	lastError: string | null = null;
	lastSyncAt: number | null = null;
	private syncTimer: number | null = null;
	private syncing: Promise<void> | null = null;
	private resyncQueued = false;
	private lastPollAt = 0;
	private lastRunSignature = '';
	private cache: { from: number; to: number; at: number; key: string; events: CalendarEvent[] } | null = null;
	private refreshing: Promise<GoogleTokens> | null = null;
	private disposed = false;

	constructor(private plugin: AISchedulerPlugin) {}

	/** The OAuth client: the user's own from the settings, or the plugin's. */
	get client(): GoogleClient {
		const own = this.plugin.settings.googleClientId;
		return own
			? { id: own, secret: this.plugin.settings.googleClientSecret }
			: { id: GOOGLE_CLIENT_ID, secret: GOOGLE_CLIENT_SECRET };
	}

	/** An OAuth client is available (the plugin's, or one entered in the settings). */
	get available(): boolean {
		return !!this.client.id;
	}

	get tokens(): GoogleTokens | null {
		const stored = this.plugin.loadDeviceSetting(TOKENS_KEY) as Partial<GoogleTokens> | null;
		return stored && typeof stored.refresh === 'string' && stored.refresh
			? { access: String(stored.access || ''), refresh: stored.refresh, expires: Number(stored.expires) || 0, email: typeof stored.email === 'string' ? stored.email : undefined }
			: null;
	}

	private set tokens(value: GoogleTokens | null) {
		this.plugin.saveDeviceSetting(TOKENS_KEY, value);
	}

	get connected(): boolean {
		return !!this.tokens;
	}

	get email(): string | undefined {
		return this.tokens?.email;
	}

	/** Opens Google's sign-in in the browser and keeps the account on this device. */
	async connect(cancel?: AbortSignal): Promise<void> {
		if (Platform.isMobile) throw new Error('Connect Google Calendar on a computer. Phones and tablets cannot run the sign-in.');
		if (!this.available) throw new Error('No Google client is set up. Enter your own client ID under Advanced.');
		this.tokens = await signIn(this.client, cancel);
		this.lastError = null;
		this.cache = null;
		this.lastRunSignature = '';
		this.requestSync();
	}

	/** Forgets the account on this device and tells Google to revoke access. */
	async disconnect(): Promise<void> {
		const tokens = this.tokens;
		this.tokens = null;
		this.plugin.saveDeviceSetting(APP_CALENDAR_KEY, null);
		this.cache = null;
		this.lastError = null;
		this.lastSyncAt = null;
		this.lastRunSignature = '';
		if (tokens) await revokeTokens(tokens);
	}

	dispose(): void {
		this.disposed = true;
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		this.syncTimer = null;
	}

	private async accessToken(force = false): Promise<string> {
		const tokens = this.tokens;
		if (!tokens) throw new Error('Google Calendar is not connected.');
		if (!force && tokens.access && tokens.expires > Date.now() + 60_000) return tokens.access;
		// One refresh at a time; parallel requests share it.
		this.refreshing ??= refreshTokens(this.client, tokens).finally(() => { this.refreshing = null; });
		try {
			const fresh = await this.refreshing;
			if (this.tokens) this.tokens = fresh;
			return fresh.access;
		} catch (error) {
			if (error instanceof GoogleSignInExpired) {
				this.tokens = null;
				this.lastError = error.message;
			}
			throw error;
		}
	}

	/** A Calendar API request. Retries once with a new access token if Google says it expired. */
	async api<T = Record<string, unknown>>(method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
		const search = new URLSearchParams(query).toString();
		const url = `${CALENDAR_API}${path}${search ? `?${search}` : ''}`;
		for (let attempt = 0; attempt < 2; attempt++) {
			const response = await requestUrl({
				url,
				method,
				headers: { Authorization: `Bearer ${await this.accessToken(attempt > 0)}` },
				...(body !== undefined ? { contentType: 'application/json', body: JSON.stringify(body) } : {}),
				throw: false,
			});
			if (response.status === 401 && attempt === 0) continue;
			if (response.status >= 400) {
				const message = (() => {
					try {
						return String((response.json as { error?: { message?: string } }).error?.message || '');
					} catch {
						return '';
					}
				})();
				throw new GoogleApiError(response.status, message);
			}
			if (response.status === 204 || !response.text) return {} as T;
			return response.json as T;
		}
		throw new GoogleApiError(401, 'Google did not accept the sign-in.');
	}

	/** The user's calendars, main calendar first. */
	async listCalendars(): Promise<GoogleCalendarInfo[]> {
		const calendars: GoogleCalendarInfo[] = [];
		let pageToken = '';
		const appCalendar = this.plugin.loadDeviceSetting(APP_CALENDAR_KEY);
		do {
			const page = await this.api<{ items?: Array<Record<string, unknown>>; nextPageToken?: string }>('GET', '/users/me/calendarList', {
				maxResults: '250',
				...(pageToken ? { pageToken } : {}),
			});
			for (const item of page.items ?? []) {
				if (typeof item.id !== 'string' || item.id === appCalendar) continue;
				calendars.push({
					id: item.id,
					name: stringField(item.summaryOverride) || stringField(item.summary) || item.id,
					primary: item.primary === true,
					...(typeof item.backgroundColor === 'string' ? { color: item.backgroundColor } : {}),
				});
			}
			pageToken = page.nextPageToken ?? '';
		} while (pageToken && calendars.length < 500);
		return calendars.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
	}

	/** Calendars read for prompts and meeting tasks. */
	private readCalendars(): string[] {
		return this.plugin.settings.googleCalendars.length ? this.plugin.settings.googleCalendars : ['primary'];
	}

	/** Events in the chosen calendars between two times, earliest first. */
	async events(from: Date, to: Date): Promise<CalendarEvent[]> {
		const key = this.readCalendars().join('\n');
		const cache = this.cache;
		if (cache && cache.key === key && cache.from <= from.getTime() && cache.to >= to.getTime() && Date.now() - cache.at < EVENTS_CACHE_MS) {
			return cache.events.filter(event => new Date(event.end).getTime() > from.getTime() && new Date(event.start).getTime() < to.getTime());
		}
		const events: CalendarEvent[] = [];
		const problems: string[] = [];
		for (const calendarId of this.readCalendars()) {
			try {
				let pageToken = '';
				let pages = 0;
				do {
					const page = await this.api<{ items?: Array<Record<string, unknown>>; nextPageToken?: string }>('GET', `/calendars/${encodeURIComponent(calendarId)}/events`, {
						timeMin: from.toISOString(),
						timeMax: to.toISOString(),
						singleEvents: 'true',
						orderBy: 'startTime',
						maxResults: '250',
						...(pageToken ? { pageToken } : {}),
					});
					for (const item of page.items ?? []) {
						const event = parseApiEvent(item, calendarId);
						if (event) events.push(event);
					}
					pageToken = page.nextPageToken ?? '';
				} while (pageToken && ++pages < 4);
			} catch (error) {
				// A calendar removed from the account must not hide the others.
				if (error instanceof GoogleApiError && (error.status === 404 || error.status === 403)) problems.push(calendarId);
				else throw error;
			}
		}
		if (problems.length) this.lastError = `Could not read ${problems.length} calendar(s). Check the calendars in the settings.`;
		events.sort((a, b) => a.start.localeCompare(b.start));
		this.cache = { from: from.getTime(), to: to.getTime(), at: Date.now(), key, events };
		return events;
	}

	/**
	 * Fills in {{today_events}}, {{tomorrow_events}}, {{week_events}} and
	 * {{event}} in a task's instructions. Without a connection they say so,
	 * so the AI is not left guessing.
	 */
	async expandVariables(text: string, job: Job, now: Date): Promise<string> {
		let result = text;
		if (result.includes('{{event}}')) {
			result = result.split('{{event}}').join(job.triggerEvent
				? describeEvent(job.triggerEvent, date => time(date).format('ddd D MMM YYYY, HH:mm'))
				: '(No calendar event: this run was not started by one.)');
		}
		const used = Object.keys(EVENT_VARIABLES).filter(name => result.includes(name));
		if (!used.length) return result;
		if (!this.connected) {
			for (const name of used) result = result.split(name).join('(Google Calendar is not connected.)');
			return result;
		}
		const today = time(now).startOf('day');
		const fetchFrom = today.toDate();
		const fetchTo = today.clone().add(7, 'days').toDate();
		let events: CalendarEvent[];
		try {
			events = await this.events(fetchFrom, fetchTo);
		} catch (error) {
			const message = `(Could not read Google Calendar: ${errorText(error)})`;
			for (const name of used) result = result.split(name).join(message);
			return result;
		}
		for (const name of used) {
			const range = EVENT_VARIABLES[name];
			const from = today.clone().add(range.from, 'days').valueOf();
			const to = today.clone().add(range.from + range.days, 'days').valueOf();
			const inRange = events.filter(event => new Date(event.end).getTime() > from && new Date(event.start).getTime() < to);
			result = result.split(name).join(formatEvents(inRange, date => time(date).format('HH:mm'), range.withDay, date => time(date).format('ddd D MMM')));
		}
		return result;
	}

	/** The event a run is for, as context added to a "before calendar events" task. */
	eventContext(job: Job): string | null {
		if (job.schedule.kind !== 'meeting' || !job.triggerEvent) return null;
		return `This run was started by an upcoming Google Calendar event:\n${describeEvent(job.triggerEvent, date => time(date).format('ddd D MMM YYYY, HH:mm'))}`;
	}

	/** Marks the event a meeting task is starting for, so it runs once per event. */
	markFired(job: Job): void {
		if (job.schedule.kind !== 'meeting' || !job.triggerEvent) return;
		const key = eventKey(job.triggerEvent);
		job.firedEvents = [...(job.firedEvents ?? []).filter(entry => entry !== key), key].slice(-50);
		this.pollSoon();
	}

	/** Re-reads events on the next tick (a meeting task was added, changed or just ran). */
	pollSoon(): void {
		this.lastPollAt = 0;
	}

	/**
	 * Called from the plugin's tick: every few minutes, sets when each "before
	 * calendar events" task runs next. Returns true if a task changed.
	 */
	async pollMeetings(skip: (job: Job) => boolean, force = false): Promise<boolean> {
		const meetingJobs = this.plugin.jobs.filter(job => job.enabled && job.schedule.kind === 'meeting' && !skip(job));
		if (!meetingJobs.length || !this.connected) return false;
		const now = Date.now();
		if (!force && now - this.lastPollAt < POLL_MS) return false;
		this.lastPollAt = now;
		let events: CalendarEvent[];
		try {
			const longest = Math.max(...meetingJobs.map(job => Number(job.schedule.minutesBefore ?? 10)));
			events = await this.events(new Date(now - 60 * 60_000), new Date(now + Math.max(DAY_MS, (longest + 60) * 60_000)));
			if (this.lastError?.startsWith('Could not read Google Calendar')) this.lastError = null;
		} catch (error) {
			this.lastError = `Could not read Google Calendar: ${errorText(error)}`;
			return false;
		}
		let changed = false;
		for (const job of meetingJobs) {
			// Started or changed while the events were being read.
			if (skip(job) || !job.enabled || job.schedule.kind !== 'meeting') continue;
			const next = nextMeetingTrigger(job, events, now);
			const nextRunAt = next?.at ?? null;
			const sameEvent = (job.triggerEvent && next ? eventKey(job.triggerEvent) === eventKey(next.event) : !job.triggerEvent && !next);
			if (job.nextRunAt === nextRunAt && sameEvent) continue;
			job.nextRunAt = nextRunAt;
			if (next) job.triggerEvent = next.event;
			else delete job.triggerEvent;
			changed = true;
		}
		return changed;
	}

	/** Brings the "AI Scheduler" calendar up to date soon (debounced), when it is on. */
	requestSync(delay = 5000): void {
		if (this.disposed || !this.plugin.settings.googleShowRuns || !this.connected || !this.plugin.runsTasksHere) return;
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		this.syncTimer = window.setTimeout(() => {
			this.syncTimer = null;
			void this.syncRuns().catch(() => undefined);
		}, delay);
	}

	/** Called hourly from the tick, since the window of days moves with time. */
	syncIfStale(): void {
		if (this.lastSyncAt === null || Date.now() - this.lastSyncAt > 60 * 60_000) this.requestSync(0);
	}

	/** Adds missing runs to the "AI Scheduler" calendar and removes ones that no longer happen. */
	async syncRuns(force = false): Promise<void> {
		if (this.syncing) {
			this.resyncQueued = true;
			return this.syncing;
		}
		this.syncing = (async () => {
			try {
				const now = new Date();
				const to = new Date(now.getTime() + this.plugin.settings.googleRunDays * DAY_MS);
				const desired = desiredRunEvents(this.plugin.jobs, now, to);
				// Nothing changed since the last sync: skip the requests.
				const signature = JSON.stringify([desired.map(event => [event.id, event.title, event.description]), this.plugin.settings.googleRunDays]);
				if (!force && signature === this.lastRunSignature && this.lastSyncAt !== null && Date.now() - this.lastSyncAt < 60 * 60_000) return;
				const calendarId = await this.appCalendar();
				const existing = await this.appCalendarEvents(calendarId, now);
				const plan = planRunSync(desired, existing);
				for (const event of plan.create) await this.putRunEvent(calendarId, event);
				for (const id of plan.remove) await this.deleteEvent(calendarId, id);
				// Titles change when a task is renamed; update those that exist.
				const existingById = new Map(existing.map(event => [event.id, event]));
				for (const event of desired) {
					const current = existingById.get(event.id);
					if (current && (current.title !== event.title || current.description !== event.description)) {
						await this.api('PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${event.id}`, {}, { summary: event.title, description: event.description });
					}
				}
				this.lastRunSignature = signature;
				this.lastSyncAt = Date.now();
				this.lastError = null;
			} catch (error) {
				this.lastError = `Could not update the ${APP_CALENDAR_NAME} calendar: ${errorText(error)}`;
				throw error;
			} finally {
				this.syncing = null;
				if (this.resyncQueued) {
					this.resyncQueued = false;
					this.requestSync();
				}
			}
		})();
		return this.syncing;
	}

	/** Deletes the "AI Scheduler" calendar from Google (when "Show runs" is turned off). */
	async removeRunCalendar(): Promise<void> {
		const id = this.plugin.loadDeviceSetting(APP_CALENDAR_KEY);
		this.plugin.saveDeviceSetting(APP_CALENDAR_KEY, null);
		this.lastRunSignature = '';
		this.lastSyncAt = null;
		if (typeof id !== 'string' || !this.connected) return;
		try {
			await this.api('DELETE', `/calendars/${encodeURIComponent(id)}`);
		} catch (error) {
			if (!(error instanceof GoogleApiError && (error.status === 404 || error.status === 410))) throw error;
		}
	}

	/** The id of the "AI Scheduler" calendar, creating it if it is missing. */
	private async appCalendar(): Promise<string> {
		const stored = this.plugin.loadDeviceSetting(APP_CALENDAR_KEY);
		if (typeof stored === 'string' && stored) {
			try {
				await this.api('GET', `/calendars/${encodeURIComponent(stored)}`);
				return stored;
			} catch (error) {
				// Deleted in Google: make a new one.
				if (!(error instanceof GoogleApiError && (error.status === 404 || error.status === 410 || error.status === 403))) throw error;
			}
		}
		const created = await this.api<{ id?: string }>('POST', '/calendars', {}, {
			summary: APP_CALENDAR_NAME,
			description: 'Upcoming runs of your AI Scheduler tasks in Obsidian. Kept up to date by the plugin; changes made here are replaced.',
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		});
		if (!created.id) throw new Error('Google did not create the calendar.');
		this.plugin.saveDeviceSetting(APP_CALENDAR_KEY, created.id);
		return created.id;
	}

	private async appCalendarEvents(calendarId: string, from: Date): Promise<Array<{ id: string; start: string; title: string; description: string }>> {
		const events: Array<{ id: string; start: string; title: string; description: string }> = [];
		let pageToken = '';
		let pages = 0;
		do {
			const page = await this.api<{ items?: Array<Record<string, unknown>>; nextPageToken?: string }>('GET', `/calendars/${encodeURIComponent(calendarId)}/events`, {
				timeMin: from.toISOString(),
				singleEvents: 'true',
				maxResults: '250',
				...(pageToken ? { pageToken } : {}),
			});
			for (const item of page.items ?? []) {
				const start = (item.start as { dateTime?: string } | undefined)?.dateTime;
				if (typeof item.id === 'string' && start && item.status !== 'cancelled') {
					events.push({ id: item.id, start, title: stringField(item.summary), description: stringField(item.description) });
				}
			}
			pageToken = page.nextPageToken ?? '';
		} while (pageToken && ++pages < 10);
		return events;
	}

	private async putRunEvent(calendarId: string, event: ReturnType<typeof desiredRunEvents>[number]): Promise<void> {
		const body = {
			id: event.id,
			summary: event.title,
			description: event.description,
			start: { dateTime: event.start },
			end: { dateTime: event.end },
			// A run is a reminder for the user, not busy time, and needs no alert.
			transparency: 'transparent',
			reminders: { useDefault: false, overrides: [] },
			status: 'confirmed',
		};
		try {
			await this.api('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, {}, body);
		} catch (error) {
			// The id was used before (a run that was removed and is back): bring it back.
			if (error instanceof GoogleApiError && error.status === 409) {
				await this.api('PUT', `/calendars/${encodeURIComponent(calendarId)}/events/${event.id}`, {}, body);
				return;
			}
			throw error;
		}
	}

	private async deleteEvent(calendarId: string, id: string): Promise<void> {
		try {
			await this.api('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${id}`);
		} catch (error) {
			if (!(error instanceof GoogleApiError && (error.status === 404 || error.status === 410))) throw error;
		}
	}
}

function stringField(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

export class GoogleApiError extends Error {
	constructor(public status: number, detail: string) {
		super(`Google Calendar error ${status}${detail ? `: ${detail}` : ''}`);
	}
}

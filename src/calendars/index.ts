/*
 * Calendar add-ons (beta). The plugin's own calendar works without any of
 * them; these bring outside calendars in:
 * - calendar links: read-only .ics addresses from Google, Outlook, iCloud and
 *   others, no account needed;
 * - Google and Outlook accounts: read events, and keep an "AI Scheduler"
 *   calendar of upcoming runs there.
 * Events feed {{today_events}} and the others, and "before calendar events"
 * tasks. Links and sign-ins are kept on the device, not in the synced data.
 */
import { moment, requestUrl } from 'obsidian';
import type { AISchedulerPlugin } from '../main';
import { Job } from '../types';
import { errorText, id } from '../util';
import { CalendarAccount } from './account';
import { CalendarEvent, describeEvent, desiredRunEvents, eventKey, formatEvents, nextMeetingTrigger, parseIcs } from './events';
import { GoogleAccount } from './google';
import { OutlookAccount } from './outlook';

/** A read-only calendar address (.ics) the user added. */
export interface CalendarLink {
	id: string;
	name: string;
	url: string;
}

const LINKS_KEY = 'calendar-links';
const MAX_LINKS = 20;
/** How often events are read again for meeting tasks. */
const POLL_MS = 5 * 60_000;
/** How long read events are reused. */
const EVENTS_CACHE_MS = 2 * 60_000;
const DAY_MS = 86_400_000;

type Moment = { format(pattern: string): string; startOf(unit: string): Moment; clone(): Moment; add(amount: number, unit: string): Moment; toDate(): Date; valueOf(): number };
// Obsidian's bundled moment; its typings describe the namespace, not the callable.
const time = (input: Date) => (moment as unknown as (input: Date) => Moment)(input);

/** {{today_events}} and the others, and the days each covers (from the start of today). */
export const EVENT_VARIABLES: Record<string, { from: number; days: number; withDay: boolean }> = {
	'{{today_events}}': { from: 0, days: 1, withDay: false },
	'{{tomorrow_events}}': { from: 1, days: 1, withDay: false },
	'{{week_events}}': { from: 0, days: 7, withDay: true },
};

/** A link as typed: webcal:// becomes https://. Throws if it is not a web address. */
export function normalizeLinkUrl(raw: string): string {
	const text = raw.trim().replace(/^webcals?:\/\//i, 'https://');
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new Error('Paste the full calendar address, starting with https:// or webcal://.');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Calendar addresses start with https:// or webcal://.');
	return url.toString();
}

export class CalendarHub {
	readonly google: GoogleAccount;
	readonly outlook: OutlookAccount;
	/** Last problem per link id, shown in the settings. */
	readonly linkErrors = new Map<string, string>();
	private syncTimer: number | null = null;
	private syncing: Promise<void> | null = null;
	private resyncQueued = false;
	private lastPollAt = 0;
	private cache: { from: number; to: number; at: number; key: string; events: CalendarEvent[] } | null = null;
	private disposed = false;

	constructor(private plugin: AISchedulerPlugin) {
		this.google = new GoogleAccount(plugin);
		this.outlook = new OutlookAccount(plugin);
	}

	get accounts(): CalendarAccount[] {
		return [this.google, this.outlook];
	}

	get links(): CalendarLink[] {
		const stored = this.plugin.loadDeviceSetting(LINKS_KEY);
		return Array.isArray(stored)
			? (stored as Array<Partial<CalendarLink>>).filter((link): link is CalendarLink => typeof link?.id === 'string' && typeof link.url === 'string')
				.map(link => ({ id: link.id, url: link.url, name: typeof link.name === 'string' && link.name.trim() ? link.name : 'Calendar' }))
			: [];
	}

	private saveLinks(links: CalendarLink[]): void {
		this.plugin.saveDeviceSetting(LINKS_KEY, links);
		this.forget();
	}

	/** Checks that the address returns a calendar, then adds it. */
	async addLink(name: string, rawUrl: string): Promise<CalendarLink> {
		if (this.links.length >= MAX_LINKS) throw new Error(`Up to ${MAX_LINKS} calendar links can be added.`);
		const url = normalizeLinkUrl(rawUrl);
		if (this.links.some(link => link.url === url)) throw new Error('This calendar link is already added.');
		const now = new Date();
		await this.fetchLink({ id: 'test', name, url }, now, new Date(now.getTime() + DAY_MS));
		const link = { id: id('cal'), name: name.trim() || 'Calendar', url };
		this.saveLinks([...this.links, link]);
		return link;
	}

	removeLink(linkId: string): void {
		this.linkErrors.delete(linkId);
		this.saveLinks(this.links.filter(link => link.id !== linkId));
	}

	/** Any calendar to read from: a link or a connected account. */
	get hasSources(): boolean {
		return this.links.length > 0 || this.accounts.some(account => account.connected);
	}

	/** Read events again on next use (settings changed). */
	forget(): void {
		this.cache = null;
		this.pollSoon();
	}

	dispose(): void {
		this.disposed = true;
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		this.syncTimer = null;
	}

	private async fetchLink(link: CalendarLink, from: Date, to: Date): Promise<CalendarEvent[]> {
		const response = await requestUrl({ url: link.url, method: 'GET', throw: false });
		if (response.status === 401 || response.status === 403 || response.status === 404) {
			throw new Error(`The calendar link was refused (${response.status}). It may have been reset; copy it again from your calendar.`);
		}
		if (response.status >= 400) throw new Error(`The calendar link could not be read (${response.status}).`);
		return parseIcs(response.text, `link:${link.id}`, from, to);
	}

	/** Events from every calendar source between two times, earliest first. */
	async events(from: Date, to: Date): Promise<CalendarEvent[]> {
		const links = this.links;
		const accounts = this.accounts.filter(account => account.connected);
		const key = JSON.stringify([links.map(link => link.url), accounts.map(account => [account.kind, account.settings.calendars])]);
		const cache = this.cache;
		if (cache && cache.key === key && cache.from <= from.getTime() && cache.to >= to.getTime() && Date.now() - cache.at < EVENTS_CACHE_MS) {
			return cache.events.filter(event => new Date(event.end).getTime() > from.getTime() && new Date(event.start).getTime() < to.getTime());
		}
		const events: CalendarEvent[] = [];
		const failures: string[] = [];
		let succeeded = 0;
		for (const link of links) {
			try {
				events.push(...await this.fetchLink(link, from, to));
				this.linkErrors.delete(link.id);
				succeeded++;
			} catch (error) {
				this.linkErrors.set(link.id, errorText(error));
				failures.push(`${link.name}: ${errorText(error)}`);
			}
		}
		for (const account of accounts) {
			try {
				events.push(...await account.readEvents(from, to));
				succeeded++;
			} catch (error) {
				account.lastError = `Could not read ${account.name} Calendar: ${errorText(error)}`;
				failures.push(`${account.name}: ${errorText(error)}`);
			}
		}
		// One broken source must not hide the others; only fail when nothing could be read.
		if (!succeeded && failures.length) throw new Error(failures.join('; '));
		events.sort((a, b) => a.start.localeCompare(b.start));
		this.cache = { from: from.getTime(), to: to.getTime(), at: Date.now(), key, events };
		return events;
	}

	/**
	 * Fills in {{today_events}}, {{tomorrow_events}}, {{week_events}} and
	 * {{event}} in a task's instructions. Without a calendar they say so, so
	 * the AI is not left guessing.
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
		if (!this.hasSources) {
			for (const name of used) result = result.split(name).join('(No calendar is connected.)');
			return result;
		}
		const today = time(now).startOf('day');
		let events: CalendarEvent[];
		try {
			events = await this.events(today.toDate(), today.clone().add(7, 'days').toDate());
		} catch (error) {
			const message = `(Could not read your calendar: ${errorText(error)})`;
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
		return `This run was started by an upcoming calendar event:\n${describeEvent(job.triggerEvent, date => time(date).format('ddd D MMM YYYY, HH:mm'))}`;
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
		if (!meetingJobs.length || !this.hasSources) return false;
		const now = Date.now();
		if (!force && now - this.lastPollAt < POLL_MS) return false;
		this.lastPollAt = now;
		let events: CalendarEvent[];
		try {
			const longest = Math.max(...meetingJobs.map(job => Number(job.schedule.minutesBefore ?? 10)));
			events = await this.events(new Date(now - 60 * 60_000), new Date(now + Math.max(DAY_MS, (longest + 60) * 60_000)));
		} catch {
			// Shown in the settings; tasks keep their times until events can be read again.
			return false;
		}
		let changed = false;
		for (const job of meetingJobs) {
			// Started or changed while the events were being read.
			if (skip(job) || !job.enabled || job.schedule.kind !== 'meeting') continue;
			const next = nextMeetingTrigger(job, events, now);
			const nextRunAt = next?.at ?? null;
			const sameEvent = job.triggerEvent && next ? eventKey(job.triggerEvent) === eventKey(next.event) : !job.triggerEvent && !next;
			if (job.nextRunAt === nextRunAt && sameEvent) continue;
			job.nextRunAt = nextRunAt;
			if (next) job.triggerEvent = next.event;
			else delete job.triggerEvent;
			changed = true;
		}
		return changed;
	}

	/** Accounts that keep an "AI Scheduler" calendar, when this device runs scheduled tasks. */
	private get syncingAccounts(): CalendarAccount[] {
		if (!this.plugin.runsTasksHere) return [];
		return this.accounts.filter(account => account.settings.showRuns && account.connected);
	}

	/** Brings the "AI Scheduler" calendars up to date soon (debounced). */
	requestSync(delay = 5000): void {
		if (this.disposed || !this.syncingAccounts.length) return;
		if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
		this.syncTimer = window.setTimeout(() => {
			this.syncTimer = null;
			void this.syncRuns().catch(() => undefined);
		}, delay);
	}

	/** Called from the tick: hourly, since the window of days moves with time. */
	syncIfStale(): void {
		if (this.syncingAccounts.some(account => account.syncStale)) this.requestSync(0);
	}

	/** Updates the "AI Scheduler" calendar of each account that shows runs (or just `only`). */
	async syncRuns(force = false, only?: CalendarAccount): Promise<void> {
		if (this.syncing) {
			this.resyncQueued = true;
			return this.syncing;
		}
		this.syncing = (async () => {
			try {
				const now = new Date();
				const days = this.plugin.settings.calendarRunDays;
				const desired = desiredRunEvents(this.plugin.jobs, now, new Date(now.getTime() + days * DAY_MS));
				const accounts = only ? [only] : this.syncingAccounts;
				let firstError: unknown = null;
				for (const account of accounts) {
					try {
						await account.syncRuns(desired, now, days, force);
					} catch (error) {
						firstError ??= error;
					}
				}
				if (firstError) throw firstError instanceof Error ? firstError : new Error(errorText(firstError));
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
}

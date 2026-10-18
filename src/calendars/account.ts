/*
 * What Google and Outlook accounts share: the sign-in kept on this device,
 * fresh access tokens, API requests, and keeping an "AI Scheduler" calendar
 * of upcoming runs in step with the tasks.
 */
import { Platform, requestUrl } from 'obsidian';
import type { AISchedulerPlugin } from '../main';
import { errorText } from '../util';
import { CalendarEvent, RunEvent, planRunSync } from './events';
import { OAuthClient, OAuthProvider, OAuthTokens, SignInExpired, refreshTokens, revokeTokens, signIn } from './oauth';

export type AccountKind = 'google' | 'outlook';

export interface CalendarInfo {
	id: string;
	name: string;
	primary: boolean;
	color?: string;
}

/** A run event as it is in the provider's "AI Scheduler" calendar. */
export interface StoredRunEvent {
	/** The plugin's run id (see runEventId). */
	runId: string;
	/** The provider's own id, for changing or deleting it. */
	providerId: string;
	title: string;
	description: string;
}

/** The account's settings, kept in the plugin settings. */
export interface AccountSettings {
	showRuns: boolean;
	calendars: string[];
	clientId: string;
	clientSecret: string;
}

export class CalendarApiError extends Error {
	constructor(name: string, public status: number, detail: string) {
		super(`${name} Calendar error ${status}${detail ? `: ${detail}` : ''}`);
	}
}

export const APP_CALENDAR_NAME = 'AI Scheduler';
export const APP_CALENDAR_DESCRIPTION = 'Upcoming runs of your AI Scheduler tasks in Obsidian. Kept up to date by the plugin; changes made here are replaced.';

export abstract class CalendarAccount {
	abstract readonly kind: AccountKind;
	abstract readonly provider: OAuthProvider;
	/** Base address of the provider's API. */
	protected abstract readonly api: string;
	lastError: string | null = null;
	lastSyncAt: number | null = null;
	private refreshing: Promise<OAuthTokens> | null = null;
	private lastRunSignature = '';

	constructor(protected plugin: AISchedulerPlugin) {}

	/** "Google" or "Outlook". */
	get name(): string {
		return this.provider.name;
	}

	abstract get settings(): AccountSettings;

	get client(): OAuthClient {
		return { id: this.settings.clientId, secret: this.settings.clientSecret };
	}

	/** The user entered their own client. */
	get available(): boolean {
		return !!this.settings.clientId;
	}

	private get tokensKey(): string {
		return `${this.kind}-tokens`;
	}

	protected get appCalendarKey(): string {
		return `${this.kind}-app-calendar`;
	}

	get tokens(): OAuthTokens | null {
		const stored = this.plugin.loadDeviceSetting(this.tokensKey) as Partial<OAuthTokens> | null;
		return stored && typeof stored.refresh === 'string' && stored.refresh
			? { access: String(stored.access || ''), refresh: stored.refresh, expires: Number(stored.expires) || 0, email: typeof stored.email === 'string' ? stored.email : undefined }
			: null;
	}

	private set tokens(value: OAuthTokens | null) {
		this.plugin.saveDeviceSetting(this.tokensKey, value);
	}

	get connected(): boolean {
		return !!this.tokens;
	}

	get email(): string | undefined {
		return this.tokens?.email;
	}

	/** Opens the sign-in in the browser and keeps the account on this device. */
	async connect(cancel?: AbortSignal): Promise<void> {
		if (Platform.isMobile) throw new Error(`Connect ${this.name} Calendar on a computer. Phones and tablets cannot run the sign-in.`);
		if (!this.available) throw new Error(`Enter your ${this.name} client ID first.`);
		this.tokens = await signIn(this.provider, this.client, cancel);
		this.lastError = null;
		this.lastRunSignature = '';
	}

	/** Forgets the account on this device (and revokes access where the provider allows). */
	async disconnect(): Promise<void> {
		const tokens = this.tokens;
		this.tokens = null;
		this.plugin.saveDeviceSetting(this.appCalendarKey, null);
		this.lastError = null;
		this.lastSyncAt = null;
		this.lastRunSignature = '';
		if (tokens) await revokeTokens(this.provider, tokens);
	}

	private async accessToken(force = false): Promise<string> {
		const tokens = this.tokens;
		if (!tokens) throw new Error(`${this.name} Calendar is not connected.`);
		if (!force && tokens.access && tokens.expires > Date.now() + 60_000) return tokens.access;
		// One refresh at a time; parallel requests share it.
		this.refreshing ??= refreshTokens(this.provider, this.client, tokens).finally(() => { this.refreshing = null; });
		try {
			const fresh = await this.refreshing;
			if (this.tokens) this.tokens = fresh;
			return fresh.access;
		} catch (error) {
			if (error instanceof SignInExpired) {
				this.tokens = null;
				this.lastError = error.message;
			}
			throw error;
		}
	}

	/** An API request. Retries once with a new access token if the provider says it expired. */
	async request<T = Record<string, unknown>>(method: string, path: string, query: Record<string, string> = {}, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
		const search = new URLSearchParams(query).toString();
		const url = `${path.startsWith('https://') ? '' : this.api}${path}${search ? `?${search}` : ''}`;
		for (let attempt = 0; attempt < 2; attempt++) {
			const response = await requestUrl({
				url,
				method,
				headers: { ...headers, Authorization: `Bearer ${await this.accessToken(attempt > 0)}` },
				...(body !== undefined ? { contentType: 'application/json', body: JSON.stringify(body) } : {}),
				throw: false,
			});
			if (response.status === 401 && attempt === 0) continue;
			if (response.status >= 400) {
				const message = (() => {
					try {
						const error = (response.json as { error?: { message?: unknown } }).error;
						return typeof error?.message === 'string' ? error.message : '';
					} catch {
						return '';
					}
				})();
				throw new CalendarApiError(this.name, response.status, message);
			}
			if (response.status === 204 || !response.text) return {} as T;
			return response.json as T;
		}
		throw new CalendarApiError(this.name, 401, 'The sign-in was not accepted.');
	}

	/** The user's calendars, main calendar first (not the "AI Scheduler" one). */
	abstract listCalendars(): Promise<CalendarInfo[]>;

	/** Events in the calendars chosen in the settings (or the main one). */
	abstract readEvents(from: Date, to: Date): Promise<CalendarEvent[]>;

	/** Creates the "AI Scheduler" calendar and returns its id. */
	protected abstract createAppCalendar(): Promise<string>;
	/** Whether the stored calendar still exists. */
	protected abstract appCalendarExists(id: string): Promise<boolean>;
	protected abstract deleteAppCalendar(id: string): Promise<void>;
	protected abstract listRunEvents(calendarId: string, from: Date): Promise<StoredRunEvent[]>;
	protected abstract createRunEvent(calendarId: string, event: RunEvent): Promise<void>;
	protected abstract updateRunEvent(calendarId: string, stored: StoredRunEvent, event: RunEvent): Promise<void>;
	protected abstract deleteRunEvent(calendarId: string, stored: StoredRunEvent): Promise<void>;

	/** Whether a stored run event already shows `event`'s title and text. */
	protected sameContent(stored: StoredRunEvent, event: RunEvent): boolean {
		return stored.title === event.title && stored.description === event.description;
	}

	/** The id of the "AI Scheduler" calendar, creating it if it is missing. */
	private async appCalendar(): Promise<string> {
		const stored = this.plugin.loadDeviceSetting(this.appCalendarKey);
		if (typeof stored === 'string' && stored && await this.appCalendarExists(stored)) return stored;
		const created = await this.createAppCalendar();
		this.plugin.saveDeviceSetting(this.appCalendarKey, created);
		return created;
	}

	/** Brings the "AI Scheduler" calendar in line with `desired`. Skipped when nothing changed in the last hour. */
	async syncRuns(desired: RunEvent[], from: Date, days: number, force = false): Promise<void> {
		const signature = JSON.stringify([desired.map(event => [event.id, event.title, event.description]), days]);
		if (!force && signature === this.lastRunSignature && this.lastSyncAt !== null && Date.now() - this.lastSyncAt < 60 * 60_000) return;
		try {
			const calendarId = await this.appCalendar();
			const existing = await this.listRunEvents(calendarId, from);
			const plan = planRunSync(desired, existing.map(event => ({ id: event.runId, start: '' })));
			const byRunId = new Map(existing.map(event => [event.runId, event]));
			for (const event of plan.create) await this.createRunEvent(calendarId, event);
			for (const id of plan.remove) {
				const stored = byRunId.get(id);
				if (stored) await this.deleteRunEvent(calendarId, stored);
			}
			// Titles change when a task is renamed; update those that exist.
			for (const event of desired) {
				const current = byRunId.get(event.id);
				if (current && !this.sameContent(current, event)) {
					await this.updateRunEvent(calendarId, current, event);
				}
			}
			this.lastRunSignature = signature;
			this.lastSyncAt = Date.now();
			this.lastError = null;
		} catch (error) {
			this.lastError = `Could not update the ${APP_CALENDAR_NAME} calendar in ${this.name}: ${errorText(error)}`;
			throw error;
		}
	}

	/** Called hourly, since the window of days moves with time. */
	get syncStale(): boolean {
		return this.lastSyncAt === null || Date.now() - this.lastSyncAt > 60 * 60_000;
	}

	/** Deletes the "AI Scheduler" calendar (when "Show runs" is turned off). */
	async removeRunCalendar(): Promise<void> {
		const id = this.plugin.loadDeviceSetting(this.appCalendarKey);
		this.plugin.saveDeviceSetting(this.appCalendarKey, null);
		this.lastRunSignature = '';
		this.lastSyncAt = null;
		if (typeof id !== 'string' || !this.connected) return;
		try {
			await this.deleteAppCalendar(id);
		} catch (error) {
			if (!(error instanceof CalendarApiError && (error.status === 404 || error.status === 410))) throw error;
		}
	}

	/** Calendar ids read for prompts and meeting tasks. */
	protected readCalendars(fallback: string): string[] {
		return this.settings.calendars.length ? this.settings.calendars : [fallback];
	}
}

export function stringField(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

export function isGone(error: unknown): boolean {
	return error instanceof CalendarApiError && (error.status === 404 || error.status === 410);
}

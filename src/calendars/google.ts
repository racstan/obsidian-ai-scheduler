/* Google Calendar account (beta), through the Google Calendar API. */
import { CalendarEvent, RunEvent, parseGoogleEvent } from './events';
import { APP_CALENDAR_DESCRIPTION, APP_CALENDAR_NAME, AccountSettings, CalendarAccount, CalendarApiError, CalendarInfo, StoredRunEvent, isGone, stringField } from './account';
import { GOOGLE, GOOGLE_API } from './config';

type Page = { items?: Array<Record<string, unknown>>; nextPageToken?: string };

export class GoogleAccount extends CalendarAccount {
	readonly kind = 'google' as const;
	readonly provider = GOOGLE;
	protected readonly api = GOOGLE_API;

	get settings(): AccountSettings {
		const settings = this.plugin.settings;
		return { showRuns: settings.googleShowRuns, calendars: settings.googleCalendars, clientId: settings.googleClientId, clientSecret: settings.googleClientSecret };
	}

	async listCalendars(): Promise<CalendarInfo[]> {
		const calendars: CalendarInfo[] = [];
		const appCalendar = this.plugin.loadDeviceSetting(this.appCalendarKey);
		let pageToken = '';
		do {
			const page = await this.request<Page>('GET', '/users/me/calendarList', { maxResults: '250', ...(pageToken ? { pageToken } : {}) });
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

	async readEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
		const events: CalendarEvent[] = [];
		for (const calendarId of this.readCalendars('primary')) {
			let pageToken = '';
			let pages = 0;
			try {
				do {
					const page = await this.request<Page>('GET', `/calendars/${encodeURIComponent(calendarId)}/events`, {
						timeMin: from.toISOString(),
						timeMax: to.toISOString(),
						singleEvents: 'true',
						orderBy: 'startTime',
						maxResults: '250',
						...(pageToken ? { pageToken } : {}),
					});
					for (const item of page.items ?? []) {
						const event = parseGoogleEvent(item, `google:${calendarId}`);
						if (event) events.push(event);
					}
					pageToken = page.nextPageToken ?? '';
				} while (pageToken && ++pages < 4);
			} catch (error) {
				// A calendar removed from the account must not hide the others.
				if (error instanceof CalendarApiError && (error.status === 404 || error.status === 403)) {
					this.lastError = `Could not read a Google calendar (${calendarId}). Check the calendars to read in the settings.`;
				} else {
					throw error;
				}
			}
		}
		return events;
	}

	protected async createAppCalendar(): Promise<string> {
		const created = await this.request<{ id?: string }>('POST', '/calendars', {}, {
			summary: APP_CALENDAR_NAME,
			description: APP_CALENDAR_DESCRIPTION,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		});
		if (!created.id) throw new Error('Google did not create the calendar.');
		return created.id;
	}

	protected async appCalendarExists(id: string): Promise<boolean> {
		try {
			await this.request('GET', `/calendars/${encodeURIComponent(id)}`);
			return true;
		} catch (error) {
			if (isGone(error) || (error instanceof CalendarApiError && error.status === 403)) return false;
			throw error;
		}
	}

	protected async deleteAppCalendar(id: string): Promise<void> {
		await this.request('DELETE', `/calendars/${encodeURIComponent(id)}`);
	}

	protected async listRunEvents(calendarId: string, from: Date): Promise<StoredRunEvent[]> {
		const events: StoredRunEvent[] = [];
		let pageToken = '';
		let pages = 0;
		do {
			const page = await this.request<Page>('GET', `/calendars/${encodeURIComponent(calendarId)}/events`, {
				timeMin: from.toISOString(),
				singleEvents: 'true',
				maxResults: '250',
				...(pageToken ? { pageToken } : {}),
			});
			for (const item of page.items ?? []) {
				// The plugin's events use the run id as their Google id.
				if (typeof item.id === 'string' && item.status !== 'cancelled') {
					events.push({ runId: item.id, providerId: item.id, title: stringField(item.summary), description: stringField(item.description) });
				}
			}
			pageToken = page.nextPageToken ?? '';
		} while (pageToken && ++pages < 10);
		return events;
	}

	private body(event: RunEvent): Record<string, unknown> {
		return {
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
	}

	protected async createRunEvent(calendarId: string, event: RunEvent): Promise<void> {
		try {
			await this.request('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, {}, this.body(event));
		} catch (error) {
			// The id was used before (a run that was removed and is back): bring it back.
			if (error instanceof CalendarApiError && error.status === 409) {
				await this.request('PUT', `/calendars/${encodeURIComponent(calendarId)}/events/${event.id}`, {}, this.body(event));
				return;
			}
			throw error;
		}
	}

	protected async updateRunEvent(calendarId: string, stored: StoredRunEvent, event: RunEvent): Promise<void> {
		await this.request('PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${stored.providerId}`, {}, { summary: event.title, description: event.description });
	}

	protected async deleteRunEvent(calendarId: string, stored: StoredRunEvent): Promise<void> {
		try {
			await this.request('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${stored.providerId}`);
		} catch (error) {
			if (!isGone(error)) throw error;
		}
	}
}

/* Outlook calendar account (beta), through Microsoft Graph. */
import { CalendarEvent, RunEvent, findMeetingLink } from './events';
import { APP_CALENDAR_NAME, AccountSettings, CalendarAccount, CalendarApiError, CalendarInfo, StoredRunEvent, isGone, stringField } from './account';
import { GRAPH_API, OUTLOOK } from './config';

type Page = { value?: Array<Record<string, unknown>>; '@odata.nextLink'?: string };

/** Extended properties that mark the plugin's events: the run id, and a hash of the text to spot renamed tasks. */
const PROPERTY_SET = '{6f4b7c1e-3a2d-4e8f-9b5a-2c7d1e0f8a34}';
const RUN_ID_PROPERTY = `String ${PROPERTY_SET} Name AiSchedulerRunId`;
const HASH_PROPERTY = `String ${PROPERTY_SET} Name AiSchedulerHash`;
/** Times in UTC, plain text bodies. */
const PREFER = { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' };

function textHash(text: string): string {
	let value = 2166136261;
	for (let index = 0; index < text.length; index++) {
		value ^= text.charCodeAt(index);
		value = Math.imul(value, 16777619) >>> 0;
	}
	return value.toString(36);
}

/** A Graph date-time in UTC ("2026-10-19T09:00:00.0000000") as an ISO string. */
function graphUtc(value: unknown): string | null {
	const text = (value as { dateTime?: unknown } | undefined)?.dateTime;
	if (typeof text !== 'string') return null;
	const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${text}Z`);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** An all-day Graph date as local midnight. */
function graphDay(value: unknown): string | null {
	const text = (value as { dateTime?: unknown } | undefined)?.dateTime;
	const match = typeof text === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(text) : null;
	return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toISOString() : null;
}

/** Turns one Microsoft Graph event into a CalendarEvent, or null for cancelled ones. */
export function parseOutlookEvent(raw: Record<string, unknown>, calendarId: string): CalendarEvent | null {
	if (!raw || raw.isCancelled === true || typeof raw.id !== 'string') return null;
	const allDay = raw.isAllDay === true;
	const start = allDay ? graphDay(raw.start) : graphUtc(raw.start);
	const end = allDay ? graphDay(raw.end) : graphUtc(raw.end);
	if (!start || !end) return null;
	const location = stringField((raw.location as { displayName?: unknown } | undefined)?.displayName).trim();
	const description = stringField(raw.bodyPreview).trim();
	const joinUrl = stringField((raw.onlineMeeting as { joinUrl?: unknown } | undefined)?.joinUrl) || stringField(raw.onlineMeetingUrl);
	const link = joinUrl || findMeetingLink(location, description);
	const attendees = (Array.isArray(raw.attendees) ? raw.attendees as Array<Record<string, unknown>> : [])
		.filter(attendee => attendee.type !== 'resource')
		.map(attendee => {
			const email = attendee.emailAddress as { name?: unknown; address?: unknown } | undefined;
			return stringField(email?.name) || stringField(email?.address);
		})
		.filter(Boolean);
	const response = stringField((raw.responseStatus as { response?: unknown } | undefined)?.response);
	return {
		id: raw.id,
		calendarId,
		title: stringField(raw.subject).trim() || '(No title)',
		start,
		end,
		allDay,
		...(location ? { location } : {}),
		...(description ? { description } : {}),
		...(link ? { link } : {}),
		...(attendees.length ? { attendees } : {}),
		...(response === 'declined' ? { declined: true } : {}),
	};
}

export class OutlookAccount extends CalendarAccount {
	readonly kind = 'outlook' as const;
	readonly provider = OUTLOOK;
	protected readonly api = GRAPH_API;

	get settings(): AccountSettings {
		const settings = this.plugin.settings;
		return { showRuns: settings.outlookShowRuns, calendars: settings.outlookCalendars, clientId: settings.outlookClientId, clientSecret: '' };
	}

	/** All pages of a Graph list. */
	private async all(path: string, query: Record<string, string>, limit = 10): Promise<Array<Record<string, unknown>>> {
		const items: Array<Record<string, unknown>> = [];
		let page = await this.request<Page>('GET', path, query, undefined, PREFER);
		for (let count = 1; ; count++) {
			items.push(...(page.value ?? []));
			const next = page['@odata.nextLink'];
			if (!next || count >= limit) break;
			page = await this.request<Page>('GET', next, {}, undefined, PREFER);
		}
		return items;
	}

	async listCalendars(): Promise<CalendarInfo[]> {
		const appCalendar = this.plugin.loadDeviceSetting(this.appCalendarKey);
		const items = await this.all('/me/calendars', { $top: '100', $select: 'id,name,isDefaultCalendar,hexColor' });
		return items
			.filter(item => typeof item.id === 'string' && item.id !== appCalendar)
			.map(item => ({
				id: item.id as string,
				name: stringField(item.name) || 'Calendar',
				primary: item.isDefaultCalendar === true,
				...(typeof item.hexColor === 'string' && item.hexColor ? { color: item.hexColor } : {}),
			}))
			.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
	}

	async readEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
		const events: CalendarEvent[] = [];
		for (const calendarId of this.readCalendars('default')) {
			const path = calendarId === 'default' ? '/me/calendar/calendarView' : `/me/calendars/${encodeURIComponent(calendarId)}/calendarView`;
			try {
				const items = await this.all(path, {
					startDateTime: from.toISOString(),
					endDateTime: to.toISOString(),
					$top: '250',
					$orderby: 'start/dateTime',
					$select: 'id,subject,start,end,isAllDay,isCancelled,location,onlineMeeting,onlineMeetingUrl,attendees,responseStatus,bodyPreview',
				}, 4);
				for (const item of items) {
					const event = parseOutlookEvent(item, `outlook:${calendarId}`);
					if (event) events.push(event);
				}
			} catch (error) {
				// A calendar removed from the account must not hide the others.
				if (error instanceof CalendarApiError && (error.status === 404 || error.status === 403)) {
					this.lastError = 'Could not read an Outlook calendar. Check the calendars to read in the settings.';
				} else {
					throw error;
				}
			}
		}
		return events;
	}

	protected async createAppCalendar(): Promise<string> {
		const created = await this.request<{ id?: string }>('POST', '/me/calendars', {}, { name: APP_CALENDAR_NAME });
		if (!created.id) throw new Error('Outlook did not create the calendar.');
		return created.id;
	}

	protected async appCalendarExists(id: string): Promise<boolean> {
		try {
			await this.request('GET', `/me/calendars/${encodeURIComponent(id)}`, { $select: 'id' });
			return true;
		} catch (error) {
			if (isGone(error)) return false;
			throw error;
		}
	}

	protected async deleteAppCalendar(id: string): Promise<void> {
		await this.request('DELETE', `/me/calendars/${encodeURIComponent(id)}`);
	}

	protected async listRunEvents(calendarId: string, from: Date): Promise<StoredRunEvent[]> {
		const items = await this.all(`/me/calendars/${encodeURIComponent(calendarId)}/events`, {
			$filter: `start/dateTime ge '${from.toISOString().slice(0, 19)}'`,
			$top: '250',
			$select: 'id,subject',
			$expand: `singleValueExtendedProperties($filter=id eq '${RUN_ID_PROPERTY}' or id eq '${HASH_PROPERTY}')`,
		});
		const events: StoredRunEvent[] = [];
		for (const item of items) {
			const properties = Array.isArray(item.singleValueExtendedProperties) ? item.singleValueExtendedProperties as Array<{ id?: string; value?: string }> : [];
			const value = (name: string) => properties.find(property => property.id?.toLowerCase() === name.toLowerCase())?.value;
			const runId = value(RUN_ID_PROPERTY);
			if (typeof item.id !== 'string' || !runId) continue;
			events.push({ runId, providerId: item.id, title: stringField(item.subject), description: value(HASH_PROPERTY) ?? '' });
		}
		return events;
	}

	protected override sameContent(stored: StoredRunEvent, event: RunEvent): boolean {
		// Outlook rewrites event bodies, so the plugin compares a hash it stored itself.
		return stored.title === event.title && stored.description === textHash(event.description);
	}

	protected async createRunEvent(calendarId: string, event: RunEvent): Promise<void> {
		await this.request('POST', `/me/calendars/${encodeURIComponent(calendarId)}/events`, {}, {
			subject: event.title,
			body: { contentType: 'text', content: event.description },
			start: { dateTime: event.start.slice(0, 19), timeZone: 'UTC' },
			end: { dateTime: event.end.slice(0, 19), timeZone: 'UTC' },
			// A run is a reminder for the user, not busy time, and needs no alert.
			showAs: 'free',
			isReminderOn: false,
			singleValueExtendedProperties: [
				{ id: RUN_ID_PROPERTY, value: event.id },
				{ id: HASH_PROPERTY, value: textHash(event.description) },
			],
		});
	}

	protected async updateRunEvent(_calendarId: string, stored: StoredRunEvent, event: RunEvent): Promise<void> {
		await this.request('PATCH', `/me/events/${encodeURIComponent(stored.providerId)}`, {}, {
			subject: event.title,
			body: { contentType: 'text', content: event.description },
			singleValueExtendedProperties: [{ id: HASH_PROPERTY, value: textHash(event.description) }],
		});
	}

	protected async deleteRunEvent(_calendarId: string, stored: StoredRunEvent): Promise<void> {
		try {
			await this.request('DELETE', `/me/events/${encodeURIComponent(stored.providerId)}`);
		} catch (error) {
			if (!isGone(error)) throw error;
		}
	}
}

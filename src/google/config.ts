/*
 * Google Calendar uses the user's own OAuth client (a "Desktop app" client
 * they create in Google Cloud and enter in the settings), so their data only
 * ever goes between their computer and their own Google project. Sign-in is
 * protected by PKCE and the loopback redirect.
 */

/** Step-by-step guide for creating the OAuth client, linked from the settings. */
export const SETUP_GUIDE_URL = 'https://github.com/racstan/obsidian-ai-scheduler#connect-google-calendar';

/** The permissions to add on the OAuth consent screen (shown in the settings). */
export const GOOGLE_SCOPES = [
	'openid',
	'email',
	// Create and manage only the calendars this plugin makes ("AI Scheduler").
	'https://www.googleapis.com/auth/calendar.app.created',
	// List the user's calendars and read their events, for prompts and meeting triggers.
	'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
	'https://www.googleapis.com/auth/calendar.events.readonly',
];

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

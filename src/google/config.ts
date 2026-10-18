/*
 * The plugin's Google OAuth client (a "Desktop app" client in Google Cloud).
 *
 * For an installed app Google treats the client secret as public: it cannot be
 * kept secret in code that runs on the user's computer, and sign-in is
 * protected by PKCE and the loopback redirect instead. Users can still use
 * their own client from the advanced settings.
 */
export const GOOGLE_CLIENT_ID = '';
export const GOOGLE_CLIENT_SECRET = '';

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

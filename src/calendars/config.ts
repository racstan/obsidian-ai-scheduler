/*
 * Calendar accounts use the user's own OAuth client (a Google Cloud "Desktop
 * app" client, or a Microsoft Entra app registration) entered in the
 * settings, so their data only goes between their computer and their own
 * project. Sign-in is protected by PKCE and the loopback redirect.
 */
import type { OAuthProvider } from './oauth';

const README = 'https://github.com/racstan/obsidian-ai-scheduler';
export const GOOGLE_GUIDE_URL = `${README}#connect-google-calendar`;
export const OUTLOOK_GUIDE_URL = `${README}#connect-outlook-calendar`;
export const LINKS_GUIDE_URL = `${README}#calendar-links`;

export const GOOGLE: OAuthProvider = {
	name: 'Google',
	authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	revokeUrl: 'https://oauth2.googleapis.com/revoke',
	redirectHost: '127.0.0.1',
	scopes: [
		'openid',
		'email',
		// Create and manage only the calendars this plugin makes ("AI Scheduler").
		'https://www.googleapis.com/auth/calendar.app.created',
		// List the user's calendars and read their events, for prompts and meeting triggers.
		'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
		'https://www.googleapis.com/auth/calendar.events.readonly',
	],
	// Always ask, so Google returns a refresh token even when reconnecting.
	authParams: { access_type: 'offline', prompt: 'consent' },
};

export const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';

export const OUTLOOK: OAuthProvider = {
	name: 'Outlook',
	// "common": personal Microsoft accounts and work or school accounts.
	authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
	tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
	redirectHost: 'localhost',
	scopes: ['openid', 'email', 'offline_access', 'https://graph.microsoft.com/Calendars.ReadWrite'],
	authParams: { prompt: 'select_account' },
	scopeInTokenRequest: true,
};

export const GRAPH_API = 'https://graph.microsoft.com/v1.0';

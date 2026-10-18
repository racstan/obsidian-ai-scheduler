/*
 * Google sign-in for a desktop app: the browser opens Google's consent page,
 * Google redirects to a one-time server on 127.0.0.1, and the code is
 * exchanged for tokens with PKCE. Desktop only (it needs Node's http module).
 */
import { requestUrl } from 'obsidian';
import { AUTH_URL, GOOGLE_SCOPES, REVOKE_URL, TOKEN_URL } from './config';

export interface GoogleClient {
	id: string;
	secret: string;
}

export interface GoogleTokens {
	access: string;
	refresh: string;
	/** Epoch ms when the access token expires. */
	expires: number;
	email?: string;
}

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

function base64Url(bytes: Uint8Array): string {
	let text = '';
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes = 32): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return base64Url(new Uint8Array(digest));
}

/** The email in a Google id token (only read, not verified: it is shown to the user, never trusted). */
export function emailFromIdToken(idToken: unknown): string | undefined {
	if (typeof idToken !== 'string') return undefined;
	try {
		const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
		const bytes = Uint8Array.from(atob(payload), char => char.charCodeAt(0));
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { email?: unknown };
		return typeof parsed.email === 'string' ? parsed.email : undefined;
	} catch {
		return undefined;
	}
}

interface NodeServer {
	listen(port: number, host: string, callback: () => void): void;
	address(): { port: number } | string | null;
	close(): void;
	on(event: 'error', callback: (error: Error) => void): void;
}
interface NodeRequest { url?: string }
interface NodeResponse { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void }
type NodeHttp = { createServer(handler: (request: NodeRequest, response: NodeResponse) => void): NodeServer };

function nodeHttp(): NodeHttp {
	const load = (window as unknown as { require?: (name: string) => unknown }).require;
	if (typeof load !== 'function') throw new Error('Connecting Google Calendar needs Obsidian on a computer.');
	return load('http') as NodeHttp;
}

function page(title: string, text: string): string {
	return `<!doctype html><meta charset="utf-8"><title>AI Scheduler</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h2>${title}</h2><p>${text}</p></body>`;
}

/**
 * Signs in to Google in the browser and returns the tokens. `cancel` stops
 * waiting (e.g. the user closed the settings).
 */
export async function signIn(client: GoogleClient, cancel?: AbortSignal): Promise<GoogleTokens> {
	const http = nodeHttp();
	const verifier = randomString(48);
	const state = randomString(16);
	const challenge = await challengeFor(verifier);

	let server: NodeServer | null = null;
	const result = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
		const timer = window.setTimeout(() => finish(new Error('Google sign-in timed out. Try again.')), SIGN_IN_TIMEOUT_MS);
		const finish = (error: Error | null, value?: { code: string; redirect: string }) => {
			window.clearTimeout(timer);
			cancel?.removeEventListener('abort', onAbort);
			// Let the browser receive the page before the server closes.
			window.setTimeout(() => server?.close(), 1000);
			if (error) reject(error);
			else resolve(value as { code: string; redirect: string });
		};
		const onAbort = () => finish(new Error('Google sign-in was cancelled.'));
		cancel?.addEventListener('abort', onAbort);
		let redirect = '';
		server = http.createServer((request, response) => {
			const url = new URL(request.url || '/', redirect);
			if (url.pathname !== '/') {
				response.writeHead(404, { 'Content-Type': 'text/plain' });
				response.end('Not found');
				return;
			}
			const code = url.searchParams.get('code');
			const error = url.searchParams.get('error');
			const ok = !!code && url.searchParams.get('state') === state;
			response.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
			response.end(ok
				? page('Google Calendar is connected', 'You can close this tab and go back to Obsidian.')
				: page('Google Calendar was not connected', error === 'access_denied' ? 'Access was not allowed. You can close this tab.' : 'Something went wrong. Close this tab and try again from Obsidian.'));
			if (ok) finish(null, { code, redirect });
			else finish(new Error(error === 'access_denied' ? 'Google Calendar access was not allowed.' : 'Google sign-in failed. Try again.'));
		});
		server.on('error', error => finish(error));
		// Port 0: the system picks a free port.
		server.listen(0, '127.0.0.1', () => {
			const address = server?.address();
			const port = address && typeof address === 'object' ? address.port : 0;
			redirect = `http://127.0.0.1:${port}`;
			const params = new URLSearchParams({
				client_id: client.id,
				redirect_uri: redirect,
				response_type: 'code',
				scope: GOOGLE_SCOPES.join(' '),
				code_challenge: challenge,
				code_challenge_method: 'S256',
				state,
				access_type: 'offline',
				// Always ask, so Google returns a refresh token even when reconnecting.
				prompt: 'consent',
			});
			window.open(`${AUTH_URL}?${params.toString()}`);
		});
	});

	const response = await tokenRequest({
		grant_type: 'authorization_code',
		code: result.code,
		code_verifier: verifier,
		redirect_uri: result.redirect,
		client_id: client.id,
		...(client.secret ? { client_secret: client.secret } : {}),
	});
	if (typeof response.refresh_token !== 'string') throw new Error('Google did not return a refresh token. Try connecting again.');
	return {
		access: String(response.access_token),
		refresh: response.refresh_token,
		expires: Date.now() + Number(response.expires_in || 3600) * 1000,
		email: emailFromIdToken(response.id_token),
	};
}

/** A new access token from the refresh token. */
export async function refreshTokens(client: GoogleClient, tokens: GoogleTokens): Promise<GoogleTokens> {
	const response = await tokenRequest({
		grant_type: 'refresh_token',
		refresh_token: tokens.refresh,
		client_id: client.id,
		...(client.secret ? { client_secret: client.secret } : {}),
	});
	return {
		...tokens,
		access: String(response.access_token),
		expires: Date.now() + Number(response.expires_in || 3600) * 1000,
		...(typeof response.refresh_token === 'string' ? { refresh: response.refresh_token } : {}),
	};
}

/** Thrown when Google no longer accepts the sign-in (revoked, expired, or the client changed). */
export class GoogleSignInExpired extends Error {
	constructor() {
		super('Google Calendar was disconnected. Connect it again in the AI Scheduler settings.');
	}
}

async function tokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
	const response = await requestUrl({
		url: TOKEN_URL,
		method: 'POST',
		contentType: 'application/x-www-form-urlencoded',
		body: new URLSearchParams(body).toString(),
		throw: false,
	});
	const json = (() => {
		try {
			return response.json as Record<string, unknown>;
		} catch {
			return {};
		}
	})();
	if (response.status === 400 && json.error === 'invalid_grant') throw new GoogleSignInExpired();
	if (response.status >= 400) {
		throw new Error(`Google sign-in failed (${response.status}${typeof json.error === 'string' ? `: ${json.error}` : ''}).`);
	}
	return json;
}

/** Tells Google to forget the sign-in. Failures are ignored: the tokens are deleted locally either way. */
export async function revokeTokens(tokens: GoogleTokens): Promise<void> {
	await requestUrl({
		url: REVOKE_URL,
		method: 'POST',
		contentType: 'application/x-www-form-urlencoded',
		body: new URLSearchParams({ token: tokens.refresh }).toString(),
		throw: false,
	}).catch(() => undefined);
}

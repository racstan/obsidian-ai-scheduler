/*
 * Sign-in for a desktop app (Google and Microsoft): the browser opens the
 * provider's consent page, which redirects to a one-time server on this
 * computer, and the code is exchanged for tokens with PKCE. Desktop only (it
 * needs Node's http module).
 */
import { requestUrl } from 'obsidian';

/** Where and how a provider signs in. */
export interface OAuthProvider {
	/** Shown in messages, e.g. "Google". */
	name: string;
	authUrl: string;
	tokenUrl: string;
	revokeUrl?: string;
	scopes: string[];
	/** Host of the redirect address registered for the client. */
	redirectHost: '127.0.0.1' | 'localhost';
	/** Extra parameters for the consent page. */
	authParams?: Record<string, string>;
	/** Microsoft wants the scopes again when exchanging and refreshing. */
	scopeInTokenRequest?: boolean;
}

export interface OAuthClient {
	id: string;
	/** Empty for clients without one (Microsoft desktop apps). */
	secret: string;
}

export interface OAuthTokens {
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

/** The account's email in an id token (only read, not verified: it is shown to the user, never trusted). */
export function emailFromIdToken(idToken: unknown): string | undefined {
	if (typeof idToken !== 'string') return undefined;
	try {
		const payload = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
		const bytes = Uint8Array.from(atob(payload), char => char.charCodeAt(0));
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { email?: unknown; preferred_username?: unknown };
		if (typeof parsed.email === 'string') return parsed.email;
		return typeof parsed.preferred_username === 'string' ? parsed.preferred_username : undefined;
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
	if (typeof load !== 'function') throw new Error('Connecting a calendar account needs Obsidian on a computer.');
	return load('http') as NodeHttp;
}

function page(title: string, text: string): string {
	return `<!doctype html><meta charset="utf-8"><title>AI Scheduler</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h2>${title}</h2><p>${text}</p></body>`;
}

/**
 * Signs in in the browser and returns the tokens. `cancel` stops waiting
 * (e.g. the user clicked Cancel).
 */
export async function signIn(provider: OAuthProvider, client: OAuthClient, cancel?: AbortSignal): Promise<OAuthTokens> {
	const http = nodeHttp();
	const verifier = randomString(48);
	const state = randomString(16);
	const challenge = await challengeFor(verifier);
	const name = provider.name;

	let server: NodeServer | null = null;
	const result = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
		const timer = window.setTimeout(() => finish(new Error(`${name} sign-in timed out. Try again.`)), SIGN_IN_TIMEOUT_MS);
		const finish = (error: Error | null, value?: { code: string; redirect: string }) => {
			window.clearTimeout(timer);
			cancel?.removeEventListener('abort', onAbort);
			// Let the browser receive the page before the server closes.
			window.setTimeout(() => server?.close(), 1000);
			if (error) reject(error);
			else resolve(value as { code: string; redirect: string });
		};
		const onAbort = () => finish(new Error(`${name} sign-in was cancelled.`));
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
				? page(`${name} Calendar is connected`, 'You can close this tab and go back to Obsidian.')
				: page(`${name} Calendar was not connected`, error === 'access_denied' ? 'Access was not allowed. You can close this tab.' : 'Something went wrong. Close this tab and try again from Obsidian.'));
			if (ok) finish(null, { code, redirect });
			else finish(new Error(error === 'access_denied' ? `${name} Calendar access was not allowed.` : `${name} sign-in failed${error ? ` (${error})` : ''}. Try again.`));
		});
		server.on('error', error => finish(error));
		// Port 0: the system picks a free port.
		server.listen(0, '127.0.0.1', () => {
			const address = server?.address();
			const port = address && typeof address === 'object' ? address.port : 0;
			redirect = `http://${provider.redirectHost}:${port}`;
			const params = new URLSearchParams({
				client_id: client.id,
				redirect_uri: redirect,
				response_type: 'code',
				scope: provider.scopes.join(' '),
				code_challenge: challenge,
				code_challenge_method: 'S256',
				state,
				...provider.authParams,
			});
			window.open(`${provider.authUrl}?${params.toString()}`);
		});
	});

	const response = await tokenRequest(provider, {
		grant_type: 'authorization_code',
		code: result.code,
		code_verifier: verifier,
		redirect_uri: result.redirect,
		client_id: client.id,
		...(client.secret ? { client_secret: client.secret } : {}),
		...(provider.scopeInTokenRequest ? { scope: provider.scopes.join(' ') } : {}),
	});
	if (typeof response.refresh_token !== 'string') throw new Error(`${name} did not return a refresh token. Try connecting again.`);
	return {
		access: String(response.access_token),
		refresh: response.refresh_token,
		expires: Date.now() + Number(response.expires_in || 3600) * 1000,
		email: emailFromIdToken(response.id_token),
	};
}

/** A new access token from the refresh token. */
export async function refreshTokens(provider: OAuthProvider, client: OAuthClient, tokens: OAuthTokens): Promise<OAuthTokens> {
	const response = await tokenRequest(provider, {
		grant_type: 'refresh_token',
		refresh_token: tokens.refresh,
		client_id: client.id,
		...(client.secret ? { client_secret: client.secret } : {}),
		...(provider.scopeInTokenRequest ? { scope: provider.scopes.join(' ') } : {}),
	});
	return {
		...tokens,
		access: String(response.access_token),
		expires: Date.now() + Number(response.expires_in || 3600) * 1000,
		...(typeof response.refresh_token === 'string' ? { refresh: response.refresh_token } : {}),
	};
}

/** Thrown when the provider no longer accepts the sign-in (revoked, expired, or the client changed). */
export class SignInExpired extends Error {
	constructor(name: string) {
		super(`${name} Calendar was disconnected. Connect it again in the AI Scheduler settings.`);
	}
}

async function tokenRequest(provider: OAuthProvider, body: Record<string, string>): Promise<Record<string, unknown>> {
	const response = await requestUrl({
		url: provider.tokenUrl,
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
	if (response.status === 400 && json.error === 'invalid_grant') throw new SignInExpired(provider.name);
	if (response.status >= 400) {
		const detail = typeof json.error_description === 'string' ? json.error_description.split(/\r?\n/)[0] : typeof json.error === 'string' ? json.error : '';
		throw new Error(`${provider.name} sign-in failed (${response.status}${detail ? `: ${detail}` : ''}).`);
	}
	return json;
}

/** Tells the provider to forget the sign-in, where it supports that. Failures are ignored: the tokens are deleted locally either way. */
export async function revokeTokens(provider: OAuthProvider, tokens: OAuthTokens): Promise<void> {
	if (!provider.revokeUrl) return;
	await requestUrl({
		url: provider.revokeUrl,
		method: 'POST',
		contentType: 'application/x-www-form-urlencoded',
		body: new URLSearchParams({ token: tokens.refresh }).toString(),
		throw: false,
	}).catch(() => undefined);
}

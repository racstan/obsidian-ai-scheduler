/* Shared pure helpers ported from the original main.js. */
import { ActivityEntry, Job } from './types';

export const sleep = (ms: number): Promise<void> => new Promise(resolve => window.setTimeout(resolve, ms));

export async function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
	let timer: number | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => {
			reject(new Error(errorMessage));
		}, ms);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer !== undefined) {
			window.clearTimeout(timer);
		}
	}
}

export function validateJobSchema(item: unknown): Record<string, unknown> | null {
	if (!item || typeof item !== 'object') return null;
	const record = item as Record<string, unknown>;
	if (typeof record.title !== 'string' || !record.title.trim()) return null;
	if (typeof record.prompt !== 'string' || !record.prompt.trim()) return null;
	if (!record.schedule || typeof record.schedule !== 'object') return null;
	return record;
}

export function id(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function errorText(error: unknown): string {
	const message = (error as { message?: unknown })?.message;
	return String(message || error);
}

export function localDateKey(date: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localTimestampKey(date: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${localDateKey(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function formatDate(iso: string | null | undefined): string {
	if (!iso) return 'unknown time';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return 'unknown time';
	return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function contentFromMessage(message: unknown): string {
	if (!message) return '';
	const record = message as { content?: unknown; message?: unknown };
	if (typeof record.content === 'string') return record.content;
	if (typeof record.message === 'string') return record.message;
	if (Array.isArray(record.content)) {
		return record.content
			.map(part => typeof part === 'string' ? part : (part as { text?: string } | null)?.text || '')
			.join('');
	}
	return '';
}

function parseJsonCandidate(candidate: string): Record<string, unknown>[] {
	const trimmed = candidate.trim();
	const a = trimmed.indexOf('[');
	const o = trimmed.indexOf('{');
	const start = a < 0 ? o : o < 0 ? a : Math.min(a, o);
	if (start < 0) return [];
	for (let end = trimmed.length; end > start; end--) {
		try {
			const parsed = JSON.parse(trimmed.slice(start, end)) as unknown;
			if (parsed && typeof parsed === 'object') {
				return (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
			}
		} catch { /* keep looking for the end of the JSON value */ }
	}
	return [];
}

/* Extracts JSON plans from an AI reply. Accepts <assistant-scheduler> tags,
 * fenced code blocks, or raw JSON, parsing all tagged blocks if present. */
export function extractJson(text: string): Record<string, unknown>[] {
	const source = String(text || '').trim();
	const results: Record<string, unknown>[] = [];
	const tagRegex = /<assistant-scheduler>\s*([\s\S]*?)\s*<\/assistant-scheduler>/gi;
	let tagMatch: RegExpExecArray | null;
	let foundTag = false;
	while ((tagMatch = tagRegex.exec(source)) !== null) {
		foundTag = true;
		const parsed = parseJsonCandidate(tagMatch[1]);
		if (parsed.length) results.push(...parsed);
	}
	if (foundTag && results.length) return results;

	const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
	let fenceMatch: RegExpExecArray | null;
	while ((fenceMatch = fenceRegex.exec(source)) !== null) {
		const parsed = parseJsonCandidate(fenceMatch[1]);
		if (parsed.length) return parsed;
	}

	return parseJsonCandidate(source);
}

export function isNightlyReviewJob(job: Job): boolean {
	return Boolean(job && job.routine === 'daily-review');
}

export function isDisabledTask(job: Job): boolean {
	return Boolean(job && !isNightlyReviewJob(job) && !job.enabled
		&& (job.status === 'disabled' || job.lastStatus === 'disabled'));
}

export function taskIdentity(job: Job): string {
	return String(job && job.taskNumber || job && job.id || `${job && job.title}\n${job && job.prompt}`);
}

export function describeBinding(job: Job): string {
	return Array.isArray(job && job.contextPaths) && job.contextPaths.length
		? 'Project-based task'
		: 'Independent task';
}

export function summarizeTasks(jobs: Job[]): Job[] {
	const summaries = new Map<string, Job>();
	for (const job of jobs) {
		const key = taskIdentity(job);
		const existing = summaries.get(key);
		if (!existing || new Date(job.lastRunAt || job.createdAt || 0) > new Date(existing.lastRunAt || existing.createdAt || 0)) {
			summaries.set(key, job);
		}
	}
	return [...summaries.values()];
}

export function logActivityEntry(activity: ActivityEntry[], type: string, message: string, jobId: string | null = null): void {
	activity.push({ id: id('event'), at: new Date().toISOString(), type, message, jobId });
	if (activity.length > 50) activity.splice(0, activity.length - 50);
}

/**
 * Sends a native desktop/system notification (Windows Action Center, macOS Notification Center, Linux).
 * Safely requests permission if not yet decided and falls back cleanly in headless/unsupported environments.
 */
export function sendSystemNotification(title: string, body: string): boolean {
	if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
		return false;
	}
	try {
		if (window.Notification.permission === 'granted') {
			new window.Notification(title, { body });
			return true;
		}
		if (window.Notification.permission !== 'denied') {
			void window.Notification.requestPermission().then(permission => {
				if (permission === 'granted') {
					new window.Notification(title, { body });
				}
			});
			return true;
		}
	} catch (error) {
		console.warn('[ai-scheduler] Native system notification dispatch failed:', error);
	}
	return false;
}

export function formatDuration(isoString: string): string {
	const ms = Date.now() - new Date(isoString).getTime();
	if (ms < 0) return '0s';
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remSec = sec % 60;
	return `${min}m ${remSec}s`;
}




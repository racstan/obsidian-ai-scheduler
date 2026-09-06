/* Shared pure helpers ported from the original main.js. */
import { ActivityEntry, Job } from './types';

export const sleep = (ms: number): Promise<void> => new Promise(resolve => window.setTimeout(resolve, ms));

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

/* Extracts JSON plans from an AI reply. Accepts <assistant-scheduler> tags,
 * fenced code blocks, or raw JSON, brute-forcing the parse over shrinking
 * suffixes from the first bracket. */
export function extractJson(text: string): Record<string, unknown>[] {
	const source = String(text || '').trim();
	const candidates: string[] = [];
	const marked = /<assistant-scheduler>\s*([\s\S]*?)\s*<\/assistant-scheduler>/i.exec(source);
	if (marked) candidates.push(marked[1]);
	const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(source);
	if (fenced) candidates.push(fenced[1]);
	candidates.push(source);
	const start = Math.min(...candidates.map(value => {
		const a = value.indexOf('[');
		const o = value.indexOf('{');
		return a < 0 ? o : o < 0 ? a : Math.min(a, o);
	}).filter(value => value >= 0));
	if (Number.isFinite(start) && start >= 0) {
		for (const value of candidates) {
			const trimmed = value.trim();
			for (let end = trimmed.length; end > start; end--) {
				try {
					const parsed = JSON.parse(trimmed.slice(start, end)) as unknown;
					return (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
				} catch { /* keep looking for the end of the JSON value */ }
			}
		}
	}
	return [];
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

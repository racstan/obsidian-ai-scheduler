/* Dashboard search, tag filter and sorting (pure, so it can be unit-tested). */
import { Job } from './types';

export type TaskSort = 'default' | 'next' | 'title' | 'number' | 'recent';

export const SORT_LABELS: Record<TaskSort, string> = {
	default: 'Sort: default',
	next: 'Sort: next run',
	title: 'Sort: title',
	number: 'Sort: task number',
	recent: 'Sort: last run',
};

/** Matches the search text (every word) against title, instructions, tags and #number. */
export function taskMatches(job: Job, query: string, tag: string): boolean {
	if (tag && !(job.tags ?? []).some(candidate => candidate.toLowerCase() === tag.toLowerCase())) return false;
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const haystack = [job.title, job.prompt, `#${job.taskNumber}`, ...(job.tags ?? []).map(t => `#${t} ${t}`)].join(' ').toLowerCase();
	return words.every(word => haystack.includes(word));
}

export function sortTasks(jobs: Job[], sort: TaskSort): Job[] {
	const time = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
	const sorted = [...jobs];
	if (sort === 'next') sorted.sort((a, b) => (time(a.nextRunAt) || Infinity) - (time(b.nextRunAt) || Infinity));
	else if (sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title));
	else if (sort === 'number') sorted.sort((a, b) => (a.taskNumber || 0) - (b.taskNumber || 0));
	else if (sort === 'recent') sorted.sort((a, b) => (time(b.lastRunAt) || 0) - (time(a.lastRunAt) || 0));
	return sorted;
}

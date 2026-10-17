/** A request to the AI that has not gone through yet, kept so the user never has to type it again. */
export interface AIDraft {
	text: string;
	contextPaths: string[];
	resultFolder: string;
	savedAt: string;
	/** Why the last attempt failed, or null when the window was just closed. */
	error: string | null;
}

export const PLANNER_DRAFT = 'planner';
export const MAX_DRAFTS = 20;

/** Drafts for "Update task with AI" are kept per task. */
export function taskDraftKey(jobId: string): string {
	return `task:${jobId}`;
}

/** Keeps valid drafts with text, newest first, up to MAX_DRAFTS. */
export function normalizeDrafts(raw: unknown): Record<string, AIDraft> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const drafts: [string, AIDraft][] = [];
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const record = value as Partial<AIDraft> | null;
		if (!record || typeof record !== 'object' || typeof record.text !== 'string' || !record.text.trim()) continue;
		const savedAt = typeof record.savedAt === 'string' && !Number.isNaN(new Date(record.savedAt).getTime())
			? record.savedAt
			: new Date(0).toISOString();
		drafts.push([key, {
			text: record.text,
			contextPaths: Array.isArray(record.contextPaths) ? record.contextPaths.filter((path): path is string => typeof path === 'string') : [],
			resultFolder: typeof record.resultFolder === 'string' ? record.resultFolder : '',
			savedAt,
			error: typeof record.error === 'string' && record.error ? record.error : null,
		}]);
	}
	drafts.sort((a, b) => b[1].savedAt.localeCompare(a[1].savedAt));
	return Object.fromEntries(drafts.slice(0, MAX_DRAFTS));
}

/** True when the two drafts hold the same request (ignoring when they were saved). */
export function sameDraft(a: Omit<AIDraft, 'savedAt'> | null | undefined, b: Omit<AIDraft, 'savedAt'> | null | undefined): boolean {
	if (!a || !b) return !a && !b;
	return a.text === b.text && a.resultFolder === b.resultFolder && a.error === b.error
		&& a.contextPaths.length === b.contextPaths.length && a.contextPaths.every((path, i) => path === b.contextPaths[i]);
}

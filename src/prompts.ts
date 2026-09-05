/* All AI-facing prompt text in one place. The planner schema is the de-facto
 * contract between the AI and the scheduler; cron is offered as an advanced
 * kind for patterns the simple kinds cannot express. */
import { Job } from './types';
import { formatMultiRules } from './schedule';

export const FOLLOW_UP_INSTRUCTION = 'If this work reveals a concrete future action, you may append at most three follow-up jobs using <assistant-scheduler>[{"title":"...","prompt":"...","schedule":{"kind":"once","at":"ISO-8601"}}]</assistant-scheduler>. Do not create follow-ups unless they are genuinely useful.';

export function contextPrompt(prompt: string, paths: string[]): string {
	const contextPaths = Array.isArray(paths) ? paths : [];
	if (!contextPaths.length) return prompt;
	return `${prompt}\n\nSelected task context:\n${contextPaths.map(path => `- ${path}`).join('\n')}\nUse the attached page/project context and respect the user's backend permissions.`;
}

export function executionPrompt(prompt: string, contextPaths: string[]): string {
	return `${contextPrompt(prompt, contextPaths)}\n\n${FOLLOW_UP_INSTRUCTION}`;
}

export function plannerPrompt(goal: string, contextPaths: string[]): string {
	return [
		'You are the planning brain for an autonomous Obsidian AI Scheduler.',
		'Turn the user goal below into one or more safe, concrete automation jobs.',
		'Return ONLY a JSON array inside <assistant-scheduler> tags. No Markdown outside the tags.',
		'Each item must have: title, prompt, schedule.',
		'schedule must be one of:',
		'- {"kind":"once","at":"ISO-8601 timestamp"}',
		'- {"kind":"daily","time":"HH:MM"}',
		'- {"kind":"weekly","time":"HH:MM","days":[0,1,2,3,4,5,6]}',
		'- {"kind":"multi","rules":[{"days":[1],"times":["02:00"]},{"days":[6],"times":["15:00"]},{"days":[0,2,3,4,5],"times":["01:00","05:00"]}]}',
		'- {"kind":"hourly","maxIterations":8}',
		'- {"kind":"interval","everyMinutes":30,"maxIterations":10}',
		'- {"kind":"interval","everyHours":2,"maxIterations":null}',
		'- {"kind":"event","event":"modify","cooldownMinutes":10}',
		'- {"kind":"cron","expression":"*/15 * * * *"}',
		'Use the user\'s local time. Add output {"folder":"...","filename":"..."} only when a note should be saved.',
		'For "cron", the expression must be a standard 5-field cron expression (minute hour day-of-month month day-of-week, 0 = Sunday) evaluated in the user\'s local time. Prefer the simpler kinds when they can express the pattern; use cron only for advanced cadences such as "every 15 minutes", "weekdays at 9 and 17", or "0 9 * * 1-5". Never invent 6-field expressions.',
		'A prompt should tell the future agent exactly what to do and what vault context to inspect. Multiple requested schedules must become separate jobs or one multi schedule with rules.',
		`Selected context paths:\n${contextPaths.length ? contextPaths.map(path => `- ${path}`).join('\n') : '- None selected'}`,
		`User goal:\n${goal}`,
	].join('\n');
}

export function refinePrompt(job: Job, request: string, contextPaths: string[]): string {
	return [
		'You are editing an existing AI Scheduler job in Obsidian.',
		'Return ONLY one JSON object inside <assistant-scheduler> tags with title, prompt, and schedule.',
		'Preserve the existing schedule unless the user explicitly asks to change it.',
		`Existing job: ${JSON.stringify({ title: job.title, prompt: job.prompt, schedule: job.schedule })}`,
		`Current context paths: ${JSON.stringify(contextPaths)}`,
		`Requested change: ${request}`,
	].join('\n\n');
}

export function reviewPrompt(kind: 'daily' | 'nightly', today: string, fileList: string): string {
	return [
		`You are the user's ${kind === 'nightly' ? 'nightly review' : 'daily preview'} scheduler inside Obsidian.`,
		`Today is ${today}. Review the user's work from today and produce a useful report.`,
		'Use the active backend\'s vault tools to read the listed Markdown files before analyzing them. Respect the user\'s existing permissions and do not access unrelated files.',
		'Do not invent activity. Distinguish facts from suggestions.',
		'Return Markdown only, with these headings: ## Summary, ## Work Completed, ## Important Ideas, ## Open Loops, ## Suggested Next Steps.',
		`Files modified today:\n${fileList}`,
	].join('\n\n');
}

export function describeRulesForPrompt(rules: unknown): string {
	return formatMultiRules(rules);
}

/*
 * Starter task templates. Picking one opens the task editor pre-filled, so the
 * user reviews (and can change) everything before the task is created.
 */
import { JobOutput, TaskSchedule } from './types';

export interface TaskTemplate {
	id: string;
	title: string;
	description: string;
	prompt: string;
	schedule: TaskSchedule;
	output?: JobOutput;
	onlyIfChanged?: boolean;
	tags?: string[];
	/** Shown in the picker: what the user should attach or adjust. */
	tip?: string;
}

export const TASK_TEMPLATES: TaskTemplate[] = [
	{
		id: 'daily-summary',
		title: 'Daily summary',
		description: "Summarizes the notes you changed today and adds it to today's daily note.",
		prompt: 'Read the notes I changed since {{last_run}} and write a short summary of what I worked on: main progress, decisions, and open questions. Use links to the notes.\n\nChanged notes:\n{{changed_notes}}',
		schedule: { kind: 'daily', time: '18:00' },
		output: { mode: 'daily', heading: 'AI summary' },
		onlyIfChanged: true,
		tags: ['review'],
	},
	{
		id: 'weekly-review',
		title: 'Weekly review',
		description: 'Every Friday, reviews the week: what got done, what is open, and what to focus on next week.',
		prompt: 'Review the notes I changed this week ({{week}}). Write a weekly review with these headings: Done, In progress, Open loops, Focus for next week. Link to the notes you mention.\n\nChanged notes:\n{{changed_notes}}',
		schedule: { kind: 'weekly', time: '17:00', days: [5] },
		output: { folder: 'Reviews', filename: 'Weekly review {{week}}', mode: 'replace' },
		tags: ['review'],
	},
	{
		id: 'morning-plan',
		title: 'Morning plan',
		description: "On weekdays, plans your day from yesterday's notes and open tasks, in today's daily note.",
		prompt: "Look at the notes I changed yesterday ({{yesterday}}) and any unchecked tasks in them. Suggest a short, realistic plan for today ({{weekday}}): the top three priorities, then smaller tasks. Keep it under 15 lines.\n\nRecent notes:\n{{changed_notes}}",
		schedule: { kind: 'weekly', time: '08:00', days: [1, 2, 3, 4, 5] },
		output: { mode: 'daily', heading: 'Plan' },
		tags: ['planning'],
	},
	{
		id: 'inbox-triage',
		title: 'Inbox triage',
		description: 'Suggests where each note in your inbox folder belongs, with tags and links.',
		prompt: 'For each note in the attached inbox folder, suggest: which folder it belongs in, two or three tags, and existing notes it should link to. Present it as a table. Do not move or edit any notes.',
		schedule: { kind: 'daily', time: '09:00' },
		output: { folder: 'AI Scheduler', filename: 'Inbox triage', mode: 'replace' },
		onlyIfChanged: true,
		tags: ['inbox'],
		tip: 'Attach your inbox folder with @ or the context picker.',
	},
	{
		id: 'action-items',
		title: 'Action items from notes',
		description: "Collects action items from the day's notes as checkboxes in one running list.",
		prompt: 'Find concrete action items in the notes I changed since {{last_run}} (things someone needs to do). List each as a Markdown checkbox with the person (if named) and a link to the note it came from. If there are none, write "No new action items."\n\nChanged notes:\n{{changed_notes}}',
		schedule: { kind: 'daily', time: '17:30' },
		output: { folder: 'AI Scheduler', filename: 'Action items', mode: 'append', heading: '{{date}}' },
		onlyIfChanged: true,
		tags: ['tasks'],
	},
	{
		id: 'flashcards',
		title: 'Flashcards from new notes',
		description: 'Each week, turns what you wrote into question-and-answer flashcards.',
		prompt: 'Create 10 to 20 flashcards from the key facts and ideas in the notes I changed since {{last_run}}. Write each as "Question::Answer" on its own line (works with the Spaced Repetition plugin), grouped under a heading per source note with a link to it.\n\nChanged notes:\n{{changed_notes}}',
		schedule: { kind: 'weekly', time: '19:00', days: [0] },
		output: { folder: 'Flashcards', filename: 'Flashcards {{date}}' },
		onlyIfChanged: true,
		tags: ['learning'],
	},
	{
		id: 'link-suggestions',
		title: 'Link suggestions',
		description: 'Each week, suggests links between your recent notes and older ones.',
		prompt: 'For each note I changed since {{last_run}}, suggest up to three existing notes it should link to, and why in a few words. Only suggest notes that exist. Do not edit any notes.\n\nChanged notes:\n{{changed_notes}}',
		schedule: { kind: 'weekly', time: '18:00', days: [6] },
		output: { folder: 'AI Scheduler', filename: 'Link suggestions', mode: 'replace' },
		onlyIfChanged: true,
		tags: ['maintenance'],
	},
	{
		id: 'monthly-reflection',
		title: 'Monthly reflection',
		description: 'On the first of each month, reflects on the past month: themes, progress and patterns.',
		prompt: 'Reflect on the past month using the notes I changed since {{last_run}}. Write about: recurring themes, what moved forward, what stalled, and one or two suggestions for the coming month.\n\nChanged notes:\n{{changed_notes}}',
		schedule: { kind: 'monthly', time: '09:00', dayOfMonth: 1 },
		output: { folder: 'Reviews', filename: 'Monthly reflection {{month}}', mode: 'replace' },
		tags: ['review'],
	},
];

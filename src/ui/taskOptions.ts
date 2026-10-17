/*
 * Task editor sections: where results are saved (output mode), the run
 * options (retries, time limit, only-if-changed) and the {{variables}} help.
 */
import { App } from 'obsidian';
import { Job, JobOutput, OUTPUT_MODES, OutputMode } from '../types';
import { OUTPUT_MODE_LABELS, outputMode } from '../output';
import { DEFAULT_RETRY_DELAY_MINUTES, MAX_RETRIES } from '../engine';
import { VARIABLE_HELP } from '../variables';
import { linkLabel, makeCard } from './dom';
import { FolderSuggest } from './folderSuggest';

const MODE_HINTS: Record<OutputMode, string> = {
	new: 'Every run saves a new note. A file name is optional; without one the note is named after the date, time and task.',
	replace: 'Every run replaces the same note, so it always holds the latest result.',
	append: 'Every run is added to the end of the note, or under the heading if you give one. The note is created if it does not exist.',
	daily: "Every run is added to today's daily note (from the Daily notes core plugin's folder and date format), at the end or under the heading. A missing daily note is created from your daily note template.",
};

function field(container: HTMLElement, labelText: string, input: HTMLInputElement | HTMLSelectElement): HTMLElement {
	const wrap = container.createDiv();
	const label = wrap.createDiv({ cls: 'ai-scheduler-form-label', text: labelText });
	wrap.appendChild(input);
	linkLabel(label, input);
	return wrap;
}

function textInput(placeholder: string, value: string): HTMLInputElement {
	const input = createEl('input', { type: 'text', placeholder, cls: 'ai-scheduler-input ai-scheduler-form-gap' });
	input.value = value;
	return input;
}

function numberInput(value: number | undefined, min: number, max: number, placeholder: string): HTMLInputElement {
	const input = createEl('input', { type: 'number', placeholder, cls: 'ai-scheduler-input ai-scheduler-form-gap' });
	input.min = String(min);
	input.max = String(max);
	if (value !== undefined) input.value = String(value);
	return input;
}

/** "Save results" card. Returns a reader for the chosen output (null = all defaults). */
export function renderResultSection(shell: HTMLElement, app: App, output: JobOutput | null): () => JobOutput | null {
	const card = makeCard(shell, 'ai-scheduler-card-tight', 'ai-scheduler-card-flush');
	const lead = card.createDiv({ cls: 'ai-scheduler-lead ai-scheduler-gap-8', text: 'Save results' });

	const modeSelect = card.createEl('select', { cls: 'ai-scheduler-select ai-scheduler-form-gap' });
	linkLabel(lead, modeSelect);
	for (const mode of OUTPUT_MODES) modeSelect.createEl('option', { value: mode, text: OUTPUT_MODE_LABELS[mode] });
	modeSelect.value = outputMode(output);
	const hint = card.createDiv({ cls: 'ai-scheduler-hint ai-scheduler-gap-8' });

	const folderInput = textInput('Default result folder', output?.folder || '');
	new FolderSuggest(app, folderInput);
	const folderField = field(card, 'Folder', folderInput);
	const nameInput = textInput('e.g. Weekly summary, or {{date}} Summary', output?.filename || '');
	const nameField = field(card, 'File name', nameInput);
	const headingInput = textInput('e.g. AI summary (leave empty to add at the end)', output?.heading || '');
	const headingField = field(card, 'Under heading (optional)', headingInput);
	const nameLabel = nameField.querySelector('.ai-scheduler-form-label');

	const update = () => {
		const mode = modeSelect.value as OutputMode;
		hint.setText(MODE_HINTS[mode]);
		folderField.toggleClass('ai-scheduler-hidden', mode === 'daily');
		nameField.toggleClass('ai-scheduler-hidden', mode === 'daily');
		headingField.toggleClass('ai-scheduler-hidden', mode !== 'append' && mode !== 'daily');
		nameLabel?.setText(mode === 'new' ? 'File name (optional)' : 'File name');
		folderInput.placeholder = mode === 'new' || mode === 'replace' ? 'Default result folder' : 'Default result folder, or type a folder';
	};
	modeSelect.onchange = update;
	update();

	return () => {
		const mode = modeSelect.value as OutputMode;
		const result: JobOutput = {};
		if (mode !== 'daily') {
			if (folderInput.value.trim()) result.folder = folderInput.value.trim();
			if (nameInput.value.trim()) result.filename = nameInput.value.trim();
		}
		if ((mode === 'append' || mode === 'daily') && headingInput.value.trim()) result.heading = headingInput.value.trim();
		if (mode !== 'new') result.mode = mode;
		return Object.keys(result).length ? result : null;
	};
}

/** Validation message for an output, or null when it is fine. */
export function validateOutput(output: JobOutput | null): string | null {
	const mode = outputMode(output);
	if ((mode === 'replace' || mode === 'append') && !output?.filename) {
		return `"${OUTPUT_MODE_LABELS[mode]}" needs a file name.`;
	}
	return null;
}

export interface RunOptions {
	retries?: number;
	retryDelayMinutes?: number;
	timeoutMinutes?: number;
	onlyIfChanged?: boolean;
}

function readInt(input: HTMLInputElement, min: number, max: number): number | undefined {
	const raw = input.value.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : undefined;
}

/** "Run options" card. Returns a reader for the options. */
export function renderRunOptions(shell: HTMLElement, job: Job): () => RunOptions {
	const card = makeCard(shell, 'ai-scheduler-card-tight', 'ai-scheduler-card-flush');
	const details = card.createEl('details', { cls: 'ai-scheduler-details' });
	const configured = !!(job.retries || job.timeoutMinutes || job.onlyIfChanged);
	details.open = configured;
	details.createEl('summary', { cls: 'ai-scheduler-lead', text: 'Run options' });

	const row = details.createDiv({ cls: 'ai-scheduler-option-grid' });
	const retries = numberInput(job.retries, 0, MAX_RETRIES, '0');
	field(row, `Retries if a run fails (0-${MAX_RETRIES})`, retries);
	const delay = numberInput(job.retryDelayMinutes, 1, 1440, String(DEFAULT_RETRY_DELAY_MINUTES));
	field(row, 'Minutes between retries', delay);
	const timeout = numberInput(job.timeoutMinutes || undefined, 0, 1440, 'No limit');
	field(row, 'Time limit per run (minutes)', timeout);

	const checkRow = details.createEl('label', { cls: 'ai-scheduler-check-row' });
	const check = checkRow.createEl('input', { type: 'checkbox' });
	check.checked = job.onlyIfChanged === true;
	checkRow.createSpan({ text: 'Only run when something changed' });
	details.createDiv({
		cls: 'ai-scheduler-hint',
		text: 'Skips a run when none of the attached notes or folders changed since the last successful run. With nothing attached, any note in the vault counts. Results the plugin wrote itself never count.',
	});

	return () => ({
		retries: readInt(retries, 0, MAX_RETRIES),
		retryDelayMinutes: readInt(delay, 1, 1440),
		timeoutMinutes: readInt(timeout, 0, 1440) || undefined,
		onlyIfChanged: check.checked ? true : undefined,
	});
}

/** Collapsible list of {{variables}}; clicking one inserts it into `target` at the cursor. */
export function renderVariableHelp(container: HTMLElement, target: HTMLTextAreaElement | HTMLInputElement): void {
	const details = container.createEl('details', { cls: 'ai-scheduler-details ai-scheduler-form-gap' });
	details.createEl('summary', { cls: 'ai-scheduler-hint', text: 'Variables you can use, filled in when the task runs' });
	const list = details.createDiv({ cls: 'ai-scheduler-variable-list' });
	for (const variable of VARIABLE_HELP) {
		const item = list.createDiv({ cls: 'ai-scheduler-variable-item' });
		const button = item.createEl('button', { cls: 'ai-scheduler-variable-chip', text: variable.name });
		button.onclick = event => {
			event.preventDefault();
			const start = target.selectionStart ?? target.value.length;
			const end = target.selectionEnd ?? start;
			target.setRangeText(variable.name, start, end, 'end');
			target.dispatchEvent(new Event('input'));
			target.focus();
		};
		item.createSpan({ cls: 'ai-scheduler-variable-desc', text: variable.description });
	}
}

import { Notice } from 'obsidian';
import { makeButton, makeCard } from './dom';
import { ContextOption } from '../context';

export function createContextPicker(parent: HTMLElement, options: ContextOption[], initialPaths: string[], app: { workspace: { getActiveFile?: () => { path: string } | null } }): { getPaths: () => string[] } {
	const card = makeCard(parent, 'ai-scheduler-card-flush');
	card.createDiv('ai-scheduler-lead').setText('Context for this task');
	card.createDiv('ai-scheduler-picker-desc').setText('Select pages or project folders the active backend should attach when this task runs.');
	const select = card.createEl('select');
	select.multiple = true;
	select.size = 6;
	select.addClass('ai-scheduler-picker-select');
	const known = new Set(options.map(option => option.path));
	for (const path of initialPaths) {
		if (!known.has(path)) options.push({ path, label: `Unavailable: ${path}`, type: 'missing' });
	}
	options.sort((a, b) => a.label.localeCompare(b.label));
	options.forEach(option => {
		const element = select.createEl('option', { value: option.path, text: option.label });
		element.selected = initialPaths.includes(option.path);
	});
	const controls = card.createDiv('ai-scheduler-picker-controls');
	makeButton(controls, 'Use active page', () => {
		const active = app.workspace && app.workspace.getActiveFile && app.workspace.getActiveFile();
		if (!active) { new Notice('No active Markdown page is open.'); return; }
		const option = Array.from(select.options).find(candidate => candidate.value === active.path);
		if (option) option.selected = true;
		else new Notice(`Active page is not available: ${active.path}`);
	});
	makeButton(controls, 'Clear context', () => Array.from(select.options).forEach(option => { option.selected = false; }));
	return { getPaths: () => Array.from(select.selectedOptions).map(option => option.value) };
}

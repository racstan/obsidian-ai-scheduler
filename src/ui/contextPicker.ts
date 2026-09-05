import { Notice } from 'obsidian';
import { styleElement, makeButton, makeCard } from './dom';
import { ContextOption } from '../context';

export function createContextPicker(parent: HTMLElement, options: ContextOption[], initialPaths: string[], app: { workspace: { getActiveFile?: () => { path: string } | null } }): { getPaths: () => string[] } {
	const card = makeCard(parent, { marginBottom: '14px', padding: '12px 14px' });
	styleElement(card.createEl('div', { text: 'Context for this task' }), { fontWeight: '600', marginBottom: '4px' });
	styleElement(card.createEl('div', { text: 'Select pages or project folders the active backend should attach when this task runs.' }), { color: 'var(--text-muted)', fontSize: '12px', marginBottom: '8px' });
	const select = card.createEl('select');
	select.multiple = true;
	select.size = 6;
	styleElement(select, { width: '100%', minHeight: '110px', padding: '6px', background: 'var(--background-primary)', color: 'var(--text-normal)' });
	const known = new Set(options.map(option => option.path));
	for (const path of initialPaths) {
		if (!known.has(path)) options.push({ path, label: `Unavailable: ${path}`, type: 'missing' });
	}
	options.sort((a, b) => a.label.localeCompare(b.label));
	options.forEach(option => {
		const element = select.createEl('option', { value: option.path, text: option.label });
		element.selected = initialPaths.includes(option.path);
	});
	const controls = styleElement(card.createEl('div'), { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' });
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

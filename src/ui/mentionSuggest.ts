/*
 * Autocomplete / @mention suggestion handler for prompt textareas.
 * Enables users to type "@" to search and attach vault notes/files in plain language.
 */
import { App, TFile } from 'obsidian';

export interface MentionSuggestOptions {
	textarea: HTMLTextAreaElement;
	app: App;
	onSelect?: (file: TFile) => void;
}

export function attachMentionSuggest(options: MentionSuggestOptions): () => void {
	const { textarea, app, onSelect } = options;
	let popup: HTMLElement | null = null;
	let selectedIndex = 0;
	let matches: TFile[] = [];
	let queryStartIndex = -1;

	const removePopup = () => {
		if (popup) {
			popup.remove();
			popup = null;
		}
		matches = [];
		selectedIndex = 0;
		queryStartIndex = -1;
	};

	const getVaultFiles = (query: string): TFile[] => {
		const q = query.toLowerCase().trim();
		const all = app.vault.getFiles().filter(f => !f.path.startsWith('.'));
		if (!q) {
			return all.slice(0, 10);
		}
		const filtered = all.filter(f =>
			f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
		);
		filtered.sort((a, b) => {
			const aBase = a.basename.toLowerCase();
			const bBase = b.basename.toLowerCase();
			if (aBase === q) return -1;
			if (bBase === q) return 1;
			if (aBase.startsWith(q) && !bBase.startsWith(q)) return -1;
			if (!aBase.startsWith(q) && bBase.startsWith(q)) return 1;
			return a.path.localeCompare(b.path);
		});
		return filtered.slice(0, 10);
	};

	const insertSelection = (file: TFile) => {
		if (queryStartIndex < 0) return;
		const text = textarea.value;
		const cursor = textarea.selectionStart;
		const before = text.slice(0, queryStartIndex);
		const after = text.slice(cursor);
		const mentionText = `[[${file.basename}]]`;
		textarea.value = `${before}${mentionText} ${after}`;
		const nextCursor = before.length + mentionText.length + 1;
		textarea.setSelectionRange(nextCursor, nextCursor);
		textarea.focus();
		removePopup();
		if (onSelect) {
			onSelect(file);
		}
	};

	const renderPopup = () => {
		if (!matches.length) {
			removePopup();
			return;
		}
		if (!popup) {
			popup = document.createElement('div');
			popup.className = 'ai-scheduler-mention-popup';
			const parent = textarea.parentElement || document.body;
			if (window.getComputedStyle(parent).position === 'static') {
				parent.style.position = 'relative';
			}
			parent.appendChild(popup);
		}
		popup.empty();

		const header = popup.createDiv({ cls: 'ai-scheduler-mention-header' });
		header.createSpan({ text: '📄 Vault files (press Enter to attach)' });

		const list = popup.createDiv({ cls: 'ai-scheduler-mention-list' });
		matches.forEach((file, index) => {
			const item = list.createDiv({
				cls: `ai-scheduler-mention-item ${index === selectedIndex ? 'is-selected' : ''}`,
			});
			item.createSpan({ cls: 'ai-scheduler-mention-icon', text: '📄' });
			const info = item.createDiv({ cls: 'ai-scheduler-mention-info' });
			info.createDiv({ cls: 'ai-scheduler-mention-name', text: file.basename });
			if (file.parent && file.parent.path && file.parent.path !== '/') {
				info.createDiv({ cls: 'ai-scheduler-mention-path', text: file.parent.path });
			}

			item.addEventListener('mousedown', (e) => {
				e.preventDefault();
				insertSelection(file);
			});
		});

		// Scroll selected item into view
		const selectedEl = list.children[selectedIndex] as HTMLElement;
		if (selectedEl) {
			selectedEl.scrollIntoView({ block: 'nearest' });
		}
	};

	const onInput = () => {
		const cursor = textarea.selectionStart;
		const text = textarea.value.slice(0, cursor);
		const atMatch = text.match(/@([^\s@]*)$/);
		if (atMatch && atMatch.index !== undefined) {
			queryStartIndex = atMatch.index;
			const query = atMatch[1];
			matches = getVaultFiles(query);
			selectedIndex = 0;
			renderPopup();
		} else {
			removePopup();
		}
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (!popup || !matches.length) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = (selectedIndex + 1) % matches.length;
			renderPopup();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = (selectedIndex - 1 + matches.length) % matches.length;
			renderPopup();
		} else if (e.key === 'Enter' || e.key === 'Tab') {
			if (matches[selectedIndex]) {
				e.preventDefault();
				insertSelection(matches[selectedIndex]);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			removePopup();
		}
	};

	const onBlur = () => {
		window.setTimeout(() => {
			removePopup();
		}, 200);
	};

	textarea.addEventListener('input', onInput);
	textarea.addEventListener('keydown', onKeyDown);
	textarea.addEventListener('blur', onBlur);

	return () => {
		textarea.removeEventListener('input', onInput);
		textarea.removeEventListener('keydown', onKeyDown);
		textarea.removeEventListener('blur', onBlur);
		removePopup();
	};
}

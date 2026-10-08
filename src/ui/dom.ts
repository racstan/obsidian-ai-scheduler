import { Modal } from 'obsidian';

export function makeButton(parent: HTMLElement, label: string, onClick: (button: HTMLButtonElement) => void | Promise<void>, primary = false, danger = false): HTMLButtonElement {
	const button = parent.createEl('button', { text: label });
	if (primary) button.addClass('mod-cta');
	if (danger) button.addClass('ai-scheduler-button-danger');
	button.onclick = () => { void onClick(button); };
	return button;
}

export function makeCard(parent: HTMLElement, ...extraClasses: string[]): HTMLDivElement {
	const card = parent.createDiv();
	card.addClass('ai-scheduler-card');
	for (const extra of extraClasses) card.addClass(extra);
	return card;
}

/**
 * Returns a refresh function for modals that rebuild their DOM on a timer.
 * It re-renders only when `signature()` changes, never while the user is using
 * a form control inside the modal, and keeps the scroll position of every
 * scrolled element so lists don't jump back to the top.
 */
export function liveRefresh(root: HTMLElement, signature: () => string, render: () => void): () => void {
	let last = signature();
	return () => {
		const next = signature();
		if (next === last) return;
		const active = root.ownerDocument.activeElement;
		if (active && root.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;
		const scrolled: Array<{ key: string; index: number; top: number }> = [];
		const keyOf = (el: Element) => el === root ? ':root' : el.className;
		[root, ...Array.from(root.querySelectorAll('*'))].forEach(el => {
			if (el.scrollTop > 0) {
				const key = keyOf(el);
				const index = el === root ? 0 : Array.from(root.getElementsByClassName(el.className)).indexOf(el);
				scrolled.push({ key, index, top: el.scrollTop });
			}
		});
		last = next;
		render();
		for (const { key, index, top } of scrolled) {
			const el = key === ':root' ? root : (key ? root.getElementsByClassName(key)[index] : undefined);
			if (el) el.scrollTop = top;
		}
	};
}

let labelCounter = 0;

/**
 * Names a form control after its visible label for screen readers. Uses
 * aria-labelledby rather than aria-label, because Obsidian shows every
 * aria-label as a hover tooltip, which duplicates the visible label.
 */
export function linkLabel(label: HTMLElement, control: HTMLElement): void {
	if (!label.id) label.id = `ai-scheduler-label-${++labelCounter}`;
	control.setAttribute('aria-labelledby', label.id);
}

/**
 * Makes a non-button element (badge, cell, chip) behave like a button for
 * keyboard and screen-reader users: focusable, labelled, and activated with
 * Enter or Space as well as by click.
 */
export function makeClickable(el: HTMLElement, label: string, onActivate: (event: Event) => void): void {
	el.setAttribute('role', 'button');
	el.setAttribute('tabindex', '0');
	el.setAttribute('aria-label', label);
	el.addEventListener('click', onActivate);
	el.addEventListener('keydown', (event: KeyboardEvent) => {
		// Ignore keys bubbling up from real controls nested inside (e.g. a button).
		if (event.target === el && (event.key === 'Enter' || event.key === ' ')) {
			event.preventDefault();
			onActivate(event);
		}
	});
}

/** The scheduler modal currently on screen; only one is shown at a time. */
let activeSchedulerModal: Modal | null = null;

/**
 * Closes the previously opened scheduler modal (through its own `close()`, so
 * its `onClose` cleanup runs) and registers `currentModal` as the active one.
 */
export function closeExistingSchedulerModals(currentModal?: Modal): void {
	const previous = activeSchedulerModal;
	activeSchedulerModal = currentModal ?? null;
	if (previous && previous !== currentModal && previous.modalEl.isConnected) {
		previous.close();
	}
}

/** Called from a scheduler modal's `onClose` to drop it from the registry. */
export function releaseSchedulerModal(modal: Modal): void {
	if (activeSchedulerModal === modal) activeSchedulerModal = null;
}

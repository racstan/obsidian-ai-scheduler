export function styleElement<T extends HTMLElement>(element: T, styles: Partial<CSSStyleDeclaration>): T {
	Object.assign(element.style, styles);
	return element;
}

export function makeButton(parent: HTMLElement, label: string, onClick: (button: HTMLButtonElement) => void | Promise<void>, primary = false, danger = false): HTMLButtonElement {
	const button = parent.createEl('button', { text: label });
	if (primary) button.addClass('mod-cta');
	if (danger) {
		button.addClass('mod-warning');
		button.style.color = 'var(--text-error)';
		button.style.borderColor = 'var(--text-error)';
	}
	button.onclick = () => { void onClick(button); };
	return button;
}

export function makeCard(parent: HTMLElement, styles: Partial<CSSStyleDeclaration> = {}): HTMLDivElement {
	return styleElement(parent.createEl('div'), Object.assign({
		border: '1px solid var(--background-modifier-border)',
		borderRadius: '12px',
		padding: '16px',
		background: 'var(--background-primary-alt)',
	}, styles));
}

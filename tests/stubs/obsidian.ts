/* Minimal stand-in for the `obsidian` module so unit tests can import plugin
 * modules that touch it (scripts/run-tests.mjs aliases `obsidian` here).
 * YAML is modelled as JSON, which is enough to round-trip the plugin's own
 * frontmatter. */
export class TAbstractFile {
	path = '';
}
export class TFile extends TAbstractFile {
	extension = 'md';
	basename = '';
}
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}
export class Notice {
	constructor(public message?: string) {}
}
export type App = Record<string, unknown>;

export function normalizePath(path: string): string {
	return String(path || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '') || '/';
}

export function stringifyYaml(data: unknown): string {
	return JSON.stringify(data, null, 1);
}

export function parseYaml(text: string): unknown {
	return JSON.parse(text);
}

export function getFrontMatterInfo(content: string): { exists: boolean; frontmatter: string } {
	const lines = String(content).split('\n');
	const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
	return end < 0 ? { exists: false, frontmatter: '' } : { exists: true, frontmatter: lines.slice(1, end).join('\n') };
}

export class AbstractInputSuggest<T> {
	constructor(public app: unknown, public inputEl: HTMLInputElement | HTMLDivElement) {}
	close(): void {}
	protected suggestionType?: T;
}

/* Vault context selection shared by the planner, the job editor, and reviews. */
import { App, normalizePath } from 'obsidian';

export interface ContextOption {
	path: string;
	label: string;
	type: 'page' | 'project' | 'missing';
}

export interface JobContext {
	paths: string[];
	missingPaths: string[];
	linkedContentPath: string | null;
	externalContextPaths: string[];
}

export function getVaultContextOptions(app: App): ContextOption[] {
	const options: ContextOption[] = [];
	const files = app.vault.getMarkdownFiles ? app.vault.getMarkdownFiles() : [];
	files.forEach(file => options.push({ path: file.path, label: `Page: ${file.path}`, type: 'page' }));
	const loaded = app.vault.getAllLoadedFiles ? app.vault.getAllLoadedFiles() : [];
	loaded.filter(file => Array.isArray((file as { children?: unknown[] }).children)).forEach((folder: { path?: string }) => {
		if (folder.path) options.push({ path: folder.path, label: `Project folder: ${folder.path}`, type: 'project' });
	});
	return options.sort((a, b) => a.path.localeCompare(b.path));
}

export function getPathsContext(app: App, paths: string[]): JobContext {
	const selected = [...new Set((Array.isArray(paths) ? paths : []).map(path => normalizePath(String(path || '').trim())).filter(Boolean))];
	const available = getVaultContextOptions(app);
	const known = new Set(available.map(option => option.path));
	const folders = new Set(available.filter(option => option.type === 'project').map(option => option.path));
	const filePaths = selected.filter(path => !folders.has(path));
	const folderPaths = selected.filter(path => folders.has(path));
	const adapter = app.vault.adapter as unknown as { getBasePath?: () => string } | undefined;
	const basePath = adapter && typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : '';
	return {
		paths: selected,
		missingPaths: selected.filter(path => !known.has(path)),
		linkedContentPath: filePaths[0] || null,
		externalContextPaths: folderPaths.map(path => basePath ? `${basePath.replace(/[\\/]+$/, '')}/${path}` : path),
	};
}

import obsidian from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['main.js', '.tmp-tests/**', '.tmp-smoke/**', 'node_modules/**', 'scripts/**'] },
	...obsidian.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'obsidianmd/ui/sentence-case': [
				'warn',
				{
					brands: ['Obsidian', 'Markdown', 'Claudian', 'Copilot', 'Obsidian Copilot', 'AI Scheduler', 'AI Planner', 'AI reviews', 'Claude', 'Gemini', 'Ollama', 'OpenAI', 'Windows', 'macOS', 'Linux', 'English'],
					acronyms: ['AI', 'UI', 'ID', 'OK', 'DST', 'OS'],
				},
			],
		},
	},
);


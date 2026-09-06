import obsidian from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['main.js', '.tmp-tests/**', '.tmp-smoke/**', 'node_modules/**', 'scripts/**'] },
	...tseslint.configs.recommendedTypeChecked.map(config => ({
		...config,
		files: ['src/**/*.ts', 'tests/**/*.ts'],
	})),
	{
		files: ['src/**/*.ts', 'tests/**/*.ts'],
		plugins: { obsidianmd: obsidian },
		rules: { ...obsidian.configs.recommended.rules },
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
);

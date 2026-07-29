import obsidianmd from 'eslint-plugin-obsidianmd';
import { defineConfig } from 'eslint/config';

export default defineConfig([
	...obsidianmd.configs.recommended,
	{
		files: ['main.js'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'commonjs'
		}
	},
	{
		// the test harnesses aren't shipped and aren't Obsidian code
		ignores: ['test-*.js', '.shim*.js']
	}
]);

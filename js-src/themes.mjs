const themes = {
	Light: {
		font_color: '#222222',
		background_color: '#ffffff',
		highlight_color: '#e4f4ff',
		highlight_font_color: '#000000',
		shadow_color: '#4082BD',
		chrome: {
			'color-scheme': 'light',
			'--bg': '#fff',
			'--bg-alt': '#fafafa',
			'--bg-grey': '#f7f7f7',
			'--bg-hover': '#e4f4ff',
			'--text': '#555',
			'--text-label': '#222',
			'--text-bright': '#000',
			'--border': '#888',
			'--border-hover': '#57b0ff',
			'--border-shadow': '#0000004c',
			'--input-border': '#bbb',
			'--range-progress': '#3e90ff',
			'--range-progress-border': '#2374ff',
			'--range-progress-hover': '#2374ff',
			'--range-progress-border-hover': '#0060df',
			'--range-track': '#e9e9ed',
			'--range-track-border': '#8f8f9d',
			'--range-track-hover': '#d0d0d7',
			'--range-track-border-hover': '#676774',
			'--range-thumb': '#676774',
			'--range-thumb-border': '#fff',
			'--range-thumb-shadow': '0 1px 5px -2.5px #000',
			'--range-thumb-hover': '#484851',
			'--range-thumb-shadow-hover': '0 1px 5px -1.5px #000',
			'--range-thumb-active': '#0060df',
			'--link': '#1a0dab',
		},
	},
	Dark: {
		font_color: '#e1e1e1',
		background_color: '#0a0a0a',
		highlight_color: '#1a272f',
		highlight_font_color: '#ffffff',
		shadow_color: '#57b0ff',
		chrome: {
			'color-scheme': 'dark',
			'--bg': '#0a0a0a',
			'--bg-alt': '#111',
			'--bg-grey': '#1a1a1a',
			'--bg-hover': '#16181a',
			'--text': '#aaa',
			'--text-label': '#eee',
			'--text-bright': '#fff',
			'--border': '#555',
			'--border-hover': '#57b0ff',
			'--border-shadow': '#ffffff33',
			'--input-border': '#444',
			'--range-progress': '#0060df',
			'--range-progress-border': '#2374ff',
			'--range-progress-hover': '#2374ff',
			'--range-progress-border-hover': '#3e90ff',
			'--range-track': '#676774',
			'--range-track-border': '#d0d0d7',
			'--range-track-hover': '#8f8f9d',
			'--range-track-border-hover': '#e9e9ed',
			'--range-thumb': '#3f3f47',
			'--range-thumb-border': '#ddd',
			'--range-thumb-shadow': '0 1px 5px -3px #fff',
			'--range-thumb-hover': '#4d4d57',
			'--range-thumb-shadow-hover': '0 1px 5px -2px #fff',
			'--range-thumb-active': '#0060df',
			'--link': '#99c3ff',
		},
	},
};

// Keep resolver helpers out of the theme dropdown
themes._ = {
	// Follow the browser preference and fall back to Dark
	pickPreferred() {
		return matchMedia('(prefers-color-scheme: light)').matches ? 'Light' : 'Dark';
	},
	// Check whether the user explicitly chose a theme
	hasExplicit() {
		return !!themes[localStorage.getItem('options.theme')]?.chrome;
	},
	// Use the explicit choice or the live browser preference
	resolve() {
		return this.hasExplicit() ? localStorage.getItem('options.theme') : this.pickPreferred();
	},
};

export {themes};

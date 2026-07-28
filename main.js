const { Plugin, PluginSettingTab, Setting, Modal, FuzzySuggestModal, Notice } = require('obsidian');

const DEFAULT_SETTINGS = {
	muscleGroups: [], // [{ name: string, exercises: [{ name: string, sets: number }] }]
	logFolder: 'Workouts',
	defaultSets: 3, // fallback used when adding a new exercise
	bodyweight: 0 // used when a Weight cell says "BW" or "BW+25"
};

// ---------- Helpers ----------

function sanitizeFileName(name) {
	return name.replace(/[\\/:*?"<>|]/g, '-').trim();
}

function todayString() {
	// Obsidian ships moment.js globally
	if (window.moment) return window.moment().format('YYYY-MM-DD');
	const d = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatNumber(n) {
	return Math.round(n).toLocaleString();
}

// Turn a Weight cell into a number. Handles "135", "60 kg", "BW", "BW+25".
function parseWeightCell(cell, bodyweight) {
	const raw = (cell || '').trim();
	if (!raw) return null;

	const bwMatch = raw.match(/^bw\s*(?:([+-])\s*([\d.]+))?/i);
	if (bwMatch) {
		if (!bodyweight) return null; // bodyweight not configured, can't score it
		const extra = bwMatch[2] ? parseFloat(bwMatch[2]) : 0;
		const signed = bwMatch[1] === '-' ? -extra : extra;
		return bodyweight + (Number.isFinite(signed) ? signed : 0);
	}

	const n = parseFloat(raw);
	return Number.isFinite(n) ? n : null;
}

// ---------- Modal: pick a muscle group ----------

class MuscleGroupSuggestModal extends FuzzySuggestModal {
	constructor(app, muscleGroups, onChoose) {
		super(app);
		this.muscleGroups = muscleGroups;
		this.onChoose = onChoose;
		this.setPlaceholder('Pick a muscle group to log a workout for...');
	}

	getItems() {
		return this.muscleGroups;
	}

	getItemText(group) {
		return group.name;
	}

	onChooseItem(group) {
		this.onChoose(group);
	}
}

// ---------- Settings Tab ----------

class WorkoutTrackerSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Workout Tracker Settings' });

		new Setting(containerEl)
			.setName('Log folder')
			.setDesc('Folder where new workout notes will be created.')
			.addText((text) =>
				text
					.setPlaceholder('Workouts')
					.setValue(this.plugin.settings.logFolder)
					.onChange(async (value) => {
						this.plugin.settings.logFolder = value.trim() || 'Workouts';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Default number of sets')
			.setDesc('Used as the starting sets count whenever you add a new exercise. You can still override it per exercise below.')
			.addText((text) =>
				text
					.setPlaceholder('3')
					.setValue(String(this.plugin.settings.defaultSets))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						this.plugin.settings.defaultSets = Number.isFinite(n) && n > 0 ? n : 3;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Bodyweight')
			.setDesc('Optional. If a Weight cell says "BW" (or "BW+25"), this number is used for the volume math. Leave at 0 to ignore bodyweight sets.')
			.addText((text) =>
				text
					.setPlaceholder('0')
					.setValue(String(this.plugin.settings.bodyweight))
					.onChange(async (value) => {
						const n = parseFloat(value);
						this.plugin.settings.bodyweight = Number.isFinite(n) && n >= 0 ? n : 0;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl('h3', { text: 'Muscle Groups' });
		containerEl.createEl('p', {
			text: 'Add muscle groups, then add the exercises that belong to each one.',
			cls: 'setting-item-description'
		});

		// Add new muscle group
		let newGroupName = '';
		new Setting(containerEl)
			.setName('Add muscle group')
			.addText((text) => {
				text.setPlaceholder('e.g. Chest').onChange((value) => (newGroupName = value));
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') addGroup();
				});
			})
			.addButton((btn) =>
				btn
					.setButtonText('Add')
					.setCta()
					.onClick(() => addGroup())
			);

		const addGroup = async () => {
			const name = newGroupName.trim();
			if (!name) {
				new Notice('Enter a muscle group name first.');
				return;
			}
			if (this.plugin.settings.muscleGroups.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
				new Notice(`"${name}" already exists.`);
				return;
			}
			this.plugin.settings.muscleGroups.push({ name, exercises: [] });
			await this.plugin.saveSettings();
			this.display();
		};

		// Existing muscle groups
		this.plugin.settings.muscleGroups.forEach((group, groupIndex) => {
			const groupContainer = containerEl.createDiv({ cls: 'workout-tracker-group' });
			groupContainer.style.border = '1px solid var(--background-modifier-border)';
			groupContainer.style.borderRadius = '6px';
			groupContainer.style.padding = '10px';
			groupContainer.style.marginBottom = '12px';

			new Setting(groupContainer)
				.setName(group.name)
				.setHeading()
				.addExtraButton((btn) =>
					btn
						.setIcon('trash')
						.setTooltip('Delete muscle group')
						.onClick(async () => {
							this.plugin.settings.muscleGroups.splice(groupIndex, 1);
							await this.plugin.saveSettings();
							this.display();
						})
				);

			// Existing exercises for this group
			group.exercises.forEach((exercise, exIndex) => {
				new Setting(groupContainer)
					.setName(exercise.name)
					.addText((text) => {
						text
							.setPlaceholder('Sets')
							.setValue(String(exercise.sets))
							.onChange(async (value) => {
								const n = parseInt(value, 10);
								exercise.sets = Number.isFinite(n) && n > 0 ? n : exercise.sets;
								await this.plugin.saveSettings();
							});
						text.inputEl.style.width = '50px';
						text.inputEl.type = 'number';
						text.inputEl.min = '1';
					})
					.addExtraButton((btn) =>
						btn
							.setIcon('trash')
							.setTooltip('Delete exercise')
							.onClick(async () => {
								group.exercises.splice(exIndex, 1);
								await this.plugin.saveSettings();
								this.display();
							})
					);
			});

			// Add new exercise to this group
			let newExerciseName = '';
			new Setting(groupContainer)
				.setName('Add exercise')
				.setDesc(`Starts with ${this.plugin.settings.defaultSets} sets (edit above after adding).`)
				.addText((text) => {
					text.setPlaceholder('e.g. Bench Press').onChange((value) => (newExerciseName = value));
					text.inputEl.addEventListener('keydown', (e) => {
						if (e.key === 'Enter') addExercise();
					});
				})
				.addButton((btn) =>
					btn
						.setButtonText('Add')
						.onClick(() => addExercise())
				);

			const addExercise = async () => {
				const name = newExerciseName.trim();
				if (!name) {
					new Notice('Enter an exercise name first.');
					return;
				}
				if (group.exercises.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
					new Notice(`"${name}" already exists in ${group.name}.`);
					return;
				}
				group.exercises.push({ name, sets: this.plugin.settings.defaultSets });
				await this.plugin.saveSettings();
				this.display();
			};
		});
	}
}

// ---------- Main Plugin ----------

module.exports = class WorkoutTrackerPlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		this.addSettingTab(new WorkoutTrackerSettingTab(this.app, this));

		this.addRibbonIcon('dumbbell', 'Log new workout', () => this.startNewWorkout());

		this.addCommand({
			id: 'log-new-workout',
			name: 'Log new workout',
			callback: () => this.startNewWorkout()
		});

		this.addCommand({
			id: 'open-workout-dashboard',
			name: 'Open workout dashboard',
			callback: () => this.openDashboard()
		});

		this.addCommand({
			id: 'insert-workout-visualization',
			name: 'Insert workout visualization here',
			editorCallback: (editor) => {
				editor.replaceSelection(
					['```workout-viz', 'type: spiral', 'muscleGroup: all', 'days: 30', '```', ''].join('\n')
				);
			}
		});

		// Renders a live exercise dropdown inside any ```workout-tracker code block
		this.registerMarkdownCodeBlockProcessor('workout-tracker', (source, el, ctx) => {
			this.renderWorkoutBlock(source, el, ctx);
		});

		// Renders visualizations inside any ```workout-viz code block
		this.registerMarkdownCodeBlockProcessor('workout-viz', (source, el, ctx) => {
			this.renderVizBlock(source, el, ctx);
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		// Migrate exercises that were stored as plain strings (pre-default-sets versions)
		this.settings.muscleGroups.forEach((group) => {
			group.exercises = (group.exercises || []).map((exercise) =>
				typeof exercise === 'string' ? { name: exercise, sets: this.settings.defaultSets } : exercise
			);
		});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	startNewWorkout() {
		if (this.settings.muscleGroups.length === 0) {
			new Notice('Add a muscle group in settings first.');
			return;
		}
		new MuscleGroupSuggestModal(this.app, this.settings.muscleGroups, (group) =>
			this.createWorkoutFile(group)
		).open();
	}

	async createWorkoutFile(group) {
		const date = todayString();
		const fileName = `${sanitizeFileName(group.name)} - ${date}.md`;
		const folder = this.settings.logFolder.trim() || 'Workouts';

		// Make sure the folder exists
		const existingFolder = this.app.vault.getAbstractFileByPath(folder);
		if (!existingFolder) {
			try {
				await this.app.vault.createFolder(folder);
			} catch (e) {
				// folder may already exist due to a race; ignore
			}
		}

		const filePath = `${folder}/${fileName}`;

		if (this.app.vault.getAbstractFileByPath(filePath)) {
			new Notice(`${fileName} already exists. Opening it instead.`);
			const file = this.app.vault.getAbstractFileByPath(filePath);
			await this.app.workspace.getLeaf(true).openFile(file);
			return;
		}

		const content = [
			'---',
			`muscleGroup: "${group.name}"`,
			`date: ${date}`,
			'---',
			'',
			`# ${group.name} - ${date}`,
			'',
			'```workout-tracker',
			`muscleGroup: ${group.name}`,
			'```',
			''
		].join('\n');

		const file = await this.app.vault.create(filePath, content);
		await this.app.workspace.getLeaf(true).openFile(file);
	}

	renderWorkoutBlock(source, el, ctx) {
		// Parse "muscleGroup: X" out of the code block source
		const match = source.match(/muscleGroup:\s*(.+)/i);
		const groupName = match ? match[1].trim() : null;
		const group = this.settings.muscleGroups.find(
			(g) => g.name.toLowerCase() === (groupName || '').toLowerCase()
		);

		const wrapper = el.createDiv({ cls: 'workout-tracker-block' });

		if (!group) {
			wrapper.createEl('p', {
				text: groupName
					? `No muscle group named "${groupName}" found in settings.`
					: 'No muscle group specified. Add "muscleGroup: <name>" to this block.'
			});
			return;
		}

		if (group.exercises.length === 0) {
			wrapper.createEl('p', { text: `${group.name} has no exercises yet. Add some in settings.` });
			return;
		}

		const row = wrapper.createDiv({ cls: 'workout-tracker-row' });
		row.style.display = 'flex';
		row.style.gap = '8px';
		row.style.alignItems = 'center';

		const select = row.createEl('select');
		group.exercises.forEach((exercise) => {
			select.createEl('option', { text: `${exercise.name} (${exercise.sets} sets)`, value: exercise.name });
		});

		const addBtn = row.createEl('button', { text: 'Add exercise to log' });
		addBtn.addEventListener('click', async () => {
			const exercise = group.exercises.find((e) => e.name === select.value);
			await this.appendExerciseSection(ctx.sourcePath, exercise);
		});
	}

	async appendExerciseSection(sourcePath, exercise) {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!file) {
			new Notice('Could not find this note to update.');
			return;
		}

		const heading = `## ${exercise.name}`;
		const existing = await this.app.vault.read(file);

		if (existing.includes(heading)) {
			new Notice(`${exercise.name} is already logged in this note.`);
			return;
		}

		const sets = exercise.sets && exercise.sets > 0 ? exercise.sets : this.settings.defaultSets;
		const rows = Array.from({ length: sets }, (_, i) => `|  ${i + 1}  |        |      |       |`);

		const table = [
			'',
			heading,
			'',
			'| Set | Weight | Reps | Notes |',
			'| --- | ------ | ---- | ----- |',
			...rows,
			''
		].join('\n');

		await this.app.vault.process(file, (data) => data + table);
		new Notice(`Added ${exercise.name} (${sets} sets) to the log.`);
	}

	// ---------- Data collection ----------

	/**
	 * Pulls weight/reps out of every markdown table row in a note and
	 * returns total volume (sum of weight * reps) plus set/exercise counts.
	 */
	parseVolume(content) {
		let volume = 0;
		let workingSets = 0;
		const exercises = new Set();
		let currentExercise = null;

		for (const rawLine of content.split('\n')) {
			const line = rawLine.trim();

			const headingMatch = line.match(/^##\s+(.+)$/);
			if (headingMatch) {
				currentExercise = headingMatch[1].trim();
				continue;
			}

			if (!line.startsWith('|')) continue;

			const cells = line.split('|').slice(1, -1).map((c) => c.trim());
			if (cells.length < 3) continue;
			// Skip header row and the |---|---| separator row
			if (/^set$/i.test(cells[0])) continue;
			if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;

			const weight = parseWeightCell(cells[1], this.settings.bodyweight);
			const reps = parseFloat(cells[2]);
			if (weight === null || !Number.isFinite(reps)) continue;
			if (weight <= 0 || reps <= 0) continue;

			volume += weight * reps;
			workingSets += 1;
			if (currentExercise) exercises.add(currentExercise);
		}

		return { volume, workingSets, exercises: Array.from(exercises) };
	}

	/** Reads every note in the log folder and returns one entry per workout file. */
	async collectSessions() {
		const folder = (this.settings.logFolder || 'Workouts').trim();
		const prefix = folder.endsWith('/') ? folder : folder + '/';

		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix) || f.path === folder);

		const sessions = [];

		for (const file of files) {
			const content = await this.app.vault.cachedRead(file);
			const { volume, workingSets, exercises } = this.parseVolume(content);

			const cache = this.app.metadataCache.getFileCache(file);
			const fm = (cache && cache.frontmatter) || {};

			// Filename shape is "{Muscle Group} - {YYYY-MM-DD}"
			const nameMatch = file.basename.match(/^(.*?)\s*-\s*(\d{4}-\d{2}-\d{2})$/);

			const date = String(fm.date || (nameMatch && nameMatch[2]) || '').slice(0, 10);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

			const muscleGroup = String(fm.muscleGroup || (nameMatch && nameMatch[1]) || 'Unknown').trim();

			sessions.push({ path: file.path, date, muscleGroup, volume, workingSets, exercises });
		}

		sessions.sort((a, b) => a.date.localeCompare(b.date));
		return sessions;
	}

	/** Rolls sessions up into one total-volume figure per calendar day. */
	aggregateByDay(sessions, { muscleGroup = 'all', days = 30 } = {}) {
		const filtered =
			muscleGroup === 'all'
				? sessions
				: sessions.filter((s) => s.muscleGroup.toLowerCase() === muscleGroup.toLowerCase());

		const byDay = new Map();
		for (const s of filtered) {
			const existing = byDay.get(s.date) || { date: s.date, volume: 0, sets: 0, groups: new Set() };
			existing.volume += s.volume;
			existing.sets += s.workingSets;
			existing.groups.add(s.muscleGroup);
			byDay.set(s.date, existing);
		}

		const all = Array.from(byDay.values())
			.map((d) => ({ ...d, groups: Array.from(d.groups) }))
			.sort((a, b) => a.date.localeCompare(b.date));

		return days > 0 ? all.slice(-days) : all;
	}

	// ---------- Dashboard ----------

	async openDashboard() {
		const folder = (this.settings.logFolder || 'Workouts').trim();
		const path = `${folder}/Workout Dashboard.md`;

		let file = this.app.vault.getAbstractFileByPath(path);
		if (!file) {
			if (!this.app.vault.getAbstractFileByPath(folder)) {
				try {
					await this.app.vault.createFolder(folder);
				} catch (e) {
					// already exists
				}
			}
			const content = [
				'# Workout Dashboard',
				'',
				'```workout-viz',
				'type: spiral',
				'muscleGroup: all',
				'days: 30',
				'```',
				''
			].join('\n');
			file = await this.app.vault.create(path, content);
		}

		await this.app.workspace.getLeaf(true).openFile(file);
	}

	// ---------- Visualization ----------

	parseVizOptions(source) {
		const options = { type: 'spiral', muscleGroup: 'all', days: 30, metric: 'volume' };
		for (const line of source.split('\n')) {
			const match = line.match(/^\s*([a-zA-Z]+)\s*:\s*(.+?)\s*$/);
			if (!match) continue;
			const key = match[1].toLowerCase();
			const value = match[2];
			if (key === 'type') options.type = value.toLowerCase();
			else if (key === 'musclegroup') options.muscleGroup = value;
			else if (key === 'days') {
				const n = parseInt(value, 10);
				if (Number.isFinite(n)) options.days = n;
			}
		}
		return options;
	}

	async renderVizBlock(source, el, ctx) {
		const options = this.parseVizOptions(source);
		const wrapper = el.createDiv({ cls: 'workout-viz' });
		wrapper.createEl('p', { text: 'Loading workout data…', cls: 'workout-viz-loading' });

		const sessions = await this.collectSessions();
		wrapper.empty();

		// Muscle group filter
		const controls = wrapper.createDiv({ cls: 'workout-viz-controls' });
		const select = controls.createEl('select');
		select.createEl('option', { text: 'All muscle groups', value: 'all' });
		this.settings.muscleGroups.forEach((g) => {
			select.createEl('option', { text: g.name, value: g.name });
		});
		select.value = options.muscleGroup;

		// Time range filter
		const rangeSelect = controls.createEl('select');
		const ranges = [
			{ label: 'Last 30 days logged', value: 30 },
			{ label: 'Last 60 days logged', value: 60 },
			{ label: 'Last 90 days logged', value: 90 },
			{ label: 'All time', value: 0 }
		];
		if (!ranges.some((r) => r.value === options.days)) {
			ranges.unshift({ label: `Last ${options.days} days logged`, value: options.days });
		}
		ranges.forEach((r) => rangeSelect.createEl('option', { text: r.label, value: String(r.value) }));
		rangeSelect.value = String(options.days);

		const canvas = wrapper.createDiv({ cls: 'workout-viz-canvas' });

		const draw = () => {
			canvas.empty();
			const data = this.aggregateByDay(sessions, {
				muscleGroup: select.value,
				days: parseInt(rangeSelect.value, 10)
			});
			this.drawSpiral(canvas, data, select.value);
		};

		select.addEventListener('change', draw);
		rangeSelect.addEventListener('change', draw);
		draw();
	}

	drawSpiral(container, days, groupLabel) {
		if (days.length === 0) {
			container.createEl('p', {
				text: 'No logged volume yet. Fill in weight and reps in your workout tables to see the spiral.',
				cls: 'workout-viz-empty'
			});
			return;
		}

		const W = 700;
		const H = 440;
		const cx = W / 2;
		const cy = 200;

		const volumes = days.map((d) => d.volume);
		const maxVol = Math.max(...volumes);
		const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
		const bestDay = days[volumes.indexOf(maxVol)];

		const n = days.length;
		const turns = Math.min(3.2, 1.2 + n / 14);
		const rMin = 22;
		const rMax = 165;
		const xSquash = 1.85; // widen into an ellipse, like the reference

		const points = days.map((day, i) => {
			const t = n === 1 ? 0 : i / (n - 1);
			const theta = t * turns * Math.PI * 2 - Math.PI / 2;
			const r = rMin + (rMax - rMin) * t;
			const x = cx + Math.cos(theta) * r * xSquash;
			const y = cy + Math.sin(theta) * r;
			// Area-proportional sizing so a 2x day looks 2x, not 4x
			const radius = 4 + 17 * Math.sqrt(maxVol > 0 ? day.volume / maxVol : 0);
			return { ...day, x, y, radius, isBest: day === bestDay };
		});

		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
		svg.setAttribute('width', '100%');
		svg.classList.add('workout-spiral');

		// Soft glow used for the heaviest days
		const defs = document.createElementNS(svgNS, 'defs');
		defs.innerHTML =
			'<filter id="wt-glow" x="-80%" y="-80%" width="260%" height="260%">' +
			'<feGaussianBlur stdDeviation="6" result="blur"/>' +
			'<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>' +
			'</filter>';
		svg.appendChild(defs);

		// Connecting spiral thread
		if (points.length > 1) {
			const path = document.createElementNS(svgNS, 'path');
			let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
			for (let i = 1; i < points.length; i++) {
				const prev = points[i - 1];
				const cur = points[i];
				const mx = (prev.x + cur.x) / 2;
				const my = (prev.y + cur.y) / 2;
				d += ` Q ${prev.x.toFixed(1)} ${prev.y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
			}
			const last = points[points.length - 1];
			d += ` T ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
			path.setAttribute('d', d);
			path.setAttribute('fill', 'none');
			path.setAttribute('stroke', 'var(--interactive-accent)');
			path.setAttribute('stroke-width', '1');
			path.setAttribute('opacity', '0.28');
			svg.appendChild(path);
		}

		const fmt = formatNumber;

		points.forEach((p) => {
			const g = document.createElementNS(svgNS, 'g');

			const circle = document.createElementNS(svgNS, 'circle');
			circle.setAttribute('cx', p.x.toFixed(1));
			circle.setAttribute('cy', p.y.toFixed(1));
			circle.setAttribute('r', p.radius.toFixed(1));
			circle.setAttribute('fill', 'var(--interactive-accent)');
			circle.setAttribute('opacity', p.isBest ? '1' : '0.82');
			if (p.isBest || p.volume > avgVol * 1.4) {
				circle.setAttribute('filter', 'url(#wt-glow)');
			}
			g.appendChild(circle);

			const label = document.createElementNS(svgNS, 'text');
			label.setAttribute('x', p.x.toFixed(1));
			label.setAttribute('y', (p.y + p.radius + 11).toFixed(1));
			label.setAttribute('text-anchor', 'middle');
			label.setAttribute('font-size', '9');
			label.setAttribute('fill', 'var(--text-muted)');
			label.textContent = String(parseInt(p.date.slice(8, 10), 10));
			g.appendChild(label);

			const title = document.createElementNS(svgNS, 'title');
			title.textContent =
				`${p.date} — ${fmt(p.volume)} volume\n` +
				`${p.sets} sets · ${p.groups.join(', ')}`;
			g.appendChild(title);

			svg.appendChild(g);
		});

		container.appendChild(svg);

		// Summary readout
		const summary = container.createDiv({ cls: 'workout-viz-summary' });

		const stat = (value, caption) => {
			const box = summary.createDiv({ cls: 'workout-viz-stat' });
			box.createDiv({ text: value, cls: 'workout-viz-stat-value' });
			box.createDiv({ text: caption, cls: 'workout-viz-stat-label' });
		};

		stat(fmt(avgVol), 'AVG/DAY');
		stat(fmt(maxVol), 'BEST DAY');
		stat(String(days.length), 'SESSIONS');
		stat(fmt(volumes.reduce((a, b) => a + b, 0)), 'TOTAL VOLUME');

		container.createDiv({
			cls: 'workout-viz-caption',
			text:
				`Volume = weight x reps, summed per day. ` +
				`${groupLabel === 'all' ? 'All muscle groups' : groupLabel}. ` +
				`Oldest at the center, newest spiraling outward.`
		});
	}
};

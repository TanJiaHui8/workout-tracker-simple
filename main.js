const { Plugin, PluginSettingTab, Setting, Modal, FuzzySuggestModal, Notice } = require('obsidian');

const DEFAULT_SETTINGS = {
	muscleGroups: [], // [{ name: string, sets: number, drops: number, weight: number|null }]
	logFolder: 'Workouts',
	defaultSets: 3, // fallback used when adding a new exercise
	bodyweight: 0, // used when a Weight cell says "BW" or "BW+25"
	autoFillWeights: 'last', // 'off' | 'last' | 'default'
	showLastReps: true, // put "last: 12" hints in the Notes column
	bands: [], // [{ name: string, min: number, max: number }]
	bandEstimate: 'mid' // 'low' | 'mid' | 'high' — how a band's range collapses to one number
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

// Collapse a band's resistance range (e.g. 35-45 lb) into a single number.
function collapseRange(min, max, estimate) {
	const lo = Math.min(min, max);
	const hi = Math.max(min, max);
	if (estimate === 'low') return lo;
	if (estimate === 'high') return hi;
	return (lo + hi) / 2;
}

function normalizeBandKey(name) {
	return String(name || '')
		.toLowerCase()
		.replace(/\s+/g, '')
		.replace(/band$/, '');
}

/**
 * Turns a Weight cell into a number.
 *
 *   "135"              -> 135
 *   "60 kg"            -> 60
 *   "BW"               -> bodyweight
 *   "BW+25"            -> bodyweight + 25
 *   "BW-green"         -> bodyweight minus the green band's assistance
 *   "BW-green-blue"    -> bodyweight minus both bands stacked
 *   "BW-(35-45)"       -> bodyweight minus an ad hoc 35-45 lb band
 *   "BW-35~45"         -> same thing, alternate range syntax
 *
 * Returns null when the cell can't be scored (unknown band, BW with no
 * bodyweight configured, or plain gibberish) so the row is skipped rather
 * than silently counted as zero.
 */
function resolveWeightExpression(cell, context) {
	const raw = String(cell || '').trim();
	if (!raw) return null;

	const { bodyweight = 0, bands = [], bandEstimate = 'mid' } = context || {};

	const bandLookup = new Map();
	bands.forEach((b) => {
		if (b && b.name) bandLookup.set(normalizeBandKey(b.name), b);
	});

	// "(35-45)" and "35 - 45" both become "35~45" so the sign splitter below
	// can't mistake a range for two subtracted terms.
	const normalized = raw
		.replace(/\(\s*([\d.]+)\s*[-–]\s*([\d.]+)\s*\)/g, '$1~$2')
		.replace(/\s+/g, '');

	// Split into signed terms: "BW-green-blue" -> ["BW", "-green", "-blue"]
	const terms = normalized.split(/(?=[+-])/).filter((t) => t.length > 0);

	let total = 0;
	let sawTerm = false;

	for (const term of terms) {
		const sign = term.startsWith('-') ? -1 : 1;
		const body = term.replace(/^[+-]/, '');
		if (!body) continue;

		let value = null;

		if (/^bw$/i.test(body)) {
			if (!bodyweight) return null; // can't score bodyweight work without it
			value = bodyweight;
		} else {
			const rangeMatch = body.match(/^([\d.]+)~([\d.]+)$/);
			if (rangeMatch) {
				value = collapseRange(parseFloat(rangeMatch[1]), parseFloat(rangeMatch[2]), bandEstimate);
			} else {
				const band = bandLookup.get(normalizeBandKey(body));
				if (band) {
					value = collapseRange(Number(band.min), Number(band.max), bandEstimate);
				} else {
					const n = parseFloat(body);
					// reject things like "greenish" that parseFloat would choke on
					if (!Number.isFinite(n) || !/^[\d.]/.test(body)) return null;
					value = n;
				}
			}
		}

		if (value === null || !Number.isFinite(value)) return null;
		total += sign * value;
		sawTerm = true;
	}

	return sawTerm ? total : null;
}

// Split a cell into drop-set segments. "25 > 20 > 15" -> ["25", "20", "15"].
// Accepts >, →, /, comma or semicolon as separators.
function splitDropSegments(cell) {
	return String(cell || '')
		.split(/\s*(?:>+|→|\/|,|;)\s*/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
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

// ---------- Modal: log bodyweight ----------

class BodyweightModal extends Modal {
	constructor(app, plugin, file) {
		super(app);
		this.plugin = plugin;
		this.file = file;
	}

	onOpen() {
		const { contentEl } = this;
		new Setting(contentEl).setName('Log bodyweight').setHeading();
		contentEl.createEl('p', {
			text: `Saved to ${this.file.basename}. Used for every BW set in this note.`,
			cls: 'setting-item-description'
		});

		const cache = this.app.metadataCache.getFileCache(this.file);
		const current = this.plugin.readNoteBodyweight(cache);

		const input = contentEl.createEl('input');
		input.type = 'number';
		input.step = '0.1';
		input.addClass('workout-tracker-modal-input');
		if (current !== null) input.value = String(current);

		const submit = async () => {
			const value = parseFloat(input.value);
			if (!Number.isFinite(value) || value <= 0) {
				new Notice('Enter a positive number.');
				return;
			}
			await this.plugin.setNoteBodyweight(this.file, value);
			new Notice(`Bodyweight set to ${value}.`);
			this.close();
		};

		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') submit();
		});

		const buttons = contentEl.createDiv({ cls: 'workout-tracker-modal-buttons' });
		const saveBtn = buttons.createEl('button', { text: 'Save' });
		saveBtn.addClass('mod-cta');
		saveBtn.addEventListener('click', submit);

		window.setTimeout(() => input.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
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
			.setName('Default bodyweight')
			.setDesc(
				'Fallback only. Each workout note can carry its own "bodyweight" value, and notes without one use the closest ' +
					'logged weight in time. This number is used when no note has ever logged a weight. 0 means BW sets are skipped.'
			)
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

		new Setting(containerEl)
			.setName('Auto-fill the weight column')
			.setDesc(
				'Off: leave weights blank. Last session: copy the weights you used the last time you did that exercise. ' +
					'Default weight: use the per-exercise weight set below.'
			)
			.addDropdown((dd) =>
				dd
					.addOption('off', 'Off')
					.addOption('last', 'Last session')
					.addOption('default', 'Default weight')
					.setValue(this.plugin.settings.autoFillWeights)
					.onChange(async (value) => {
						this.plugin.settings.autoFillWeights = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Show last session's reps in Notes")
			.setDesc(
				'Prefills the Notes column with what you hit last time (e.g. "last: 12"), so you can see what you are chasing. Only fills empty Notes cells.'
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showLastReps).onChange(async (value) => {
					this.plugin.settings.showLastReps = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName('Resistance bands').setHeading();
		containerEl.createEl('p', {
			text:
				'Name your bands and their resistance range. Then write "BW-green" in a Weight cell for an assisted pull-up, ' +
				'or "BW-green-blue" when you stack two. Ad hoc ranges work too: "BW-(35-45)".',
			cls: 'setting-item-description'
		});

		new Setting(containerEl)
			.setName('Estimate a band range as')
			.setDesc(
				'A band labelled 35-45 lb assists differently through the range. This picks the single number used for volume math. ' +
					'Low end is the most conservative (counts your sets as harder).'
			)
			.addDropdown((dd) =>
				dd
					.addOption('low', 'Low end (35)')
					.addOption('mid', 'Midpoint (40)')
					.addOption('high', 'High end (45)')
					.setValue(this.plugin.settings.bandEstimate)
					.onChange(async (value) => {
						this.plugin.settings.bandEstimate = value;
						await this.plugin.saveSettings();
					})
			);

		this.plugin.settings.bands.forEach((band, bandIndex) => {
			new Setting(containerEl)
				.setName(band.name)
				.setDesc(`Written as BW-${normalizeBandKey(band.name) || band.name}`)
				.addText((text) => {
					text
						.setPlaceholder('Min')
						.setValue(String(band.min))
						.onChange(async (value) => {
							const n = parseFloat(value);
							band.min = Number.isFinite(n) ? n : band.min;
							await this.plugin.saveSettings();
						});
					text.inputEl.addClass('workout-tracker-num-sm');
					text.inputEl.type = 'number';
					text.inputEl.title = 'Lightest assistance (band barely stretched)';
				})
				.addText((text) => {
					text
						.setPlaceholder('Max')
						.setValue(String(band.max))
						.onChange(async (value) => {
							const n = parseFloat(value);
							band.max = Number.isFinite(n) ? n : band.max;
							await this.plugin.saveSettings();
						});
					text.inputEl.addClass('workout-tracker-num-sm');
					text.inputEl.type = 'number';
					text.inputEl.title = 'Heaviest assistance (band fully stretched)';
				})
				.addExtraButton((btn) =>
					btn
						.setIcon('trash')
						.setTooltip('Delete band')
						.onClick(async () => {
							this.plugin.settings.bands.splice(bandIndex, 1);
							await this.plugin.saveSettings();
							this.display();
						})
				);
		});

		let newBandName = '';
		let newBandMin = '';
		let newBandMax = '';

		const addBand = async () => {
			const name = newBandName.trim();
			const min = parseFloat(newBandMin);
			const max = parseFloat(newBandMax);

			if (!name) {
				new Notice('Give the band a name first.');
				return;
			}
			if (!Number.isFinite(min) || !Number.isFinite(max)) {
				new Notice('Enter both a min and max resistance.');
				return;
			}
			if (this.plugin.settings.bands.some((b) => normalizeBandKey(b.name) === normalizeBandKey(name))) {
				new Notice(`A band called "${name}" already exists.`);
				return;
			}

			this.plugin.settings.bands.push({ name, min, max });
			await this.plugin.saveSettings();
			this.display();
		};

		new Setting(containerEl)
			.setName('Add band')
			.addText((text) => {
				text.setPlaceholder('Name, e.g. Green').onChange((v) => (newBandName = v));
				text.inputEl.addClass('workout-tracker-band-name');
			})
			.addText((text) => {
				text.setPlaceholder('Min').onChange((v) => (newBandMin = v));
				text.inputEl.addClass('workout-tracker-num-sm');
				text.inputEl.type = 'number';
			})
			.addText((text) => {
				text.setPlaceholder('Max').onChange((v) => (newBandMax = v));
				text.inputEl.addClass('workout-tracker-num-sm');
				text.inputEl.type = 'number';
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') addBand();
				});
			})
			.addButton((btn) => btn.setButtonText('Add').onClick(() => addBand()));

		new Setting(containerEl).setName('Muscle groups').setHeading();
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
			if (group.exercises.length > 0) {
				groupContainer.createEl('p', {
					text: 'Boxes are: working sets, drop sets per working set (0 = none), and default weight (blank = none).',
					cls: 'setting-item-description'
				});
			}

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
						text.inputEl.addClass('workout-tracker-num-xs');
						text.inputEl.type = 'number';
						text.inputEl.min = '1';
						text.inputEl.title = 'Working sets';
					})
					.addText((text) => {
						text
							.setPlaceholder('Drops')
							.setValue(String(exercise.drops || 0))
							.onChange(async (value) => {
								const n = parseInt(value, 10);
								exercise.drops = Number.isFinite(n) && n >= 0 ? n : 0;
								await this.plugin.saveSettings();
							});
						text.inputEl.addClass('workout-tracker-num-xs');
						text.inputEl.type = 'number';
						text.inputEl.min = '0';
						text.inputEl.title = 'Drop sets after each working set';
					})
					.addText((text) => {
						text
							.setPlaceholder('Weight')
							.setValue(exercise.weight === null || exercise.weight === undefined ? '' : String(exercise.weight))
							.onChange(async (value) => {
								const trimmed = value.trim();
								exercise.weight = trimmed === '' ? null : trimmed;
								await this.plugin.saveSettings();
							});
						text.inputEl.addClass('workout-tracker-num-md');
						text.inputEl.title =
							'Default weight for this exercise. Accepts "25", "BW", or "25 > 20" for a drop.';
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
				group.exercises.push({
					name,
					sets: this.plugin.settings.defaultSets,
					drops: 0,
					weight: null
				});
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
			id: 'log-bodyweight',
			name: "Log today's bodyweight in this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) new BodyweightModal(this.app, this, file).open();
				return true;
			}
		});

		this.addCommand({
			id: 'fill-blank-weights',
			name: 'Fill blanks from last session',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.fillBlankWeights(file.path);
				return true;
			}
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
		// and backfill the drops field added later.
		this.settings.muscleGroups.forEach((group) => {
			group.exercises = (group.exercises || []).map((exercise) => {
				const normalized =
					typeof exercise === 'string'
						? { name: exercise, sets: this.settings.defaultSets }
						: exercise;
				if (typeof normalized.drops !== 'number') normalized.drops = 0;
				if (normalized.weight === undefined) normalized.weight = null;
				return normalized;
			});
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

		const timeline = await this.collectBodyweightTimeline();
		const lastKnown = timeline.length > 0 ? timeline[timeline.length - 1].weight : this.settings.bodyweight;

		const content = [
			'---',
			`muscleGroup: "${group.name}"`,
			`date: ${date}`,
			`bodyweight: ${lastKnown || ''}`,
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

		const select = row.createEl('select');
		group.exercises.forEach((exercise) => {
			const drops = exercise.drops || 0;
			const label = drops > 0
				? `${exercise.name} (${exercise.sets} sets + ${drops} drop${drops > 1 ? 's' : ''})`
				: `${exercise.name} (${exercise.sets} sets)`;
			select.createEl('option', { text: label, value: exercise.name });
		});

		const addBtn = row.createEl('button', { text: 'Add exercise to log' });
		addBtn.addEventListener('click', async () => {
			const exercise = group.exercises.find((e) => e.name === select.value);
			await this.appendExerciseSection(ctx.sourcePath, exercise);
		});

		const fillBtn = row.createEl('button', { text: 'Fill from last session' });
		fillBtn.title = 'Fill blank weights (and rep hints) from the last session that logged each exercise';
		fillBtn.addEventListener('click', async () => {
			await this.fillBlankWeights(ctx.sourcePath);
		});

		this.renderBodyweightRow(wrapper, ctx.sourcePath);
	}

	/** "Bodyweight: [___]" row — writes straight into this note's frontmatter. */
	renderBodyweightRow(wrapper, sourcePath) {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!file) return;

		const bwRow = wrapper.createDiv({ cls: 'workout-tracker-bw' });
		bwRow.createSpan({ text: 'Bodyweight today:' });

		const input = bwRow.createEl('input');
		input.type = 'number';
		input.step = '0.1';
		input.placeholder = '—';

		const cache = this.app.metadataCache.getFileCache(file);
		const logged = this.readNoteBodyweight(cache);
		if (logged !== null) input.value = String(logged);

		const status = bwRow.createSpan({ cls: 'workout-tracker-bw-status' });

		const describe = async () => {
			if (input.value) return;
			const timeline = await this.collectBodyweightTimeline();
			const nameMatch = file.basename.match(/(\d{4}-\d{2}-\d{2})$/);
			const date = nameMatch ? nameMatch[1] : todayString();
			const inherited = this.bodyweightForDate(date, timeline);
			status.setText(
				inherited ? `using ${formatNumber(inherited)} from your closest logged weight` : 'not set'
			);
		};

		const save = async () => {
			const value = parseFloat(input.value);
			if (input.value !== '' && (!Number.isFinite(value) || value <= 0)) {
				status.setText('enter a positive number');
				return;
			}

			await this.setNoteBodyweight(file, input.value === '' ? null : value);
			status.setText(input.value === '' ? '' : 'saved');
			if (input.value === '') await describe();
		};

		input.addEventListener('change', save);
		input.addEventListener('blur', save);
		describe();
	}

	/** Writes (or clears) the bodyweight field in a note's frontmatter. */
	async setNoteBodyweight(file, value) {
		// processFrontMatter is the supported path; fall back to a manual edit on older builds
		if (this.app.fileManager && this.app.fileManager.processFrontMatter) {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				if (value === null) delete fm.bodyweight;
				else fm.bodyweight = value;
			});
			return;
		}

		await this.app.vault.process(file, (data) => {
			const fmMatch = data.match(/^---\n([\s\S]*?)\n---\n?/);
			if (!fmMatch) {
				if (value === null) return data;
				return `---\nbodyweight: ${value}\n---\n\n${data}`;
			}

			let block = fmMatch[1];
			if (/^bodyweight:.*$/m.test(block)) {
				block = value === null
					? block.replace(/^bodyweight:.*$\n?/m, '')
					: block.replace(/^bodyweight:.*$/m, `bodyweight: ${value}`);
			} else if (value !== null) {
				block += `\nbodyweight: ${value}`;
			}

			return data.replace(fmMatch[0], `---\n${block}\n---\n`);
		});
	}

	/** Pulls the Set/Weight pairs out of one exercise's table in a note. */
	extractExerciseRows(content, exerciseName) {
		const lines = content.split('\n');
		const rows = [];
		let inSection = false;

		for (const rawLine of lines) {
			const line = rawLine.trim();
			const heading = line.match(/^##\s+(.+)$/);

			if (heading) {
				inSection = heading[1].trim().toLowerCase() === exerciseName.trim().toLowerCase();
				continue;
			}
			if (!inSection || !line.startsWith('|')) continue;

			const cells = line.split('|').slice(1, -1).map((c) => c.trim());
			if (cells.length < 3) continue;
			if (/^set$/i.test(cells[0])) continue;
			if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
			if (!cells[1] && !cells[2]) continue; // nothing recorded on this row

			rows.push({ label: cells[0], weight: cells[1], reps: cells[2] });
		}

		return rows;
	}

	/** Finds the most recent note (before this one) that logged the given exercise. */
	async findLastWeights(exerciseName, excludePath) {
		const folder = (this.settings.logFolder || 'Workouts').trim();
		const prefix = folder.endsWith('/') ? folder : folder + '/';

		const candidates = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix) && f.path !== excludePath)
			.map((f) => {
				const m = f.basename.match(/(\d{4}-\d{2}-\d{2})$/);
				return { file: f, date: m ? m[1] : '', mtime: f.stat.mtime };
			})
			.sort((a, b) => b.date.localeCompare(a.date) || b.mtime - a.mtime);

		for (const c of candidates) {
			const content = await this.app.vault.cachedRead(c.file);
			const rows = this.extractExerciseRows(content, exerciseName);
			if (rows.length > 0) return { date: c.date || c.file.basename, rows };
		}

		return null;
	}

	/** Finds the row from last session that corresponds to this set label/position. */
	matchHistoryRow(history, label, index) {
		if (!history || history.rows.length === 0) return null;
		const byLabel = history.rows.find(
			(r) => r.label.toLowerCase() === String(label).toLowerCase()
		);
		if (byLabel) return byLabel;
		if (history.rows[index]) return history.rows[index];
		return history.rows[history.rows.length - 1];
	}

	/**
	 * Decides what goes in a Weight cell for a given set label.
	 * Matches last session by set label first ("1a" -> "1a"), then by position,
	 * then carries the final weight down for any extra sets.
	 */
	resolveWeight(exercise, history, label, index, forceMode) {
		const mode = forceMode || this.settings.autoFillWeights;
		if (mode === 'off') return '';

		if (mode === 'last' && history) {
			const row = this.matchHistoryRow(history, label, index);
			if (row && row.weight) return row.weight;
		}

		return exercise.weight ? String(exercise.weight) : '';
	}

	/** Builds the "last: 12" hint for the Notes column. */
	resolveRepsHint(history, label, index) {
		if (!this.settings.showLastReps || !history) return '';
		const row = this.matchHistoryRow(history, label, index);
		if (!row || !row.reps) return '';
		return `last: ${row.reps}`;
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
		const drops = exercise.drops && exercise.drops > 0 ? exercise.drops : 0;

		const needsHistory = this.settings.autoFillWeights === 'last' || this.settings.showLastReps;
		const history = needsHistory ? await this.findLastWeights(exercise.name, sourcePath) : null;

		const row = (label, weight, notes) =>
			`| ${String(label).padEnd(3)} | ${String(weight).padEnd(6)} |      | ${String(notes).padEnd(5)} |`;

		const rows = [];
		let index = 0;
		const pushRow = (label) => {
			const i = index++;
			rows.push(
				row(
					label,
					this.resolveWeight(exercise, history, label, i),
					this.resolveRepsHint(history, label, i)
				)
			);
		};

		for (let i = 1; i <= sets; i++) {
			pushRow(i);
			for (let d = 0; d < drops; d++) {
				// 1a, 1b, 1c... these roll into set 1's volume
				pushRow(`${i}${String.fromCharCode(97 + d)}`);
			}
		}

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

		const setsLabel =
			drops > 0 ? `${sets} sets + ${drops} drop${drops > 1 ? 's' : ''}` : `${sets} sets`;
		const carried = history && this.settings.autoFillWeights === 'last';
		const fillLabel = carried
			? ` — weights from ${history.date}`
			: this.settings.autoFillWeights === 'default' && exercise.weight
				? ' — filled with the default weight'
				: '';

		new Notice(`Added ${exercise.name} (${setsLabel})${fillLabel}.`);
	}

	/** Fills any blank Weight cells in a note using each exercise's last session. */
	async fillBlankWeights(sourcePath) {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!file) {
			new Notice('Could not find this note to update.');
			return;
		}

		const content = await this.app.vault.read(file);
		const names = Array.from(content.matchAll(/^##\s+(.+)$/gm)).map((m) => m[1].trim());

		const histories = new Map();
		for (const name of names) {
			if (!histories.has(name)) {
				histories.set(name, await this.findLastWeights(name, sourcePath));
			}
		}

		let current = null;
		let rowIndex = 0;
		let filled = 0;

		const updated = content
			.split('\n')
			.map((rawLine) => {
				const line = rawLine.trim();

				const heading = line.match(/^##\s+(.+)$/);
				if (heading) {
					current = heading[1].trim();
					rowIndex = 0;
					return rawLine;
				}

				if (!current || !line.startsWith('|')) return rawLine;

				const cells = line.split('|').slice(1, -1).map((c) => c.trim());
				if (cells.length < 3) return rawLine;
				if (/^set$/i.test(cells[0])) return rawLine;
				if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) return rawLine;

				const position = rowIndex++;
				const history = histories.get(current);
				if (!history) return rawLine;

				let changed = false;

				if (!cells[1]) {
					const weight = this.resolveWeight({ weight: null }, history, cells[0], position, 'last');
					if (weight) {
						cells[1] = weight;
						changed = true;
					}
				}

				if (cells.length > 3 && !cells[3]) {
					const hint = this.resolveRepsHint(history, cells[0], position);
					if (hint) {
						cells[3] = hint;
						changed = true;
					}
				}

				if (!changed) return rawLine;
				filled += 1;

				const widths = [3, 6, 4, 5];
				return `| ${cells.map((c, i) => c.padEnd(widths[i] || 5)).join(' | ')} |`;
			})
			.join('\n');

		if (filled === 0) {
			new Notice('Nothing to fill (or no earlier sessions to pull from).');
			return;
		}

		await this.app.vault.process(file, () => updated);
		new Notice(`Filled ${filled} row${filled > 1 ? 's' : ''} from your last sessions.`);
	}

	// ---------- Data collection ----------

	/**
	 * Pulls weight/reps out of every markdown table row in a note and
	 * returns total volume (sum of weight * reps) plus set/exercise counts.
	 *
	 * Drop sets are supported two ways:
	 *   inline    | 1  | 25 > 20 | 12 > 6 |
	 *   sub-rows  | 1a | 20      | 6      |
	 * Both add their volume to the day's total, but only the top set of a
	 * drop counts toward the working-set tally.
	 */
	parseVolume(content, bodyweightOverride) {
		const bodyweight =
			bodyweightOverride === undefined || bodyweightOverride === null
				? this.settings.bodyweight
				: bodyweightOverride;

		let volume = 0;
		let workingSets = 0;
		let dropSets = 0;
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

			// "1a", "1b", or anything labelled drop is a continuation of the set above
			const isDropRow = /^\d+\s*[a-z]$/i.test(cells[0]) || /drop/i.test(cells[0]);

			const weightParts = splitDropSegments(cells[1]);
			const repParts = splitDropSegments(cells[2]);
			if (weightParts.length === 0 || repParts.length === 0) continue;

			// If one column has fewer entries than the other, its last value carries over,
			// so "25" with "12 > 10 > 8" reads as three sets at the same weight.
			const segments = Math.max(weightParts.length, repParts.length);

			for (let i = 0; i < segments; i++) {
				const weight = resolveWeightExpression(
					weightParts[Math.min(i, weightParts.length - 1)],
					{
						bodyweight,
						bands: this.settings.bands,
						bandEstimate: this.settings.bandEstimate
					}
				);
				const reps = parseFloat(repParts[Math.min(i, repParts.length - 1)]);
				if (weight === null || !Number.isFinite(reps)) continue;
				if (weight <= 0 || reps <= 0) continue;

				volume += weight * reps;

				if (i === 0 && !isDropRow) {
					workingSets += 1;
				} else {
					dropSets += 1;
				}

				if (currentExercise) exercises.add(currentExercise);
			}
		}

		return { volume, workingSets, dropSets, exercises: Array.from(exercises) };
	}

	/** Reads a note's logged bodyweight from frontmatter, if it has one. */
	readNoteBodyweight(cache) {
		const fm = (cache && cache.frontmatter) || {};
		const raw = fm.bodyweight !== undefined ? fm.bodyweight : fm.bodyWeight;
		const n = parseFloat(raw);
		return Number.isFinite(n) && n > 0 ? n : null;
	}

	/**
	 * Picks the bodyweight to use for a given date: the note's own value if it
	 * logged one, otherwise the closest logged weight in time (preferring the
	 * most recent one before that date), otherwise the setting.
	 */
	bodyweightForDate(date, timeline) {
		if (!timeline || timeline.length === 0) return this.settings.bodyweight;

		let before = null;
		let after = null;
		for (const entry of timeline) {
			if (entry.date <= date) before = entry;
			else if (!after) after = entry;
		}

		if (before) return before.weight;
		if (after) return after.weight;
		return this.settings.bodyweight;
	}

	/** Every bodyweight ever logged in the log folder, oldest first. */
	async collectBodyweightTimeline() {
		const folder = (this.settings.logFolder || 'Workouts').trim();
		const prefix = folder.endsWith('/') ? folder : folder + '/';

		const entries = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith(prefix)) continue;

			const cache = this.app.metadataCache.getFileCache(file);
			const weight = this.readNoteBodyweight(cache);
			if (weight === null) continue;

			const fm = (cache && cache.frontmatter) || {};
			const nameMatch = file.basename.match(/(\d{4}-\d{2}-\d{2})$/);
			const date = String(fm.date || (nameMatch && nameMatch[1]) || '').slice(0, 10);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

			entries.push({ date, weight });
		}

		entries.sort((a, b) => a.date.localeCompare(b.date));
		return entries;
	}

	/** Reads every note in the log folder and returns one entry per workout file. */
	async collectSessions() {
		const folder = (this.settings.logFolder || 'Workouts').trim();
		const prefix = folder.endsWith('/') ? folder : folder + '/';

		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix) || f.path === folder);

		const timeline = await this.collectBodyweightTimeline();
		const sessions = [];

		for (const file of files) {
			const content = await this.app.vault.cachedRead(file);
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = (cache && cache.frontmatter) || {};

			// Filename shape is "{Muscle Group} - {YYYY-MM-DD}"
			const nameMatch = file.basename.match(/^(.*?)\s*-\s*(\d{4}-\d{2}-\d{2})$/);

			const date = String(fm.date || (nameMatch && nameMatch[2]) || '').slice(0, 10);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

			const ownWeight = this.readNoteBodyweight(cache);
			const bodyweight = ownWeight !== null ? ownWeight : this.bodyweightForDate(date, timeline);

			const { volume, workingSets, dropSets, exercises } = this.parseVolume(content, bodyweight);
			const muscleGroup = String(fm.muscleGroup || (nameMatch && nameMatch[1]) || 'Unknown').trim();

			sessions.push({
				path: file.path,
				date,
				muscleGroup,
				volume,
				workingSets,
				dropSets,
				exercises,
				bodyweight,
				bodyweightLogged: ownWeight !== null
			});
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
			const existing = byDay.get(s.date) || {
				date: s.date,
				volume: 0,
				sets: 0,
				drops: 0,
				groups: new Set()
			};
			existing.volume += s.volume;
			existing.sets += s.workingSets;
			existing.drops += s.dropSets || 0;
			existing.groups.add(s.muscleGroup);
			if (s.bodyweight && !existing.bodyweight) {
				existing.bodyweight = s.bodyweight;
				existing.bodyweightLogged = s.bodyweightLogged;
			}
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
		const svg = activeDocument.createElementNS(svgNS, 'svg');
		svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
		svg.setAttribute('width', '100%');
		svg.classList.add('workout-spiral');

		// Soft glow used for the heaviest days
		const defs = activeDocument.createElementNS(svgNS, 'defs');
		const filter = activeDocument.createElementNS(svgNS, 'filter');
		filter.setAttribute('id', 'wt-glow');
		filter.setAttribute('x', '-80%');
		filter.setAttribute('y', '-80%');
		filter.setAttribute('width', '260%');
		filter.setAttribute('height', '260%');

		const blur = activeDocument.createElementNS(svgNS, 'feGaussianBlur');
		blur.setAttribute('stdDeviation', '6');
		blur.setAttribute('result', 'blur');
		filter.appendChild(blur);

		const merge = activeDocument.createElementNS(svgNS, 'feMerge');
		['blur', 'SourceGraphic'].forEach((input) => {
			const node = activeDocument.createElementNS(svgNS, 'feMergeNode');
			node.setAttribute('in', input);
			merge.appendChild(node);
		});
		filter.appendChild(merge);

		defs.appendChild(filter);
		svg.appendChild(defs);

		// Connecting spiral thread
		if (points.length > 1) {
			const path = activeDocument.createElementNS(svgNS, 'path');
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
			const g = activeDocument.createElementNS(svgNS, 'g');

			const circle = activeDocument.createElementNS(svgNS, 'circle');
			circle.setAttribute('cx', p.x.toFixed(1));
			circle.setAttribute('cy', p.y.toFixed(1));
			circle.setAttribute('r', p.radius.toFixed(1));
			circle.setAttribute('fill', 'var(--interactive-accent)');
			circle.setAttribute('opacity', p.isBest ? '1' : '0.82');
			if (p.isBest || p.volume > avgVol * 1.4) {
				circle.setAttribute('filter', 'url(#wt-glow)');
			}
			g.appendChild(circle);

			const label = activeDocument.createElementNS(svgNS, 'text');
			label.setAttribute('x', p.x.toFixed(1));
			label.setAttribute('y', (p.y + p.radius + 11).toFixed(1));
			label.setAttribute('text-anchor', 'middle');
			label.setAttribute('font-size', '9');
			label.setAttribute('fill', 'var(--text-muted)');
			label.textContent = String(parseInt(p.date.slice(8, 10), 10));
			g.appendChild(label);

			const title = activeDocument.createElementNS(svgNS, 'title');
			title.textContent =
				`${p.date} — ${fmt(p.volume)} volume\n` +
				`${p.sets} sets${p.drops ? ` + ${p.drops} drops` : ''} · ${p.groups.join(', ')}` +
				(p.bodyweight ? `\nbodyweight ${formatNumber(p.bodyweight)}${p.bodyweightLogged ? '' : ' (carried over)'}` : '');
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

		stat(fmt(avgVol), 'Avg/day');
		stat(fmt(maxVol), 'Best day');
		stat(String(days.length), 'Sessions');
		stat(fmt(volumes.reduce((a, b) => a + b, 0)), 'Total volume');

		container.createDiv({
			cls: 'workout-viz-caption',
			text:
				`Volume = weight x reps, summed per day. ` +
				`${groupLabel === 'all' ? 'All muscle groups' : groupLabel}. ` +
				`Oldest at the center, newest spiraling outward.`
		});
	}
};

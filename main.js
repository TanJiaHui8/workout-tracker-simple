const { Plugin, PluginSettingTab, Setting, Modal, FuzzySuggestModal, Notice } = require('obsidian');

const DEFAULT_SETTINGS = {
	muscleGroups: [], // [{ name: string, sets: number, drops: number, weight: number|null }]
	logFolder: 'Workouts',
	defaultSets: 3, // fallback used when adding a new exercise
	bodyweight: 0, // used when a Weight cell says "BW" or "BW+25"
	autoFillWeights: 'last', // 'off' | 'last' | 'default'
	showLastReps: true, // put "last: 12" hints in the Notes column
	bands: [], // [{ name: string, min: number, max: number }]
	bandEstimate: 'mid', // 'low' | 'mid' | 'high' — how a band's range collapses to one number
	renameOnGroupAdd: true, // keep the filename in sync when a muscle group is added
	isoSecondsPerRep: 3 // seconds of an isometric hold that count as one rep for volume
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

// Turn a Time cell into seconds. Accepts "45", "45s", "90 sec", "1:30", "1m30s", "2m".
function parseDuration(cell) {
	const raw = String(cell || '').trim().toLowerCase();
	if (!raw) return null;

	const clock = raw.match(/^(\d+):([0-5]?\d)$/);
	if (clock) return parseInt(clock[1], 10) * 60 + parseInt(clock[2], 10);

	const spelled = raw.match(/^(?:([\d.]+)\s*m(?:in)?)?\s*(?:([\d.]+)\s*s(?:ec)?)?$/);
	if (spelled && (spelled[1] || spelled[2])) {
		return parseFloat(spelled[1] || 0) * 60 + parseFloat(spelled[2] || 0);
	}

	const n = parseFloat(raw);
	return Number.isFinite(n) ? n : null;
}

// Column layout used when a table has no recognisable header row.
const DEFAULT_COLUMNS = { weight: 1, reps: 2, time: -1, notes: 3 };

/**
 * Reads a table's header row into column indices, so an isometric table
 * ("| Set | Weight | Time | Notes |") is understood as well as a rep-based one.
 * Returns null for rows that aren't headers.
 */
function headerColumns(cells) {
	const lower = cells.map((c) => c.trim().toLowerCase());
	if (!/^sets?$/.test(lower[0] || '')) return null;

	const find = (names) => lower.findIndex((c) => names.some((n) => c === n || c.startsWith(n)));

	return {
		weight: find(['weight', 'load']),
		reps: find(['reps', 'rep']),
		time: find(['time', 'duration', 'hold', 'sec']),
		notes: find(['notes', 'note'])
	};
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

// ---------- Modal: set an exercise's whole weight column ----------

class WeightModal extends Modal {
	constructor(app, plugin, sourcePath, exercise) {
		super(app);
		this.plugin = plugin;
		this.sourcePath = sourcePath;
		this.exercise = exercise;
	}

	onOpen() {
		const { contentEl } = this;
		new Setting(contentEl).setName(`Set weight — ${this.exercise}`).setHeading();

		const input = contentEl.createEl('input');
		input.type = 'text';
		input.placeholder = 'e.g. 22.5, BW+8, BW-green';
		input.addClass('workout-tracker-modal-input');

		let scopeValue = 'all';
		new Setting(contentEl).setName('Apply to').addDropdown((dd) =>
			dd
				.addOption('all', 'All rows')
				.addOption('top', 'Top sets only')
				.addOption('drops', 'Drop rows only')
				.setValue(scopeValue)
				.onChange((v) => (scopeValue = v))
		);

		const submit = async () => {
			const weight = input.value.trim();
			if (!weight) {
				new Notice('Enter a weight first.');
				return;
			}
			await this.plugin.setExerciseWeight(this.sourcePath, this.exercise, weight, scopeValue);
			this.close();
		};

		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') submit();
		});

		const buttons = contentEl.createDiv({ cls: 'workout-tracker-modal-buttons' });
		const saveBtn = buttons.createEl('button', { text: 'Apply' });
		saveBtn.addClass('mod-cta');
		saveBtn.addEventListener('click', submit);

		window.setTimeout(() => input.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
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

		new Setting(containerEl)
			.setName('Seconds per rep for isometric holds')
			.setDesc(
				'Isometric exercises record time instead of reps. To keep one comparable volume number, a hold is converted ' +
					'into rep-equivalents at this rate — at 3, a 45 second wall sit counts like 15 reps.'
			)
			.addText((text) =>
				text
					.setPlaceholder('3')
					.setValue(String(this.plugin.settings.isoSecondsPerRep))
					.onChange(async (value) => {
						const n = parseFloat(value);
						this.plugin.settings.isoSecondsPerRep = Number.isFinite(n) && n > 0 ? n : 3;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Rename note when adding a muscle group')
			.setDesc(
				'A workout note can cover several muscle groups. With this on, adding one renames "Back - 2026-07-29" to ' +
					'"Back + Forearms - 2026-07-29" and updates any links to it. Turn it off to keep the original filename.'
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.renameOnGroupAdd).onChange(async (value) => {
					this.plugin.settings.renameOnGroupAdd = value;
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
					text:
						'Boxes are: working sets, drop sets per working set (0 = none), reps or time (isometric holds), and default weight (blank = none).',
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
					.addDropdown((dd) =>
						dd
							.addOption('reps', 'Reps')
							.addOption('time', 'Time')
							.setValue(exercise.type === 'time' ? 'time' : 'reps')
							.onChange(async (value) => {
								exercise.type = value;
								await this.plugin.saveSettings();
							})
					)
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
					weight: null,
					type: 'reps'
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
			id: 'add-muscle-group',
			name: 'Add a muscle group to this workout',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.promptAddGroup(file);
				return true;
			}
		});

		this.addCommand({
			id: 'set-exercise-weight',
			name: 'Set weight for every set of this exercise',
			editorCallback: (editor, view) => {
				// Walk back from the cursor to find the "## Exercise" heading above it
				const cursorLine = editor.getCursor().line;
				let exercise = null;
				for (let i = cursorLine; i >= 0; i--) {
					const match = editor.getLine(i).trim().match(/^##\s+(.+)$/);
					if (match) {
						exercise = match[1].trim();
						break;
					}
				}

				if (!exercise) {
					new Notice('Put the cursor inside an exercise section first.');
					return;
				}

				new WeightModal(this.app, this, view.file.path, exercise).open();
			}
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
				if (normalized.type !== 'time') normalized.type = 'reps';
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
			`muscleGroups: [${group.name}]`,
			`date: ${date}`,
			`bodyweight: ${lastKnown || ''}`,
			'---',
			'',
			`# ${group.name} - ${date}`,
			'',
			'```workout-tracker',
			'```',
			''
		].join('\n');

		const file = await this.app.vault.create(filePath, content);
		await this.app.workspace.getLeaf(true).openFile(file);
	}

	/** The muscle groups a note covers, from frontmatter (or its filename for older notes). */
	getNoteGroups(file) {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = (cache && cache.frontmatter) || {};

		const raw = fm.muscleGroups !== undefined ? fm.muscleGroups : fm.muscleGroup;

		let groups = [];
		if (Array.isArray(raw)) groups = raw;
		else if (typeof raw === 'string' && raw.trim()) groups = raw.split(/\s*[+,]\s*/);

		if (groups.length === 0) {
			// Fall back to the filename: "Back + Forearms - 2026-07-29"
			const match = file.basename.match(/^(.*?)\s*-\s*\d{4}-\d{2}-\d{2}$/);
			if (match) groups = match[1].split(/\s*\+\s*/);
		}

		return groups.map((g) => String(g).trim()).filter((g) => g.length > 0);
	}

	/** Writes the group list to frontmatter, keeping the legacy single-value key in sync. */
	async setNoteGroups(file, groups) {
		if (this.app.fileManager && this.app.fileManager.processFrontMatter) {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				fm.muscleGroups = groups;
				delete fm.muscleGroup;
			});
			return;
		}

		const inline = `muscleGroups: [${groups.join(', ')}]`;
		await this.app.vault.process(file, (data) => {
			const fmMatch = data.match(/^---\n([\s\S]*?)\n---\n?/);
			if (!fmMatch) return `---\n${inline}\n---\n\n${data}`;

			let block = fmMatch[1].replace(/^muscleGroup:.*$\n?/m, '');
			block = /^muscleGroups:.*$/m.test(block)
				? block.replace(/^muscleGroups:.*$/m, inline)
				: block + `\n${inline}`;

			return data.replace(fmMatch[0], `---\n${block}\n---\n`);
		});
	}

	/** Adds a muscle group to an existing workout note, renaming it to match. */
	async addGroupToNote(file, groupName) {
		const groups = this.getNoteGroups(file);

		if (groups.some((g) => g.toLowerCase() === groupName.toLowerCase())) {
			new Notice(`${groupName} is already part of this workout.`);
			return;
		}

		const updated = [...groups, groupName];
		await this.setNoteGroups(file, updated);

		// Keep the H1 in the body consistent with the new group list
		const dateMatch = file.basename.match(/(\d{4}-\d{2}-\d{2})$/);
		const date = dateMatch ? dateMatch[1] : todayString();
		const newTitle = `${updated.join(' + ')} - ${date}`;

		await this.app.vault.process(file, (data) =>
			data.replace(/^#\s+.*$/m, `# ${newTitle}`)
		);

		if (this.settings.renameOnGroupAdd) {
			const folder = file.parent && file.parent.path ? file.parent.path : '';
			const newPath = `${folder ? folder + '/' : ''}${sanitizeFileName(newTitle)}.md`;

			if (newPath !== file.path && !this.app.vault.getAbstractFileByPath(newPath)) {
				try {
					await this.app.fileManager.renameFile(file, newPath);
				} catch (e) {
					// Rename is a convenience; the frontmatter is what actually matters
					new Notice(`Added ${groupName}, but the note could not be renamed.`);
					return;
				}
			}
		}

		new Notice(`Added ${groupName} to this workout.`);
	}

	/** Opens the picker for adding another muscle group to a note. */
	promptAddGroup(file) {
		const existing = this.getNoteGroups(file).map((g) => g.toLowerCase());
		const available = this.settings.muscleGroups.filter(
			(g) => !existing.includes(g.name.toLowerCase())
		);

		if (available.length === 0) {
			new Notice('Every muscle group is already in this workout.');
			return;
		}

		new MuscleGroupSuggestModal(this.app, available, (group) =>
			this.addGroupToNote(file, group.name)
		).open();
	}

	renderWorkoutBlock(source, el, ctx) {
		const wrapper = el.createDiv({ cls: 'workout-tracker-block' });
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);

		// Groups come from the note's frontmatter; the fence's muscleGroup line is
		// still honoured so notes made by older versions keep working.
		let groupNames = file ? this.getNoteGroups(file) : [];
		if (groupNames.length === 0) {
			const match = source.match(/muscleGroups?:\s*(.+)/i);
			if (match) groupNames = match[1].split(/\s*[+,]\s*/).map((g) => g.trim());
		}

		const groups = groupNames
			.map((name) =>
				this.settings.muscleGroups.find((g) => g.name.toLowerCase() === name.toLowerCase())
			)
			.filter(Boolean);

		const controls = wrapper.createDiv({ cls: 'workout-tracker-row' });

		if (groups.length === 0) {
			wrapper.createEl('p', {
				text:
					groupNames.length > 0
						? `No muscle group named "${groupNames.join(', ')}" found in settings.`
						: 'No muscle group set for this note.'
			});
			if (file) this.addGroupButton(controls, file);
			return;
		}

		// The group picker only appears once there is more than one to choose between
		let activeGroup = groups[0];
		const groupSelect = groups.length > 1 ? controls.createEl('select') : null;
		if (groupSelect) {
			groups.forEach((g) => groupSelect.createEl('option', { text: g.name, value: g.name }));
			groupSelect.title = 'Which muscle group to add an exercise from';
		}

		const exerciseSelect = controls.createEl('select');

		const fillExercises = () => {
			exerciseSelect.empty();
			if (activeGroup.exercises.length === 0) {
				exerciseSelect.createEl('option', {
					text: `${activeGroup.name} has no exercises yet`,
					value: ''
				});
				return;
			}
			activeGroup.exercises.forEach((exercise) => {
				const drops = exercise.drops || 0;
				const label =
					drops > 0
						? `${exercise.name} (${exercise.sets} sets + ${drops} drop${drops > 1 ? 's' : ''})`
						: `${exercise.name} (${exercise.sets} sets)`;
				exerciseSelect.createEl('option', { text: label, value: exercise.name });
			});
		};

		if (groupSelect) {
			groupSelect.addEventListener('change', () => {
				activeGroup = groups.find((g) => g.name === groupSelect.value) || groups[0];
				fillExercises();
			});
		}
		fillExercises();

		const addBtn = controls.createEl('button', { text: 'Add exercise to log' });
		addBtn.addEventListener('click', async () => {
			const exercise = activeGroup.exercises.find((e) => e.name === exerciseSelect.value);
			if (!exercise) {
				new Notice(`Add some exercises to ${activeGroup.name} in settings first.`);
				return;
			}
			await this.appendExerciseSection(ctx.sourcePath, exercise);
		});

		const fillBtn = controls.createEl('button', { text: 'Fill from last session' });
		fillBtn.title = 'Fill blank weights (and rep hints) from the last session that logged each exercise';
		fillBtn.addEventListener('click', async () => {
			await this.fillBlankWeights(ctx.sourcePath);
		});

		if (file) this.addGroupButton(controls, file);

		this.renderWeightControls(wrapper, exerciseSelect, ctx.sourcePath);
		this.renderBodyweightRow(wrapper, ctx.sourcePath);
	}

	/** "+ Muscle group" button, shown in both block states. */
	addGroupButton(controls, file) {
		const btn = controls.createEl('button', { text: '+ Muscle group' });
		btn.title = 'Add another muscle group to this workout';
		btn.addEventListener('click', () => this.promptAddGroup(file));
	}

	/** "Set every set of <exercise> to <weight>" row. */
	renderWeightControls(wrapper, exerciseSelect, sourcePath) {
		const row = wrapper.createDiv({ cls: 'workout-tracker-row' });

		const input = row.createEl('input');
		input.type = 'text';
		input.placeholder = 'Weight for every set';
		input.addClass('workout-tracker-weight-input');
		input.title = 'Accepts anything the Weight column accepts: 22.5, BW, BW+8, BW-green';

		const scope = row.createEl('select');
		scope.createEl('option', { text: 'All rows', value: 'all' });
		scope.createEl('option', { text: 'Top sets only', value: 'top' });
		scope.createEl('option', { text: 'Drop rows only', value: 'drops' });
		scope.title = 'Which rows to overwrite when the exercise has drop sets';

		const applyBtn = row.createEl('button', { text: 'Set all' });
		applyBtn.addEventListener('click', async () => {
			const weight = input.value.trim();
			if (!weight) {
				new Notice('Enter a weight first.');
				return;
			}
			await this.setExerciseWeight(sourcePath, exerciseSelect.value, weight, scope.value);
		});

		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') applyBtn.click();
		});
	}

	/**
	 * Overwrites the Weight cell for every row of one exercise in a note.
	 * scope: 'all' | 'top' (skip 1a/1b rows) | 'drops' (only 1a/1b rows).
	 */
	async setExerciseWeight(sourcePath, exerciseName, weight, scope) {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!file) {
			new Notice('Could not find this note to update.');
			return;
		}

		const content = await this.app.vault.read(file);
		let current = null;
		let changed = 0;
		let cols = DEFAULT_COLUMNS;

		const updated = content
			.split('\n')
			.map((rawLine) => {
				const line = rawLine.trim();

				const heading = line.match(/^##\s+(.+)$/);
				if (heading) {
					current = heading[1].trim();
					cols = DEFAULT_COLUMNS;
					return rawLine;
				}

				if (!current || current.toLowerCase() !== exerciseName.toLowerCase()) return rawLine;
				if (!line.startsWith('|')) return rawLine;

				const cells = line.split('|').slice(1, -1).map((c) => c.trim());
				if (cells.length < 3) return rawLine;

				const header = headerColumns(cells);
				if (header) {
					cols = header;
					return rawLine;
				}
				if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) return rawLine;

				const isDrop = /^\d+\s*[a-z]$/i.test(cells[0]) || /drop/i.test(cells[0]);
				if (scope === 'top' && isDrop) return rawLine;
				if (scope === 'drops' && !isDrop) return rawLine;

				const weightCol = cols.weight >= 0 ? cols.weight : 1;
				if (cells[weightCol] === weight) return rawLine;

				cells[weightCol] = weight;
				changed += 1;

				const widths = [3, 6, 4, 5];
				return `| ${cells.map((c, i) => c.padEnd(widths[i] || 5)).join(' | ')} |`;
			})
			.join('\n');

		if (changed === 0) {
			new Notice(`No matching rows for ${exerciseName} in this note.`);
			return;
		}

		await this.app.vault.process(file, () => updated);
		new Notice(`Set ${changed} row${changed > 1 ? 's' : ''} of ${exerciseName} to ${weight}.`);
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
		let cols = DEFAULT_COLUMNS;

		for (const rawLine of lines) {
			const line = rawLine.trim();
			const heading = line.match(/^##\s+(.+)$/);

			if (heading) {
				inSection = heading[1].trim().toLowerCase() === exerciseName.trim().toLowerCase();
				cols = DEFAULT_COLUMNS;
				continue;
			}
			if (!inSection || !line.startsWith('|')) continue;

			const cells = line.split('|').slice(1, -1).map((c) => c.trim());
			if (cells.length < 3) continue;

			const header = headerColumns(cells);
			if (header) {
				cols = header;
				continue;
			}
			if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;

			const weight = cells[cols.weight >= 0 ? cols.weight : 1] || '';
			const timeCell = cols.time >= 0 ? cells[cols.time] || '' : '';
			const repsCell = cols.reps >= 0 ? cells[cols.reps] || '' : '';
			const measure = timeCell || repsCell;

			if (!weight && !measure) continue; // nothing recorded on this row

			rows.push({ label: cells[0], weight, reps: measure, isTime: Boolean(timeCell) });
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

		const isTime = exercise.type === 'time';

		const table = [
			'',
			heading,
			'',
			isTime ? '| Set | Weight | Time | Notes |' : '| Set | Weight | Reps | Notes |',
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
		let cols = DEFAULT_COLUMNS;

		const updated = content
			.split('\n')
			.map((rawLine) => {
				const line = rawLine.trim();

				const heading = line.match(/^##\s+(.+)$/);
				if (heading) {
					current = heading[1].trim();
					rowIndex = 0;
					cols = DEFAULT_COLUMNS;
					return rawLine;
				}

				if (!current || !line.startsWith('|')) return rawLine;

				const cells = line.split('|').slice(1, -1).map((c) => c.trim());
				if (cells.length < 3) return rawLine;

				const header = headerColumns(cells);
				if (header) {
					cols = header;
					return rawLine;
				}
				if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) return rawLine;

				const position = rowIndex++;
				const history = histories.get(current);
				if (!history) return rawLine;

				const weightCol = cols.weight >= 0 ? cols.weight : 1;
				const notesCol = cols.notes >= 0 ? cols.notes : 3;
				let changed = false;

				if (!cells[weightCol]) {
					const weight = this.resolveWeight({ weight: null }, history, cells[0], position, 'last');
					if (weight) {
						cells[weightCol] = weight;
						changed = true;
					}
				}

				if (cells.length > notesCol && !cells[notesCol]) {
					const hint = this.resolveRepsHint(history, cells[0], position);
					if (hint) {
						cells[notesCol] = hint;
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
	/** Maps each configured exercise name to the muscle group it belongs to. */
	exerciseGroupMap() {
		const map = new Map();
		(this.settings.muscleGroups || []).forEach((group) => {
			(group.exercises || []).forEach((exercise) => {
				const name = typeof exercise === 'string' ? exercise : exercise.name;
				if (name) map.set(name.trim().toLowerCase(), group.name);
			});
		});
		return map;
	}

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

		// Volume is attributed to whichever muscle group owns the exercise, so a
		// note covering several groups can still be filtered by one of them.
		const groupOf = this.exerciseGroupMap();
		let cols = DEFAULT_COLUMNS;
		const byGroup = {};
		const tally = (exercise, addVolume, addSet, addDrop) => {
			const group = groupOf.get(String(exercise || '').trim().toLowerCase()) || 'Unassigned';
			if (!byGroup[group]) byGroup[group] = { volume: 0, sets: 0, drops: 0 };
			byGroup[group].volume += addVolume;
			byGroup[group].sets += addSet;
			byGroup[group].drops += addDrop;
		};

		for (const rawLine of content.split('\n')) {
			const line = rawLine.trim();

			const headingMatch = line.match(/^##\s+(.+)$/);
			if (headingMatch) {
				currentExercise = headingMatch[1].trim();
				cols = DEFAULT_COLUMNS;
				continue;
			}

			if (!line.startsWith('|')) continue;

			const cells = line.split('|').slice(1, -1).map((c) => c.trim());
			if (cells.length < 3) continue;

			// A header row tells us where Weight and Reps/Time live in this table
			const header = headerColumns(cells);
			if (header) {
				cols = header;
				continue;
			}
			if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;

			// "1a", "1b", or anything labelled drop is a continuation of the set above
			const isDropRow = /^\d+\s*[a-z]$/i.test(cells[0]) || /drop/i.test(cells[0]);

			// Isometric tables measure a hold in time; everything else counts reps.
			const timeCell = cols.time >= 0 ? cells[cols.time] : '';
			const usingTime = Boolean(timeCell);
			const measureCell = usingTime ? timeCell : cells[cols.reps >= 0 ? cols.reps : 2];

			const weightParts = splitDropSegments(cells[cols.weight >= 0 ? cols.weight : 1]);
			const measureParts = splitDropSegments(measureCell);
			if (weightParts.length === 0 || measureParts.length === 0) continue;

			// If one column has fewer entries than the other, its last value carries over,
			// so "25" with "12 > 10 > 8" reads as three sets at the same weight.
			const segments = Math.max(weightParts.length, measureParts.length);

			for (let i = 0; i < segments; i++) {
				const weight = resolveWeightExpression(
					weightParts[Math.min(i, weightParts.length - 1)],
					{
						bodyweight,
						bands: this.settings.bands,
						bandEstimate: this.settings.bandEstimate
					}
				);

				const rawMeasure = measureParts[Math.min(i, measureParts.length - 1)];

				// A hold is converted into rep-equivalents so isometric and rep-based
				// work land on the same scale and the summary stays comparable.
				const reps = usingTime
					? (() => {
							const seconds = parseDuration(rawMeasure);
							if (seconds === null) return NaN;
							const perRep = this.settings.isoSecondsPerRep > 0 ? this.settings.isoSecondsPerRep : 1;
							return seconds / perRep;
						})()
					: parseFloat(rawMeasure);

				if (weight === null || !Number.isFinite(reps)) continue;
				if (weight <= 0 || reps <= 0) continue;

				const setVolume = weight * reps;
				volume += setVolume;

				const isTopSet = i === 0 && !isDropRow;
				if (isTopSet) workingSets += 1;
				else dropSets += 1;

				tally(currentExercise, setVolume, isTopSet ? 1 : 0, isTopSet ? 0 : 1);

				if (currentExercise) exercises.add(currentExercise);
			}
		}

		return { volume, workingSets, dropSets, byGroup, exercises: Array.from(exercises) };
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

			const { volume, workingSets, dropSets, byGroup, exercises } = this.parseVolume(
				content,
				bodyweight
			);

			// A note can cover several muscle groups
			let muscleGroups = this.getNoteGroups(file);
			if (muscleGroups.length === 0) {
				muscleGroups = [String((nameMatch && nameMatch[1]) || 'Unknown').trim()];
			}

			sessions.push({
				path: file.path,
				date,
				muscleGroups,
				muscleGroup: muscleGroups[0], // kept for anything expecting a single value
				volume,
				workingSets,
				dropSets,
				byGroup,
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
		const wanted = muscleGroup.toLowerCase();
		const isAll = muscleGroup === 'all';

		// A session counts if it covers the group at all; when filtering, only that
		// group's share of the volume is counted, not the whole session.
		const filtered = isAll
			? sessions
			: sessions.filter((s) =>
					(s.muscleGroups || [s.muscleGroup]).some((g) => String(g).toLowerCase() === wanted)
				);

		const share = (s) => {
			if (isAll) return { volume: s.volume, sets: s.workingSets, drops: s.dropSets || 0 };

			const entry = Object.entries(s.byGroup || {}).find(
				([name]) => name.toLowerCase() === wanted
			);
			if (entry) return { volume: entry[1].volume, sets: entry[1].sets, drops: entry[1].drops };

			// Nothing attributed (exercise renamed or deleted from settings): fall back
			// to the whole session only when it's the note's sole group.
			const groups = s.muscleGroups || [s.muscleGroup];
			return groups.length === 1
				? { volume: s.volume, sets: s.workingSets, drops: s.dropSets || 0 }
				: { volume: 0, sets: 0, drops: 0 };
		};

		const byDay = new Map();
		for (const s of filtered) {
			const part = share(s);
			const existing = byDay.get(s.date) || {
				date: s.date,
				volume: 0,
				sets: 0,
				drops: 0,
				groups: new Set()
			};
			existing.volume += part.volume;
			existing.sets += part.sets;
			existing.drops += part.drops;
			(s.muscleGroups || [s.muscleGroup]).forEach((g) => existing.groups.add(g));
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

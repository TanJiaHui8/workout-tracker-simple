const { Plugin, PluginSettingTab, Setting, Modal, FuzzySuggestModal, Notice } = require('obsidian');

const DEFAULT_SETTINGS = {
	muscleGroups: [], // [{ name: string, exercises: [{ name: string, sets: number }] }]
	logFolder: 'Workouts',
	defaultSets: 3 // fallback used when adding a new exercise
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

		// Renders a live exercise dropdown inside any ```workout-tracker code block
		this.registerMarkdownCodeBlockProcessor('workout-tracker', (source, el, ctx) => {
			this.renderWorkoutBlock(source, el, ctx);
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
};

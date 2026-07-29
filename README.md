# Training Volume Log

Log workouts per muscle group in plain Markdown tables, and see your training volume — weight times reps — as a spiral chart.

Everything stays in your vault as ordinary notes. No database, no lock-in.

## Features

- **Muscle groups and exercises** you define in settings, with per-exercise defaults for sets, drop sets, and starting weight.
- **One note per day**, named `{Muscle group} - {YYYY-MM-DD}`, covering as many muscle groups as you train — `Back + Forearms - 2026-07-29`.
- **Drop sets**, written inline (`25 > 20`) or as lettered sub-rows (`1`, `1a`, `1b`).
- **Isometric holds** — wall sits, finger holds and the like record time instead of reps, and still contribute to the same volume number.
- **Resistance bands** with a named library and a resistance range, including stacked bands, for assisted pull-ups.
- **Per-day bodyweight**, so bodyweight work is scored against what you actually weighed that day.
- **Auto-fill** of the weight column from your last session, with optional "last: 12" rep hints in the notes column.
- **Bulk weight changes** — set every set of an exercise to one value in a single step.
- **Spiral visualization** of daily volume — oldest at the centre, newest spiraling outward.

## Logging a workout

Run **Log new workout** from the command palette or click the dumbbell in the ribbon, pick a muscle group, and a note is created. Inside it, choose an exercise from the dropdown and press **Add exercise to log** to append a table:

```markdown
## Rows

| Set | Weight | Reps | Notes    |
| --- | ------ | ---- | -------- |
| 1   | 25     |      | last: 12 |
| 2   | 25     |      | last: 11 |
| 3   | 22.5   |      | last: 10 |
```

Fill in the reps and you're done.

## Training more than one muscle group

A workout note isn't limited to one muscle group. Press **+ Muscle group** in the note's control block (or run **Add a muscle group to this workout**) and pick another one. The note's frontmatter gains it, the filename becomes `Back + Forearms - 2026-07-29`, and links to the note are updated.

The block then shows a group selector next to the exercise dropdown, so you can pull exercises from either group into the same note.

Volume is attributed per exercise, so filtering the chart by **Back** counts your rows but not your wrist curls, even though both live in the same note. Turn off **Rename note when adding a muscle group** in settings if you'd rather keep the original filename.

## Changing a weight for the whole exercise

Moved from 25 to 22.5 across the board? Type the new value in the weight box in the note's control block, pick the exercise, and press **Set all** — every row of that exercise is rewritten at once. The **Apply to** selector limits it to top sets or drop rows when an exercise has both.

The **Set weight for every set of this exercise** command does the same thing for whichever exercise your cursor is sitting in.

## Isometric holds

Set an exercise's measurement to **Time** in settings and its table uses a Time column instead of Reps:

```markdown
## Wall Sits

| Set | Weight | Time | Notes |
| --- | ------ | ---- | ----- |
| 1   | BW     | 45s  |       |
| 2   | BW     | 1:00 |       |
```

Times can be written as `45`, `45s`, `90 sec`, `1:30`, `1m30s`, or `2m`. Weights work exactly as they do elsewhere, so a weighted finger hold is `BW+20` and a band-assisted one is `BW-green`.

For the summary to stay one comparable number, a hold is converted into rep-equivalents using **Seconds per rep for isometric holds** in settings (3 by default): a 45 second wall sit counts like 15 reps. Raise it to make holds count for less, or set it to 1 to score raw seconds.

## Weight column syntax

| Written | Meaning |
| --- | --- |
| `25` | 25 units of external load |
| `60 kg` | units are ignored; be consistent |
| `BW` | your bodyweight for that note |
| `BW+25` | weighted, e.g. a dipping belt |
| `BW-green` | assisted by the band named "green" |
| `BW-green-blue` | assisted by two stacked bands |
| `BW-(35-45)` | assisted by an ad hoc 35–45 band |
| `25 > 20` | a drop set, paired with reps `12 > 6` |

If one column has fewer values than the other, the last one carries over: weight `25` with reps `12 / 10 / 8` reads as three sets at 25.

Rows that can't be scored — an unknown band name, a blank weight, `BW` with no bodyweight recorded — are skipped rather than counted as zero.

## Bodyweight

Each workout note can carry a `bodyweight` value in its frontmatter. Set it with the field in the note's control block, or the **Log today's bodyweight in this note** command. Notes without one use the closest logged weight in time, falling back to the default in settings.

## Visualization

Add a block anywhere, or run **Open workout dashboard**:

````markdown
```workout-viz
type: spiral
muscleGroup: all
days: 30
```
````

Each dot is one day; its area scales with that day's volume. Hover for the date, volume, set count, and the bodyweight used.

## Installation

### From the community directory

Search for "Training Volume Log" under Settings → Community plugins → Browse.

### Manually

Copy `main.js`, `manifest.json`, and `styles.css` into `VaultFolder/.obsidian/plugins/training-volume-log/`, then enable the plugin in Settings → Community plugins.

## Development

The plugin is plain JavaScript with no build step — `main.js` runs as-is.

```bash
npm install
npm run lint    # checks against Obsidian's developer guidelines
npm test        # parser and volume-math test suites
```

## License

MIT — see [LICENSE](LICENSE).

# Training Volume Log

Log workouts per muscle group in plain Markdown tables, and see your training volume — weight times reps — as a spiral chart.

Everything stays in your vault as ordinary notes. No database, no lock-in.

## Features

- **Muscle groups and exercises** you define in settings, with per-exercise defaults for sets, drop sets, and starting weight.
- **One note per session**, named `{Muscle group} - {YYYY-MM-DD}`, with a dropdown of that group's exercises.
- **Drop sets**, written inline (`25 > 20`) or as lettered sub-rows (`1`, `1a`, `1b`).
- **Resistance bands** with a named library and a resistance range, including stacked bands, for assisted pull-ups.
- **Per-day bodyweight**, so bodyweight work is scored against what you actually weighed that day.
- **Auto-fill** of the weight column from your last session, with optional "last: 12" rep hints in the notes column.
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

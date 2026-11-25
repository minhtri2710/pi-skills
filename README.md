# Pi Skills Catalog

Pi extension that removes skill descriptions from the model context by default while retaining slash discovery and explicit `/skill:name` calls. It also offers an on-demand `skill_search` tool and conservative automatic loading when the prompt matches at least two non-generic terms in a skill name or description.

## Install

```sh
pi install /Users/beowulf/Work/pi-skills
```

Restart Pi after installing, or load for one run:

```sh
pi --extension /Users/beowulf/Work/pi-skills/extensions/skills-catalog.js
```

## Use

- At the start of a message, type `/` or `/fragment` for Pi's native slash-command menu. After ordinary text, type a slash token such as ` /fragment` at the cursor to filter skill names available for explicit `/skill:name` invocation, including in the middle of a line. Select a result to insert `/skill:name`.
- Run `/skills list` to open a scrollable settings list. Press Enter/Space on a skill to toggle whether the model can use it; the setting follows the current session branch. This does not disable autocomplete or manual `/skill:name` calls.
- Run `/skills on` or `/skills off` to show or hide the remaining enabled skill catalog metadata in the model context. Per-skill toggles are independent of this catalog visibility setting.
- When the catalog is hidden, Pi can call `skill_search` to match installed skill names and descriptions and load `SKILL.md` content. A normal prompt matching at least two non-generic words also loads the top matching skill as a hidden session message.

Skills with `disable-model-invocation: true` are excluded from model-facing skill lists and from `/skills list`, but remain available for explicit `/skill:name` calls.

Search and automatic matching use exact word overlap, not semantic embeddings. Automatic loading requires at least two matching terms and does not run for slash-command input. Each `skill_search` result is limited to 24,000 characters.

Run tests with `npm test` from this directory.

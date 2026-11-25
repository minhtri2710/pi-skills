import { CustomEditor, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { addSkillCatalogHint, findAutoloadSkill, getAutoloadedSkills, getDisabledSkills, getLastState, loadSkill, matchSkills } from "./skills-catalog-core.js";

const STATE_ENTRY = "skills-catalog-state";
const DISABLED_SKILLS_ENTRY = "skills-catalog-disabled";
const MIN_AUTOLOAD_MATCHES = 2;
const MAX_RESULTS = 8;

function isFuzzyMatch(query, value) {
	let index = 0;
	for (const character of query) {
		index = value.indexOf(character, index);
		if (index === -1) return false;
		index++;
	}
	return true;
}

function findSlashToken(text) {
	const token = text.match(/\/[^\s]*$/u)?.[0];
	if (!token) return undefined;
	const index = text.length - token.length;
	if (index > 0 && !/[\s([{<]/u.test(text[index - 1])) return undefined;
	return { token, index };
}

function removeDisabledSkills(section, disabledSkills) {
	return section.replace(/\n  <skill>\n    <name>([^<]+)<\/name>[\s\S]*?\n  <\/skill>/gu, (block, name) =>
		disabledSkills.has(name) ? "" : block,
	);
}

function installSkillsAutocompleteEditor(ui) {
	const existingFactory = ui.getEditorComponent();
	ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = existingFactory
			? existingFactory(tui, theme, keybindings)
			: new CustomEditor(tui, theme, keybindings);
		const handleInput = editor.handleInput.bind(editor);
		editor.handleInput = function (data) {
			const previousText = this.getText();
			handleInput(data);
			if (this.getText() === previousText) return;

			const { line, col } = this.getCursor();
			const beforeCursor = (this.getLines()[line] ?? "").slice(0, col);
			const command = findSlashToken(beforeCursor);
			if (!command || !beforeCursor.slice(0, command.index).trim()) return;
			if (!this.isShowingAutocomplete()) this.tryTriggerAutocomplete();
		};
		return editor;
	});
}

export default function skillsCatalog(pi) {
	let catalogEnabled = false;
	let disabledSkills = new Set();
	let skillsIndex = [];
	let skillSlashCommands = [];
	let autocompleteEditorInstalled = false;

	pi.on("before_agent_start", async (event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		catalogEnabled = getLastState(branch);
		disabledSkills = new Set(getDisabledSkills(branch));
		const skills = event.systemPromptOptions.skills ?? [];
		skillsIndex = skills;
		event.systemPromptOptions.skills = skills.filter((skill) => !disabledSkills.has(skill.name));
		if (catalogEnabled && event.systemPromptOptions.sections.skills) {
			event.systemPromptOptions.sections.skills = addSkillCatalogHint(removeDisabledSkills(event.systemPromptOptions.sections.skills, disabledSkills));
		}
		if (!catalogEnabled) {
			delete event.systemPromptOptions.sections.skills;
			delete event.systemPromptOptions.skills;
			event.systemPromptOptions.sections.skill_search = "Use skill_search to find and load specialized skill instructions when the task clearly matches an installed skill. Skill names and descriptions are not included in the prompt.";

			if (skills.length > 0) {
				const autoloadedSkills = new Set(getAutoloadedSkills(branch));
				const match = findAutoloadSkill(event.prompt, skills.filter((skill) => !skill.disableModelInvocation && !disabledSkills.has(skill.name) && !autoloadedSkills.has(skill.name)));
				if (match && match.matchedTerms >= MIN_AUTOLOAD_MATCHES) {
					try {
						return {
							message: {
								customType: "skill-autoload",
								content: await loadSkill(match.skill),
								display: false,
								details: { skill: match.skill.name, score: match.score },
							},
						};
					} catch {
						return;
					}
				}
			}
			return;
		}
	});

	pi.on("context_with_system", (event) => {
		if (catalogEnabled && !disabledSkills.size) return;
		if (!catalogEnabled && !disabledSkills.size) {
			for (const message of event.messages) {
				if (message.role === "system" && message.sections?.skills) message.sections.skills = null;
			}
			return { messages: event.messages };
		}
		for (const message of event.messages) {
			if (message.role !== "system" || !message.sections) continue;
			if (!catalogEnabled) {
				if (message.sections.skills) message.sections.skills = null;
				continue;
			}
			const section = message.sections.skills;
			if (typeof section !== "string") continue;
			message.sections.skills = removeDisabledSkills(section, disabledSkills);
		}
		return { messages: event.messages };
	});

	function restoreState(ctx) {
		const branch = ctx.sessionManager.getBranch();
		catalogEnabled = getLastState(branch);
		disabledSkills = new Set(getDisabledSkills(branch));
		skillSlashCommands = pi.getCommands()
			.filter((command) => command.source === "skill")
			.map((command) => command.name.slice("skill:".length));
	}

	pi.on("session_start", (_event, ctx) => {
		restoreState(ctx);
		if (autocompleteEditorInstalled) return;
		ctx.ui.addAutocompleteProvider((current) => ({
			...current,
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const command = findSlashToken(beforeCursor);
				if (!command) return current.getSuggestions(lines, cursorLine, cursorCol, options);

				const prefix = command.token.toLowerCase();
				const query = prefix.slice(1).replace(/^skill:/u, "");
				const matched = skillSlashCommands
					.filter((name) => isFuzzyMatch(query, name))
					.sort((left, right) => Number(!left.startsWith(query)) - Number(!right.startsWith(query)) || left.localeCompare(right));
				const atMessageStart = beforeCursor.slice(0, command.index).trim() === "";
				const existing = await current.getSuggestions(lines, cursorLine, cursorCol, options);
				if (matched.length === 0) return existing;
				const completions = matched.map((name) => ({ value: `skill:${name}`, label: `skill:${name}` }));
				if (!atMessageStart) return { items: completions, prefix };
				const values = new Set(existing?.items.map((item) => item.value) ?? []);
				return { items: [...(existing?.items ?? []), ...completions.filter((item) => !values.has(item.value))], prefix };
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				if (!item.value.startsWith("skill:")) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				const line = lines[cursorLine] ?? "";
				const beforeCursor = line.slice(0, cursorCol);
				const command = findSlashToken(beforeCursor);
				if (!command) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);

				const start = command.index;
				const afterCursor = line.slice(cursorCol);
				const tokenSuffix = afterCursor.match(/^\S*/u)?.[0] ?? "";
				const afterToken = afterCursor.slice(tokenSuffix.length);
				const completed = `/${item.value}`;
				const separator = afterToken.length === 0 ? " " : "";
				const newLine = `${line.slice(0, start)}${completed}${separator}${afterToken}`;
				const newLines = [...lines];
				newLines[cursorLine] = newLine;
				return { lines: newLines, cursorLine, cursorCol: start + completed.length + separator.length };
			},
		}));
		installSkillsAutocompleteEditor(ctx.ui);
		autocompleteEditorInstalled = true;
	});

	pi.on("session_tree", (_event, ctx) => restoreState(ctx));

	pi.registerCommand("skills", {
		description: "Show the skill catalog and enable/disable skill metadata in the model context",
		getArgumentCompletions: (prefix) => ["on", "off", "list"]
			.filter((action) => action.startsWith(prefix))
			.map((action) => ({ value: action, label: action })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "off") {
				catalogEnabled = action === "on";
				pi.appendEntry(STATE_ENTRY, { enabled: catalogEnabled });
				ctx.ui.notify(`Skill catalog ${catalogEnabled ? "enabled" : "disabled"} for model context on the next turn.`, "info");
				return;
			}

			if (action && action !== "list") {
				ctx.ui.notify("Usage: /skills [on|off|list]", "warning");
				return;
			}

			if (skillsIndex.length === 0) skillsIndex = ctx.getSystemPromptOptions().skills ?? [];
			const skills = skillsIndex;
			if (skills.length === 0) {
				ctx.ui.notify("No skills are available in this session.", "info");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/skills list requires TUI mode", "warning");
				return;
			}

			const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
			const items = visibleSkills.map((skill) => ({
				id: skill.name,
				label: skill.name,
				currentValue: disabledSkills.has(skill.name) ? "off" : "on",
				values: ["on", "off"],
			}));
			if (items.length === 0) {
				ctx.ui.notify("No model-invocable skills are available to toggle.", "info");
				return;
			}
			await ctx.ui.custom((tui, _theme, _keybindings, done) => {
				const settings = new SettingsList(
					items,
					Math.min(items.length, 15),
					getSettingsListTheme(),
					(name, value) => {
						if (value === "off") disabledSkills.add(name);
						else disabledSkills.delete(name);
						pi.appendEntry(DISABLED_SKILLS_ENTRY, { names: [...disabledSkills].sort() });
						settings.updateValue(name, value);
					},
					() => done(undefined),
				);
				return {
					render: (width) => ["Toggle skills · Enter/Space changes · Esc closes", "", ...settings.render(width)],
					invalidate: () => settings.invalidate(),
					handleInput: (data) => {
						settings.handleInput(data);
						tui.requestRender();
					},
					handleMouse: (event) => settings.handleMouse(event),
				};
			});
		},
	});

	pi.registerTool({
		name: "skill_search",
		label: "Search Skills",
		description: "Search installed skill names and descriptions, then load matching SKILL.md instructions on demand. Use when a task needs specialized workflow guidance.",
		parameters: Type.Object({
			query: Type.String({ description: "Task or capability to find a matching skill for" }),
		}),
		async execute(_toolCallId, { query }) {
			const skills = skillsIndex.filter((skill) => !skill.disableModelInvocation && !disabledSkills.has(skill.name));
			const matches = matchSkills(query, skills).slice(0, MAX_RESULTS);
			if (matches.length === 0) {
				return { content: [{ type: "text", text: "No matching skills found." }], details: { matches: [] } };
			}

			let remaining = 24_000;
			const blocks = [];
			const failedSkills = new Set();
			for (const { skill } of matches) {
				if (remaining <= 0) break;
				let block;
				try {
					block = await loadSkill(skill, remaining);
				} catch {
					failedSkills.add(skill.name);
					continue;
				}
				remaining -= block.length;
				blocks.push(block);
				if (block.endsWith("[Skill content truncated.]\n</skill>")) break;
			}
			if (blocks.length === 0) {
				return { content: [{ type: "text", text: "No matching skills found." }], details: { matches: [] } };
			}

			return {
				content: [{ type: "text", text: blocks.join("\n\n") }],
				details: { matches: matches.filter(({ skill }) => !failedSkills.has(skill.name)).map(({ skill, score }) => ({ name: skill.name, description: skill.description, filePath: skill.filePath, score })) },
			};
		},
	});
}

export { addSkillCatalogHint, getLastState, loadSkill, matchSkills };

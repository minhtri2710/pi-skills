import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extensionPath = join(import.meta.dirname, "../extensions/skills-catalog.js");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const piRelease = join(agentDir, "install/releases", (await readFile(join(agentDir, "install/current-version"), "utf8")).trim());
const piNodeModules = join(piRelease, "node_modules");
const { createJiti } = await import(pathToFileURL(join(piNodeModules, "jiti/lib/jiti.mjs")).href);
const { KeybindingsManager, TUI_KEYBINDINGS } = await import(pathToFileURL(join(piNodeModules, "@earendil-works/pi-tui/dist/index.js")).href);
const { CustomEditor } = await import(pathToFileURL(join(piNodeModules, "@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js")).href);
const { initTheme } = await import(pathToFileURL(join(piNodeModules, "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js")).href);
initTheme();
const jiti = createJiti(import.meta.url, {
	alias: {
		typebox: join(piNodeModules, "typebox/build/index.mjs"),
		"@earendil-works/pi-coding-agent": join(piNodeModules, "@earendil-works/pi-coding-agent/dist/index.js"),
		"@earendil-works/pi-tui": join(piNodeModules, "@earendil-works/pi-tui/dist/index.js"),
	},
});
const skillsCatalog = await jiti.import(extensionPath, { default: true });

function createFakePi() {
	const handlers = new Map();
	const commands = [{
		name: "skill:security-audit",
		description: "Audit code for security vulnerabilities",
		source: "skill",
		sourceInfo: { path: "/skills/security-audit/SKILL.md", baseDir: "/skills/security-audit" },
	}];
	const registrations = { commands: new Map(), tools: new Map() };
	const pi = {
		on(name, handler) {
			const eventHandlers = handlers.get(name) ?? [];
			eventHandlers.push(handler);
			handlers.set(name, eventHandlers);
		},
		registerCommand(name, options) { registrations.commands.set(name, options); },
		registerTool(tool) { registrations.tools.set(tool.name, tool); },
		getCommands() { return commands; },
		appendEntry() {},
	};
	return { pi, handlers, registrations, commands };
}

test("catalog hides metadata but keeps explicit slash commands and search", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-skills-ext-test-"));
	try {
		const skillDir = join(directory, "security-audit");
		await mkdir(skillDir);
		const filePath = join(skillDir, "SKILL.md");
		await writeFile(filePath, "---\nname: security-audit\ndescription: Audit code for security vulnerabilities\n---\n# Security audit\nReview source code.", "utf8");

		const { pi, handlers, registrations, commands } = createFakePi();
		commands[0].sourceInfo.path = filePath;
		commands[0].sourceInfo.baseDir = skillDir;
		skillsCatalog(pi);
		const autocompleteProviders = [];
		let editorFactory;
		let existingEditorFactoryCalls = 0;
		let currentEditorFactory = (tui, theme, keybindings) => {
			existingEditorFactoryCalls++;
			return new CustomEditor(tui, theme, keybindings);
		};		const branch = [];
		const ctx = {
			cwd: directory,
			sessionManager: { getBranch: () => branch },
			ui: {
				addAutocompleteProvider: (factory) => autocompleteProviders.push(factory),
				getEditorComponent: () => currentEditorFactory,
				setEditorComponent: (factory) => { editorFactory = currentEditorFactory = factory; }
			},
			getSystemPromptOptions: () => ({ skills: [{ name: "security-audit" }] }),
		};
		await handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
		const options = { skills: [{ name: "security-audit", description: "Audit code for security vulnerabilities", filePath, baseDir: skillDir }], sections: { skills: "<available_skills>private</available_skills>" } };
		ctx.getSystemPromptOptions = () => options;
		await handlers.get("before_agent_start")[0]({ prompt: "ordinary prompt", systemPromptOptions: options }, ctx);
		assert.equal(options.sections.skills, undefined);
		assert.equal(options.skills, undefined);
		assert.equal(autocompleteProviders.length, 1);
		const autocomplete = autocompleteProviders[0]({
			getSuggestions: async () => null,
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return { lines, cursorLine, cursorCol };
			},
		});
		assert.equal(autocomplete.triggerCharacters?.includes("/"), undefined);
		const completions = await autocomplete.getSuggestions(["/security"], 0, "/security".length, { signal: new AbortController().signal });
		assert.equal(completions.items[0].value, "skill:security-audit");
		assert.equal(completions.prefix, "/security");
		const namedCompletions = await autocomplete.getSuggestions(["/skill:sec"], 0, "/skill:sec".length, { signal: new AbortController().signal });
		assert.equal(namedCompletions.items[0].value, "skill:security-audit");
		const invalidMidline = await autocomplete.getSuggestions(["please /missing"], 0, "please /missing".length, { signal: new AbortController().signal });
		assert.equal(invalidMidline, null);
		const invalidCharacterBoundary = await autocomplete.getSuggestions(["please:/sec"], 0, "please:/sec".length, { signal: new AbortController().signal });
		assert.equal(invalidCharacterBoundary, null);
		const embeddedSlash = "review this /sec";
		const embeddedCursor = embeddedSlash.length;
		const embeddedCompletions = await autocomplete.getSuggestions([embeddedSlash], 0, embeddedCursor, { signal: new AbortController().signal });
		assert.equal(embeddedCompletions.items[0].value, "skill:security-audit");
		const middleLine = "review this /sec next";
		const middleCursor = middleLine.indexOf(" next");
		const middleCompletions = await autocomplete.getSuggestions([middleLine], 0, middleCursor, { signal: new AbortController().signal });
		assert.equal(middleCompletions.items[0].value, "skill:security-audit");
		assert.equal(middleCompletions.prefix, "/sec");
		const applied = autocomplete.applyCompletion([middleLine], 0, middleCursor, middleCompletions.items[0], middleCompletions.prefix);
		assert.equal(applied.lines[0], "review this /skill:security-audit next");
		assert.equal(applied.cursorCol, "review this /skill:security-audit".length);

		const liveEditor = editorFactory(
			{ terminal: { rows: 24 }, requestRender() {} },
			{ borderColor: (value) => value, selectList: {} },
			new KeybindingsManager(TUI_KEYBINDINGS),
		);
		assert.equal(existingEditorFactoryCalls, 1);
		liveEditor.setAutocompleteProvider(autocomplete);
		liveEditor.setText("review this   next");
		for (let index = 0; index < 5; index++) liveEditor.handleInput("\u001b[D");
		for (const character of "/sec") liveEditor.handleInput(character);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(liveEditor instanceof CustomEditor, true);
		assert.equal(liveEditor.isShowingAutocomplete(), true);
		liveEditor.handleInput("\t");
		assert.equal(liveEditor.getText(), "review this  /skill:security-audit next");

		assert.equal(registrations.commands.has("skills"), true);
		const result = await registrations.tools.get("skill_search").execute("call", { query: "audit security vulnerabilities" });
		assert.match(result.content[0].text, /# Security audit/);
		assert.equal(result.details.matches[0].name, "security-audit");
		const manualOnly = { name: "manual-only", description: "Manual only security instruction", filePath, disableModelInvocation: true };
		await handlers.get("before_agent_start")[0]({ prompt: "ordinary prompt", systemPromptOptions: { skills: [manualOnly], sections: {} } }, ctx);
		const manualSearch = await registrations.tools.get("skill_search").execute("call", { query: "manual only security" });
		assert.equal(manualSearch.details.matches.length, 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("skills list is a scrollable toggle picker that persists branch state", async () => {
	const { pi, handlers, registrations } = createFakePi();
	const branch = [];
	const allSkills = [
		{ name: "security-audit", description: "Audit security vulnerabilities", filePath: "/skills/security/SKILL.md" },
		...Array.from({ length: 16 }, (_, index) => ({ name: `other-skill-${index + 1}`, description: "Other task", filePath: `/skills/other-${index + 1}/SKILL.md` })),
		{ name: "manual-only", description: "Manual skill", filePath: "/skills/manual/SKILL.md", disableModelInvocation: true },
	];
	const ui = {
		async custom(factory) {
			const component = factory({ requestRender() {} }, {}, new KeybindingsManager(TUI_KEYBINDINGS), () => {});
			component.handleInput("\r");
			assert.match(component.render(80).join("\n").replace(/\u001b\[[0-9;]*m/gu, ""), /security-audit\s+off/u);
			for (let index = 0; index < 15; index++) component.handleInput("\u001b[B");
			assert.match(component.render(80).join("\n"), /\(16\/17\)/u);
		},
	};
	let activeBranch = branch;
	const ctx = {
		mode: "tui",
		ui: { ...ui, notify() {} },
		sessionManager: { getBranch: () => activeBranch },
		getSystemPromptOptions: () => ({ skills: allSkills }),
	};
	pi.appendEntry = (customType, data) => branch.push({ type: "custom", customType, data });
	skillsCatalog(pi);
	await handlers.get("before_agent_start")[0]({ prompt: "ordinary", systemPromptOptions: { skills: allSkills, sections: {} } }, ctx);
	await registrations.commands.get("skills").handler("on", ctx);
	await registrations.commands.get("skills").handler("list", ctx);
	assert.deepEqual(branch.at(-1).data.names, ["security-audit"]);
	branch.push({ type: "custom", customType: "skills-catalog-disabled", data: { names: ["security-audit"] } });

	const availableSkills = "<available_skills>\n  <skill>\n    <name>security-audit</name>\n    <description>Audit security vulnerabilities</description>\n    <location>/skills/security/SKILL.md</location>\n  </skill>\n</available_skills>";
	activeBranch = branch;
	const nextOptions = { skills: allSkills, sections: { skills: availableSkills } };
	await handlers.get("before_agent_start")[0]({ prompt: "audit security vulnerabilities", systemPromptOptions: nextOptions }, ctx);
	assert.deepEqual(nextOptions.skills.map((skill) => skill.name), allSkills.filter((skill) => skill.name !== "security-audit").map((skill) => skill.name));
	assert.doesNotMatch(nextOptions.sections.skills, /security-audit/u);
	const contextEvent = { messages: [{ role: "system", sections: { skills: availableSkills } }] };
	handlers.get("context_with_system")[0](contextEvent);
	assert.doesNotMatch(contextEvent.messages[0].sections.skills, /security-audit/u);
	const search = await registrations.tools.get("skill_search").execute("call", { query: "audit security vulnerabilities" });
	assert.equal(search.details.matches.length, 0);
	const manualCallOptions = { skills: allSkills, sections: {} };
	await handlers.get("before_agent_start")[0]({ prompt: "/skill:security-audit", systemPromptOptions: manualCallOptions }, ctx);
	assert.equal(manualCallOptions.skills.some((skill) => skill.name === "security-audit"), false);
	assert.equal(pi.getCommands().some((command) => command.name === "skill:security-audit"), true);

	activeBranch = [];
	handlers.get("session_tree")[0]({}, ctx);
	const restoredBranchOptions = { skills: allSkills, sections: { skills: availableSkills } };
	await handlers.get("before_agent_start")[0]({ prompt: "ordinary", systemPromptOptions: restoredBranchOptions }, ctx);
	assert.equal(restoredBranchOptions.sections.skills, undefined);

	activeBranch = branch;
	await registrations.commands.get("skills").handler("off", ctx);
	const autoload = await handlers.get("before_agent_start")[0]({ prompt: "audit security vulnerabilities", systemPromptOptions: { skills: allSkills, sections: {} } }, ctx);
	assert.equal(autoload, undefined);
});

test("slash-prefixed input does not trigger automatic skill loading", async () => {
	const { pi, handlers } = createFakePi();
	skillsCatalog(pi);
	const ctx = { sessionManager: { getBranch: () => [] } };
	const options = { skills: [{ name: "security-audit", description: "Audit security vulnerabilities", filePath: "/skills/security/SKILL.md" }], sections: { skills: "<available_skills>security audit</available_skills>" } };
	const result = await handlers.get("before_agent_start")[0]({ prompt: "/skills list security audit", systemPromptOptions: options }, ctx);
	assert.equal(result, undefined);
	const explicitSkill = await handlers.get("before_agent_start")[0]({ prompt: '<skill name="security-audit">instructions</skill>', systemPromptOptions: options }, ctx);
	assert.equal(explicitSkill, undefined);
});

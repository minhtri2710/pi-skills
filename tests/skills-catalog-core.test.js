import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSkillCatalogHint, findAutoloadSkill, getAutoloadedSkills, getDisabledSkills, getLastState, isExplicitSkillInvocation, loadSkill, matchSkills, stripFrontmatter } from "../extensions/skills-catalog-core.js";

const skills = [
	{ name: "frontend-design", description: "Design polished responsive frontend interfaces" },
	{ name: "security-audit", description: "Audit code for security vulnerabilities" },
	{ name: "bug-diagnosis", description: "Diagnose hard bugs and failing tests" },
];

test("per-skill settings use the latest branch state", () => {
	assert.deepEqual(getDisabledSkills([
		{ type: "custom", customType: "skills-catalog-disabled", data: { names: ["security-audit"] } },
		{ type: "custom", customType: "skills-catalog-disabled", data: { names: ["bug-diagnosis", "bug-diagnosis", 4] } },
	]), ["bug-diagnosis"]);
	assert.deepEqual(getDisabledSkills([]), []);
});

test("session catalog setting uses the most recent state on the active branch", () => {
	assert.equal(getLastState([
		{ type: "custom", customType: "skills-catalog-state", data: { enabled: true } },
		{ type: "custom", customType: "other", data: { enabled: false } },
		{ type: "custom", customType: "skills-catalog-state", data: { enabled: false } },
	]), false);
	assert.equal(getLastState([{ type: "custom", customType: "skills-catalog-state", data: { enabled: true } }]), true);
	assert.equal(getLastState([]), false);
});

test("skill matching ranks name hits and avoids generic one-word autoloads", () => {
	assert.equal(matchSkills("frontend responsive design", skills)[0].skill.name, "frontend-design");
	assert.equal(findAutoloadSkill("please help me", skills), undefined);
	assert.equal(findAutoloadSkill("audit security vulnerabilities", skills).skill.name, "security-audit");
	assert.equal(findAutoloadSkill("/skills list security audit", skills), undefined);
	assert.equal(findAutoloadSkill("/skill:security-audit", skills), undefined);
	assert.equal(findAutoloadSkill('<skill name="security-audit">body</skill>\n\nAudit code', skills), undefined);
	assert.equal(isExplicitSkillInvocation("/skill:security-audit"), true);
	assert.equal(isExplicitSkillInvocation("audit security vulnerabilities"), false);
});

test("frontmatter is removed without changing the skill instructions", () => {
	assert.equal(stripFrontmatter("---\nname: x\ndescription: y\n---\n\n# Instructions\nDo the work."), "# Instructions\nDo the work.");
	assert.equal(stripFrontmatter("\uFEFF---\r\nname: x\r\n---\r\nBody"), "Body");
	assert.equal(stripFrontmatter("# No frontmatter"), "# No frontmatter");
});

test("catalog hint stays inside the skill section", () => {
	assert.match(addSkillCatalogHint("<available_skills>\n</available_skills>"), /skill_search.*available_skills/s);
	assert.equal(addSkillCatalogHint("skills hidden"), "skills hidden");
});

test("loading a skill resolves its directory and bounds output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-skills-test-"));
	try {
		const filePath = join(directory, "SKILL.md");
		await writeFile(filePath, "---\nname: test\ndescription: test\n---\n0123456789", "utf8");
		const loaded = await loadSkill({ name: "test", filePath }, 5);
		assert.match(loaded, new RegExp(`location="${filePath}"`));
		assert.match(loaded, new RegExp(`References are relative to ${directory.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`));
		assert.match(loaded, /01234\n\[Skill content truncated\.\]/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("autoloaded skills are tracked from branch entries across entry shapes", () => {
	assert.deepEqual(getAutoloadedSkills([
		{ type: "custom", customType: "skill-autoload", details: { skill: "security-audit" } },
		{ type: "custom", customType: "other", details: { skill: "ignored" } },
		{ type: "custom", customType: "skill-autoload", data: { skill: "bug-diagnosis" } },
		{ type: "message", customType: "skill-autoload", message: { details: { skill: "frontend-design" } } },
		{ type: "custom", customType: "skill-autoload", details: { skill: "security-audit" } },
	]), ["security-audit", "bug-diagnosis", "frontend-design"]);
	assert.deepEqual(getAutoloadedSkills([]), []);
});

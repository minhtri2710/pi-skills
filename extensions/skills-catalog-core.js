import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

const STATE_ENTRY = "skills-catalog-state";
const DISABLED_SKILLS_ENTRY = "skills-catalog-disabled";
const STOP_WORDS = new Set([
	"about", "after", "also", "and", "any", "are", "can", "could", "for", "from", "have", "help", "how", "into", "make", "need", "please", "that", "the", "this", "use", "using", "with", "work",
	"các", "có", "cho", "giúp", "khi", "là", "một", "này", "tôi", "trong", "và", "với",
]);

export function getLastState(entries) {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === STATE_ENTRY && typeof entry.data?.enabled === "boolean") {
			return entry.data.enabled;
		}
	}
	return false;
}

export function getDisabledSkills(entries) {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === DISABLED_SKILLS_ENTRY) {
			return Array.isArray(entry.data?.names) ? [...new Set(entry.data.names.filter((name) => typeof name === "string"))] : [];
		}
	}
	return [];
}

export function getAutoloadedSkills(entries) {
	const names = new Set();
	for (const entry of entries) {
		if (entry?.customType === "skill-autoload") {
			const skill = entry.details?.skill ?? entry.data?.skill ?? entry.message?.details?.skill;
			if (typeof skill === "string") names.add(skill);
		}
	}
	return [...names];
}

function tokenize(value) {
	return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function matchSkills(query, skills) {
	const queryTerms = new Set(tokenize(query).filter((term) => !STOP_WORDS.has(term)));
	if (queryTerms.size === 0) return [];
	return skills.map((skill) => {
		const nameTerms = new Set(tokenize(skill.name));
		const descriptionTerms = new Set(tokenize(skill.description));
		const matchedTerms = [...queryTerms].filter((term) => nameTerms.has(term) || descriptionTerms.has(term));
		const score = matchedTerms.reduce((total, term) => total + (nameTerms.has(term) ? 3 : 1), 0);
		return { skill, score, matchedTerms: matchedTerms.length };
	}).filter((match) => match.matchedTerms > 0)
		.sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name));
}

export function isExplicitSkillInvocation(prompt) {
	const input = prompt.trimStart();
	return input.startsWith("/skill:") || input.startsWith('<skill name="');
}

export function findAutoloadSkill(prompt, skills) {
	if (isExplicitSkillInvocation(prompt) || prompt.trimStart().startsWith("/")) return undefined;
	return matchSkills(prompt, skills).find((candidate) => candidate.matchedTerms >= 2);
}

export function stripFrontmatter(content) {
	return content.replace(/^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "").trim();
}

export function addSkillCatalogHint(value) {
	const hint = "Use skill_search for matching specialized instructions; use /skill:name for explicit invocation.";
	return value.includes("<available_skills>") ? value.replace("</available_skills>", `${hint}\n</available_skills>`) : value;
}

export async function loadSkill(skill, maxChars = 24_000) {
	const body = stripFrontmatter(await readFile(skill.filePath, "utf8"));
	const truncated = body.length > maxChars;
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirname(skill.filePath)}.\n\n${body.slice(0, maxChars)}${truncated ? "\n[Skill content truncated.]" : ""}\n</skill>`;
}

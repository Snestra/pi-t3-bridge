import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { claimName } from "./claim.ts";

interface CatalogSkill {
  readonly description: string;
  readonly disableModelInvocation?: boolean;
  readonly filePath: string;
  readonly name: string;
}

interface PromptTools {
  readonly hiddenTools: readonly string[];
  readonly selectedTools: readonly string[];
}

const SKILL_FILE = "SKILL.md";

const oneLine = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

// A skill at <root>/<name>/SKILL.md shares its root's path pattern. Any other
// layout keeps its own path, since <name> would not resolve to it.
const skillRoot = (skill: CatalogSkill): string | undefined => {
  const skillDir = path.dirname(skill.filePath);

  return path.basename(skill.filePath) === SKILL_FILE &&
    path.basename(skillDir) === skill.name
    ? path.dirname(skillDir)
    : undefined;
};

// Name the tool that loads a skill file, as Pi's own catalog does. With only
// codemode declared, read is reachable through a script, so name no tool.
const readerVerb = ({ hiddenTools, selectedTools }: PromptTools): string => {
  const declared = new Set(
    selectedTools.filter((name) => !hiddenTools.includes(name))
  );

  if (declared.has("read")) {
    return "read";
  }

  if (declared.has("bash")) {
    return "cat";
  }

  return "load";
};

const compactSkillCatalog = (
  skills: readonly CatalogSkill[],
  tools: PromptTools
): string => {
  const groups = new Map<string, string[]>();
  const loose: string[] = [];

  for (const skill of skills) {
    if (skill.disableModelInvocation) {
      continue;
    }

    const line = `- ${skill.name}: ${oneLine(skill.description)}`;
    const root = skillRoot(skill);

    if (root === undefined) {
      loose.push(`${line} (${skill.filePath})`);
    } else {
      const pattern = path.join(root, "<name>", SKILL_FILE);
      groups.set(pattern, [...(groups.get(pattern) ?? []), line]);
    }
  }

  if (groups.size === 0 && loose.length === 0) {
    return "";
  }

  return [
    `Skills give instructions for specific kinds of work. When a task matches a description, ${readerVerb(tools)} that skill's file before you act. Its path is the pattern above its list with <name> replaced, or the path after it. Resolve relative paths in a skill against its folder.`,
    ...[...groups].flatMap(([pattern, lines]) => ["", pattern, ...lines]),
    ...(loose.length > 0 ? ["", ...loose] : []),
  ].join("\n");
};

// Another package's skills tool hides Pi's catalog and serves skills itself.
export const registerSkills = (pi: ExtensionAPI): void => {
  const taken = claimName(pi, "skills", "pi-t3's skill catalog");

  pi.on("before_agent_start", (event) => {
    if (taken()) {
      return;
    }

    const options = event.systemPromptOptions;
    const catalog = compactSkillCatalog(options.skills, options);

    if (catalog) {
      options.sections.skills = catalog;
    }
  });
};

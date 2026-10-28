import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolSpec } from "./tools.js";

/**
 * The application's skills: a folder of `<folder>/SKILL.md`, each with a YAML
 * frontmatter naming and describing it. Claude Code loads them natively; for
 * providers that would need a shell to read them (Codex), the library serves
 * them through `read_skill` instead.
 */

export interface SkillInfo {
  folder: string;
  name: string;
  description: string;
}

/** `name` and `description` from a SKILL.md frontmatter: one-line values, quoted or not, and folded blocks. */
export function frontmatter(text: string): Record<string, string> {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!m) return {};
  const fields: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) block.push(lines[++i]!.trim());
      value = value.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    fields[kv[1]!] = value;
  }
  return fields;
}

export function listSkills(dir: string): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const skills: SkillInfo[] = [];
  for (const folder of readdirSync(dir).sort()) {
    const file = join(dir, folder, "SKILL.md");
    try {
      if (folder.startsWith(".") || !statSync(join(dir, folder)).isDirectory() || !existsSync(file)) continue;
      const fields = frontmatter(readFileSync(file, "utf8"));
      skills.push({ folder, name: fields.name || folder, description: fields.description ?? "" });
    } catch {
      /* unreadable: left out */
    }
  }
  return skills;
}

const MAX_FILE = 256 << 10;

/**
 * A file of one skill, `SKILL.md` by default. The path must stay inside that
 * skill's folder, links included.
 */
export function readSkillFile(dir: string, skill: string, file = "SKILL.md"): string {
  const found = listSkills(dir).find((s) => s.name === skill || s.folder === skill);
  if (!found) throw new Error(`there is no skill named "${skill}"`);
  const root = realpathSync(join(dir, found.folder));
  if (isAbsolute(file)) throw new Error("the file must be a path inside the skill's folder");
  const target = resolve(root, file);
  if (!existsSync(target)) throw new Error(`the skill has no file "${file}"`);
  const real = realpathSync(target);
  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) throw new Error("the file must be a path inside the skill's folder");
  if (!statSync(real).isFile()) throw new Error(`"${file}" is not a file`);
  if (statSync(real).size > MAX_FILE) throw new Error(`"${file}" is too large to read`);
  return readFileSync(real, "utf8");
}

export const READ_SKILL_TOOL = "read_skill";

export const readSkillSpec: ToolSpec = {
  name: READ_SKILL_TOOL,
  description: "Reads a skill's instructions (SKILL.md), or another file inside that skill's folder that the instructions mention. Read a skill before following it.",
  inputSchema: {
    type: "object",
    properties: {
      skill: { type: "string", description: "The skill's name." },
      file: { type: "string", description: "A path inside the skill's folder; SKILL.md when omitted." },
    },
    required: ["skill"],
    additionalProperties: false,
  },
};

/** What the model is told about the skills when it cannot load them natively. */
export function skillsInstructions(skills: SkillInfo[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`);
  return `# Skills\n\nThese skills are available. When a request matches one, read it first with the \`${READ_SKILL_TOOL}\` tool and follow its instructions; read other files of a skill only when its instructions point to them.\n\n${lines.join("\n")}\n`;
}

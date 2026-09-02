// Where the plugin's files are, for every test that reads them from disk.
// One statement of the layout, so a folder that moves changes this file and
// nothing else. A document's name is the one the skill writes and the API
// quotes — `tasks/logging` — and its path is that name with `.md` on the end,
// beside SKILL.md.

export const PLUGIN = "plugin";
export const SKILL_DIR = `${PLUGIN}/skills/personal-trainer`;
export const SKILL = `${SKILL_DIR}/SKILL.md`;

export function documentPath(name: string): string {
  return `${SKILL_DIR}/${name}.md`;
}

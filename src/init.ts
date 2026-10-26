import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidInputError } from "./errors.js";
import { VERSION } from "./version.js";

/** Where projects fetch the server from: this exact version, straight from GitHub. */
export const SERVER_SPEC = `github:Makkov-design/ytlens#v${VERSION}`;

const SKILL_SOURCE = new URL("../skills/ytlens/SKILL.md", import.meta.url);

export interface InitResult {
  /** Paths written, relative to the project. */
  files: string[];
}

/**
 * `ytlens init`: adds ytlens to a project, so Claude Code (local or cloud) picks it up from the repository:
 * the server entry in `.mcp.json` (other servers are kept) and the skill in `.claude/skills/ytlens/`.
 */
export function initProject(projectDir: string): InitResult {
  const mcpPath = join(projectDir, ".mcp.json");
  let config: { mcpServers?: Record<string, unknown>; [key: string]: unknown } = {};
  if (existsSync(mcpPath)) {
    try {
      config = JSON.parse(readFileSync(mcpPath, "utf8"));
    } catch {
      throw new InvalidInputError(`${mcpPath} is not valid JSON. Fix or remove it, then run init again.`);
    }
  }
  config.mcpServers = {
    ...config.mcpServers,
    ytlens: {
      command: "npx",
      args: ["-y", SERVER_SPEC],
      env: { GEMINI_API_KEY: "${GEMINI_API_KEY}" },
    },
  };
  writeFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`);

  const skillDir = join(projectDir, ".claude", "skills", "ytlens");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), readFileSync(SKILL_SOURCE, "utf8"));

  return { files: [".mcp.json", ".claude/skills/ytlens/SKILL.md"] };
}

export const INIT_NEXT_STEPS = `
Next steps:
  1. Commit .mcp.json and .claude/skills/ytlens/ to the repository.
  2. Make GEMINI_API_KEY available where Claude Code runs:
     - cloud sessions (claude.ai/code): add GEMINI_API_KEY=<your key> to the environment's variables;
     - on your computer: set GEMINI_API_KEY as an environment variable.
     Get a key at https://aistudio.google.com/apikey
  3. Start a new Claude Code session in the project and share a YouTube link.
`;

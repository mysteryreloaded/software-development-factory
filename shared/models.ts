import type { CliId, CustomProvider } from './types.ts';

// Which model an agent's session asks for. The office's default model belongs to its default coding agent, and each
// worker can name their own; a model only goes to an agent that understands it (no Claude model for Codex).

/** Claude Code's model names and aliases. */
export const isClaudeModel = (model: string) => /^(claude|opus|sonnet|haiku|fable|default|best|opusplan)\b/i.test(model.trim());

/**
 * The model for a worker on `cli`: a custom provider (#113) always asks for its own `<id>/<model>`, since OpenCode
 * must pick that provider's one model; a built-in CLI gets the agent's own model if it suits, else the office
 * default when `cli` is the default agent, else `claudeDefault` for Claude Code, or '' for any other agent's own default.
 */
export function effectiveModel(own: string, cli: CliId, office: { defaultCli: CliId; defaultModel: string }, claudeDefault: string, customProviders: readonly CustomProvider[] = []): string {
  const custom = customProviders.find((p) => p.id === cli);
  if (custom) return `${custom.id}/${custom.model}`;
  const suits = (m: string) => m.trim() !== '' && (cli === 'claude') === isClaudeModel(m);
  if (suits(own)) return own.trim();
  if (cli === office.defaultCli && suits(office.defaultModel)) return office.defaultModel.trim();
  return cli === 'claude' ? claudeDefault : '';
}

/** Claude Code models offered as suggestions in the office's model fields. */
export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5'];

/** Model suggestions for a coding agent; any other name can still be typed. OpenCode names are `provider/model`. */
export function modelSuggestions(cli: CliId): string[] {
  if (cli === 'claude') return CLAUDE_MODELS;
  if (cli === 'codex') return ['gpt-5.5-codex', 'gpt-5.5'];
  return CLAUDE_MODELS.map((m) => `anthropic/${m}`);
}

import type { LlmAdapter } from "./adapter.js"
import { AnthropicAdapter } from "./anthropic.js"
import { OpenAiAdapter } from "./openai.js"

export interface LlmEnvironment {
  LLM_PROVIDER?: string
  LLM_MODEL?: string
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

export function createLlmAdapterFromEnv(env: LlmEnvironment): LlmAdapter {
  const provider = required(env.LLM_PROVIDER, "LLM_PROVIDER").toLowerCase()
  const model = required(env.LLM_MODEL, "LLM_MODEL")
  if (provider === "anthropic") {
    return new AnthropicAdapter({ apiKey: required(env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY"), model })
  }
  if (provider === "openai") {
    return new OpenAiAdapter({ apiKey: required(env.OPENAI_API_KEY, "OPENAI_API_KEY"), model })
  }
  throw new Error("LLM_PROVIDER must be 'anthropic' or 'openai'")
}

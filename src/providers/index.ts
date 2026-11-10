import type { ProviderAdapter, ProviderKind } from '../types.js';
import { openaiAdapter } from './openai.js';
import { anthropicAdapter } from './anthropic.js';
import { geminiAdapter } from './gemini.js';
export { openaiAdapter, openaiCapabilities } from './openai.js';
export { anthropicAdapter, anthropicCapabilities } from './anthropic.js';
export { geminiAdapter, geminiCapabilities } from './gemini.js';
export const providerAdapters: Record<ProviderKind, ProviderAdapter> = { openai: openaiAdapter, anthropic: anthropicAdapter, gemini: geminiAdapter };
export const adapters = providerAdapters;

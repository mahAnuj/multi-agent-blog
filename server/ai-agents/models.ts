// Models the dashboard may pick from. The web-search step is pinned separately
// because only search-enabled models can serve it.
export const AVAILABLE_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
] as const;

export type ChatModel = (typeof AVAILABLE_MODELS)[number];

export const DEFAULT_MODEL: ChatModel = "gpt-4o";

/** Web-search-enabled model, not user-selectable. */
export const SEARCH_MODEL = "gpt-4o-search-preview";

export function resolveModel(candidate: unknown): ChatModel {
  return (AVAILABLE_MODELS as readonly string[]).includes(candidate as string)
    ? (candidate as ChatModel)
    : DEFAULT_MODEL;
}

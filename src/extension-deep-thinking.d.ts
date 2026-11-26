export interface DeepThinkingState { enabled: boolean; prompted: boolean }
export const DEEP_THINKING_KIND: string;
export const DEEP_THINKING_KEYS: string[];
export function readDeepThinkingState(values?: Record<string, unknown>): DeepThinkingState;
export function deepThinkingChoice(enabled: boolean): Record<string, boolean>;
export function isDeepThinkingTarget(value?: string): boolean;

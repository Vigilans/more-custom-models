/** The custom alias an Agent call named, held from its `tool.call` to its `agent.spawn`. */
export type PendingAlias = { alias: string; model: string }

declare module 'claude-code' {
  interface PluginState {
    'more-custom-models': {
      /** Keyed by the Agent call's `tool_use_id`; `null` once its spawn took it. */
      pending: StateFamily<PendingAlias | null>
    }
  }
}

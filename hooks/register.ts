import type { EngineInterface, Register } from 'claude-code'

// Custom aliases: ANTHROPIC_DEFAULT_<ALIAS>_MODEL names the model ID behind
// <alias>, the ENV_STYLE name in kebab-case (GPT_SOL -> gpt-sol). They extend
// the built-in aliases below, which Claude Code resolves itself.
//
// Subagent models, read when an Agent spawns; first match wins:
//   CLAUDE_CODE_SUBAGENT_<TYPE>_MODEL          the agent type, ENV_STYLE
//   CLAUDE_CODE_SUBAGENT_INHERIT_<ALIAS>_MODEL the call and the agent
//   CLAUDE_CODE_SUBAGENT_INHERIT_MODEL         definition pick no model, and
//                                              the parent runs on <ALIAS>
//   CLAUDE_CODE_SUBAGENT_<ALIAS>_MODEL         the model picked, explicit or
//                                              inherited, is <ALIAS>
// CLAUDE_CODE_SUBAGENT_MODEL stays Claude Code's own default. Each value may
// name a custom alias as gpt-sol or GPT_SOL. A subagent left
// to inherit runs on its parent's model, written into the spawn so that a
// SendMessage resume keeps it after the parent switches models.
//
// CLAUDE_CODE_SUBAGENT_MODE=bypassPermissions+dontAsk denies a subagent's
// permission requests, telling it how to go on, so no prompt waits for the
// user; the main thread keeps its prompts.

const BUILT_IN = ['sonnet', 'opus', 'haiku', 'fable']
// The Agent model a custom alias crosses the native input schema as.
const PLACEHOLDER = 'haiku'
const INHERIT = ['', 'inherit', 'default']
const ONE_MILLION = '[1m]'

type Env = Record<string, string>

async function readEnv($: EngineInterface): Promise<Env> {
  const { env } = await $.settings.read()
  return (env ?? {}) as Env
}

const envName = (name: string) => name.toUpperCase().replace(/-/g, '_')
const stripSuffix = (model: string) => model.replace(/\[.*$/, '')

/** Custom alias -> model ID, in settings order. */
function customAliases(env: Env): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const [key, model] of Object.entries(env)) {
    const name = /^ANTHROPIC_DEFAULT_([A-Z0-9_]+)_MODEL$/.exec(key)?.[1]
    const alias = name?.toLowerCase().replace(/_/g, '-')
    if (alias && model && !BUILT_IN.includes(alias)) aliases.set(alias, model)
  }
  return aliases
}

/** The model ID a custom alias, in either case and either separator, with an optional [1m], stands for. */
function resolveAlias(name: string, aliases: Map<string, string>): string | undefined {
  const requested = name.trim().toLowerCase().replace(/_/g, '-')
  const wantsMillion = requested.endsWith(ONE_MILLION)
  const model = aliases.get(stripSuffix(requested))
  if (!model) return
  return wantsMillion && !model.endsWith(ONE_MILLION) ? model + ONE_MILLION : model
}

/** The ENV_STYLE alias a model name or ID runs as. */
function aliasOf(model: string, env: Env): string | undefined {
  if (INHERIT.includes(model)) return
  const base = stripSuffix(model)
  const name = envName(base)
  if (BUILT_IN.includes(base.toLowerCase()) || env[`ANTHROPIC_DEFAULT_${name}_MODEL`]) return name

  const configured: [string, string][] = []
  for (const [key, value] of Object.entries(env)) {
    const alias = /^ANTHROPIC_DEFAULT_([A-Z0-9_]+)_MODEL$/.exec(key)?.[1]
    if (alias && value) configured.push([alias, stripSuffix(value)])
  }
  const exact = configured.find(([, id]) => id === base)
  if (exact) return exact[0]
  const partial = configured.find(([, id]) => id.includes(base) || base.includes(id))
  if (partial) return partial[0]

  const family = BUILT_IN.find(family => base.toLowerCase().includes(family))
  return family ? family.toUpperCase() : base.toUpperCase().replace(/[-.]/g, '_')
}

/** The `model:` of an agent definition: project agents shadow user agents. */
async function definitionModel($: EngineInterface, type: string): Promise<string> {
  const home = await $.env.get('HOME')
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  for (const dir of ['.claude/agents', `${config}/agents`]) {
    const file = `${dir}/${type}.md`
    if (!(await $.fs.exists(file))) continue
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(await $.fs.read(file))?.[1] ?? ''
    const model = /^model:[ \t]*(.*?)[ \t]*$/m.exec(frontmatter)?.[1] ?? ''
    return model.replace(/^(["'])(.*)\1$/, '$2')
  }
  return ''
}

export const register: Register = on => {
  // Offer the custom aliases in every Agent.model enum the engine sends.
  on('http.fetch', async ($, e, next) => {
    const body = e.init?.body
    if (next.origin.plugin !== 'engine' || typeof body !== 'string' || !body.includes('"Agent"')) {
      return next(e)
    }
    const aliases = [...customAliases(await readEnv($)).keys()]
    if (!aliases.length) return next(e)

    let request: { tools?: { name?: string; input_schema?: { properties?: { model?: { enum?: unknown } } } }[] }
    try {
      request = JSON.parse(body)
    } catch {
      return next(e)
    }
    const schema = request.tools?.find(tool => tool.name === 'Agent')?.input_schema?.properties?.model
    if (!Array.isArray(schema?.enum)) return next(e)
    const missing = aliases.filter(alias => !(schema.enum as unknown[]).includes(alias))
    if (!missing.length) return next(e)
    schema.enum = [...schema.enum, ...missing]
    return next({ ...e, init: { ...e.init, body: JSON.stringify(request) } })
  })

  // A custom alias passes Agent's own schema as the placeholder; its spawn
  // takes the model back under the same tool_use_id.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const alias = e.model?.toLowerCase()
    const model = alias && resolveAlias(alias, customAliases(await readEnv($)))
    if (!alias || !model) return next(e)
    await $.state.set({ plugin: 'more-custom-models', key: 'pending', id: e.tool_use_id }, { alias, model })
    return next({ ...e, model: PLACEHOLDER })
  })

  // Refused when it fails: an Agent call that named a custom alias would
  // otherwise run on the placeholder.
  on('agent.spawn', async ($, e, next) => {
    const held = (await $.state.get({ plugin: 'more-custom-models', key: 'pending', id: e.tool_use_id })).value
    if (held) await $.state.set({ plugin: 'more-custom-models', key: 'pending', id: e.tool_use_id }, null)
    if (e.fork || e.resume) return next(e)

    const env = await readEnv($)
    const aliases = customAliases(env)
    const resolve = (model: string) => resolveAlias(model, aliases) ?? model
    const requestedModel = held?.alias ?? e.model ?? ''

    // A workflow's agent() names its model in the script: only its alias resolves.
    if (e.workflow) {
      return requestedModel ? next({ ...e, model: resolve(requestedModel) }) : next(e)
    }

    const type = envName(e.subagentType)
    let model = /^[A-Z_][A-Z0-9_]*$/.test(type) ? env[`CLAUDE_CODE_SUBAGENT_${type}_MODEL`] : undefined

    let requested = INHERIT.includes(requestedModel) ? '' : requestedModel
    if (!requested) {
      const declared = await definitionModel($, e.subagentType)
      requested = INHERIT.includes(declared) ? '' : declared
    }

    if (!model) {
      const alias = aliasOf(requested || e.parentModel, env)
      if (!requested) {
        model = (alias && env[`CLAUDE_CODE_SUBAGENT_INHERIT_${alias}_MODEL`]) || env.CLAUDE_CODE_SUBAGENT_INHERIT_MODEL
      }
      model ||= alias && env[`CLAUDE_CODE_SUBAGENT_${alias}_MODEL`]
    }

    if (model) return next({ ...e, model: resolve(model) })
    if (requested) return next({ ...e, model: resolve(requested) })
    // Claude Code's own subagent default applies on resume as at spawn; a custom
    // alias there is one Claude Code cannot resolve, so its model ID is written.
    if (env.CLAUDE_CODE_SUBAGENT_MODEL) {
      const custom = resolveAlias(env.CLAUDE_CODE_SUBAGENT_MODEL, aliases)
      return custom ? next({ ...e, model: custom }) : next(e)
    }
    return next({ ...e, model: e.parentModel })
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: could not resolve the subagent's model.` },
  )

  // /model <alias> selects the model ID, which settings' modelPicker lists.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const model = e.args.trim() && resolveAlias(e.args, customAliases(await readEnv($)))
    return model ? next({ ...e, args: model }) : next(e)
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    const env = await readEnv($)
    if (env.CLAUDE_CODE_SUBAGENT_MODE !== 'bypassPermissions+dontAsk' || !e.agent_id) return next(e)

    const { permissions } = await $.settings.read()
    const askRules = ((permissions as { ask?: unknown[] } | undefined)?.ask ?? []).filter(rule => typeof rule === 'string')
    let message = 'Avoid commands and tools that require user approval; use an alternative and continue when possible.'
    if (askRules.length) {
      message += `\n\nConfigured commands that require user approval:\n${askRules.map(rule => `- ${rule}`).join('\n')}`
    }
    message +=
      '\n\nIf this action is essential and unavoidable, report the exact action, its purpose, and why it is necessary to the main agent. The main agent must ask the user and perform the action after approval.'
    return { decision: { behavior: 'deny', message } }
  })
}

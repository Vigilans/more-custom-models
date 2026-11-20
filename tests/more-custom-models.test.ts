import type { AgentSpawnInput, On } from 'claude-code'
import { describe, expect, test, type Engine } from 'claude-code/testing'

const ENV = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
  ANTHROPIC_DEFAULT_OPUS_ZDR_MODEL: 'claude-opus-5-5-zdr',
  ANTHROPIC_DEFAULT_GPT_SOL_MODEL: 'gpt-5.6-sol',
  ANTHROPIC_DEFAULT_GEMINI_MODEL: 'gemini-3.8-pro[1m]',
}

function settings(on: On, env: Record<string, string>, permissions: object = {}) {
  on('settings.read', () => ({ value: { env, permissions } }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
}

const SPAWN: AgentSpawnInput = {
  tool_use_id: 'call-1',
  prompt: 'look',
  description: 'look',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
}

/** Stands for the engine beneath Agent: its tool.call answers with the id
 * and model the call reached core with, and its spawn with the model. */
function engine(on: On) {
  const spawned: (string | undefined)[] = []
  on('agent.spawn', (_, e) => (spawned.push(e.model), { model: e.model ?? 'core' }))
  on('tool.call', { tool: 'Agent' }, (_, e) => ({ result: { id: e.tool_use_id, model: e.model } }))
  return spawned
}

/** An Agent call, then its spawn, as a session raises them. */
async function agent($: Engine, spawn: Partial<AgentSpawnInput> & { model?: string }) {
  const called = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', ...(spawn.model ? { model: spawn.model as never } : {}) })
  const { id, model } = called.result as { id: string; model?: string }
  await $.agent.spawn({ ...SPAWN, ...spawn, tool_use_id: id, model })
  return model
}

describe('agent.spawn', () => {
  test('a custom alias crosses the schema as the placeholder and spawns on its model ID', async ($, on) => {
    settings(on, ENV)
    const spawned = engine(on)
    expect(await agent($, { model: 'gpt-sol' })).toBe('haiku')
    expect(spawned).toEqual(['gpt-5.6-sol'])
  })

  test('parallel calls each spawn on their own model', async ($, on) => {
    settings(on, ENV)
    const spawned = engine(on)
    const a = await $.tool.call({ tool: 'Agent', description: 'a', prompt: 'a', model: 'gpt-sol' as never })
    const b = await $.tool.call({ tool: 'Agent', description: 'b', prompt: 'b', model: 'gemini' as never })
    const c = await $.tool.call({ tool: 'Agent', description: 'c', prompt: 'c', model: 'haiku' })
    const id = (r: typeof a) => (r.result as { id: string }).id
    await Promise.all([
      $.agent.spawn({ ...SPAWN, tool_use_id: id(c), model: 'haiku' }),
      $.agent.spawn({ ...SPAWN, tool_use_id: id(b), model: 'haiku' }),
      $.agent.spawn({ ...SPAWN, tool_use_id: id(a), model: 'haiku' }),
    ])
    expect(spawned.sort()).toEqual(['gemini-3.8-pro[1m]', 'gpt-5.6-sol', 'haiku'])
  })

  test('an alias call meets the alias override, never the placeholder one', async ($, on) => {
    settings(on, { ...ENV, CLAUDE_CODE_SUBAGENT_HAIKU_MODEL: 'wrong', CLAUDE_CODE_SUBAGENT_GPT_SOL_MODEL: 'gemini' })
    const spawned = engine(on)
    await agent($, { model: 'gpt-sol' })
    expect(spawned).toEqual(['gemini-3.8-pro[1m]'])
  })

  test('precedence: <TYPE> > INHERIT_<ALIAS> > INHERIT > <ALIAS>', async ($, on) => {
    const env = {
      ...ENV,
      CLAUDE_CODE_SUBAGENT_EXPLORE_MODEL: 'type',
      CLAUDE_CODE_SUBAGENT_INHERIT_OPUS_MODEL: 'inherit-opus',
      CLAUDE_CODE_SUBAGENT_INHERIT_MODEL: 'inherit',
      CLAUDE_CODE_SUBAGENT_OPUS_MODEL: 'opus-any',
    }
    settings(on, env)
    const spawned = engine(on)
    await agent($, { subagentType: 'Explore' })
    await agent($, {})
    await agent($, { parentModel: 'gpt-5.6-sol' })
    await agent($, { model: 'opus' })
    expect(spawned).toEqual(['type', 'inherit-opus', 'inherit', 'opus-any'])
  })

  test('an exact alias name wins over a model ID that contains it', async ($, on) => {
    settings(on, { ...ENV, CLAUDE_CODE_SUBAGENT_OPUS_MODEL: 'opus-any', CLAUDE_CODE_SUBAGENT_OPUS_ZDR_MODEL: 'zdr' })
    const spawned = engine(on)
    await agent($, { model: 'opus' })
    await agent($, { model: 'opus-zdr' })
    await agent($, { parentModel: 'claude-opus-5-5-zdr' })
    expect(spawned).toEqual(['opus-any', 'zdr', 'zdr'])
  })

  test('an inherited model is written into the spawn; Claude Code\'s default is left to it', async ($, on) => {
    settings(on, ENV)
    const spawned = engine(on)
    await agent($, { parentModel: 'gpt-5.6-sol' })
    expect(spawned).toEqual(['gpt-5.6-sol'])
  })

  test('CLAUDE_CODE_SUBAGENT_MODEL leaves an inheriting spawn to Claude Code', async ($, on) => {
    settings(on, { ...ENV, CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' })
    const spawned = engine(on)
    await agent($, {})
    expect(spawned).toEqual([undefined])
  })

  test('CLAUDE_CODE_SUBAGENT_MODEL naming a custom alias spawns on its model ID', async ($, on) => {
    settings(on, { ...ENV, CLAUDE_CODE_SUBAGENT_MODEL: 'GPT_SOL' })
    const spawned = engine(on)
    await agent($, {})
    expect(spawned).toEqual(['gpt-5.6-sol'])
  })

  test('an override names its alias in either form', async ($, on) => {
    settings(on, { ...ENV, CLAUDE_CODE_SUBAGENT_EXPLORE_MODEL: 'GPT_SOL', CLAUDE_CODE_SUBAGENT_INHERIT_MODEL: 'gemini' })
    const spawned = engine(on)
    await agent($, { subagentType: 'Explore' })
    await agent($, {})
    expect(spawned).toEqual(['gpt-5.6-sol', 'gemini-3.8-pro[1m]'])
  })

  test('an agent definition\'s custom alias resolves to its model ID', async ($, on) => {
    on('settings.read', () => ({ value: { env: ENV } }))
    on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
    on('fs.exists', (_, e) => ({ value: e.path === '/home/me/.claude/agents/scout.md' }))
    on('fs.read', () => ({ value: '---\nname: scout\nmodel: "gpt-sol"\n---\nbody\nmodel: other\n' }))
    const spawned = engine(on)
    await agent($, { subagentType: 'scout' })
    expect(spawned).toEqual(['gpt-5.6-sol'])
  })

  test('forks and resumes pass through, taking any held alias with them', async ($, on) => {
    settings(on, { ...ENV, CLAUDE_CODE_SUBAGENT_FORK_MODEL: 'never' })
    const spawned = engine(on)
    await agent($, { model: 'gpt-sol', subagentType: 'fork', fork: true })
    await $.agent.spawn({ ...SPAWN, resume: { agentId: 'a1' } })
    expect(spawned).toEqual(['haiku', undefined])
  })

  test('a workflow agent resolves its alias and nothing else', async ($, on) => {
    settings(on, { ...ENV, CLAUDE_CODE_SUBAGENT_GENERAL_PURPOSE_MODEL: 'never' })
    const spawned = engine(on)
    const workflow = { runId: 'wf_1', agentIndex: 1 }
    await $.agent.spawn({ ...SPAWN, workflow, model: 'gpt-sol' })
    await $.agent.spawn({ ...SPAWN, workflow })
    expect(spawned).toEqual(['gpt-5.6-sol', undefined])
  })

  test('a failed resolution refuses the spawn', async ($, on) => {
    on('settings.read', () => {
      throw new Error('unreadable')
    })
    engine(on)
    const result = await $.agent.spawn({ ...SPAWN })
    expect(result).toEqual({ deny: 'more-custom-models: could not resolve the subagent\'s model.' })
  })
})

describe('command.run', () => {
  test('/model <alias> selects the model ID, keeping a [1m] asked for', async ($, on) => {
    settings(on, ENV)
    const ran: string[] = []
    on('command.run', (_, e) => (ran.push(e.args), {}))
    const run = (args: string) =>
      $.command.run({ command: 'model', args, origin: { kind: 'composer' } as never, presentation: undefined as never })
    await run('gpt-sol')
    await run(' GPT-SOL[1m] ')
    await run('gemini[1m]')
    await run('gpt_sol')
    await run('gpt-5.6-sol')
    await run('opus')
    await run('')
    expect(ran).toEqual(['gpt-5.6-sol', 'gpt-5.6-sol[1m]', 'gemini-3.8-pro[1m]', 'gpt-5.6-sol', 'gpt-5.6-sol', 'opus', ''])
  })
})

describe('classic.PermissionRequest', () => {
  const request = { tool_name: 'Bash', tool_input: { command: 'git push' } }

  test('denies a subagent\'s request under bypassPermissions+dontAsk, naming the ask rules', async ($, on) => {
    settings(on, { CLAUDE_CODE_SUBAGENT_MODE: 'bypassPermissions+dontAsk' }, { ask: ['Bash(git push:*)', 3] })
    on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } }))
    const result = await $.classic.PermissionRequest({ ...request, agent_id: 'a1' })
    expect(result.decision?.behavior).toBe('deny')
    expect(result.decision?.behavior === 'deny' && result.decision.message).toContain('- Bash(git push:*)\n\nIf this action')
  })

  test('leaves the main thread and other modes to the user', async ($, on) => {
    settings(on, { CLAUDE_CODE_SUBAGENT_MODE: 'bypassPermissions+dontAsk' })
    on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } }))
    expect((await $.classic.PermissionRequest(request)).decision?.behavior).toBe('allow')
  })
})

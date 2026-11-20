# more-custom-models

Claude Code offers a single custom model option beside its built-in aliases. This plugin extends that to any number of model aliases, usable in `/model`, the model picker and Agent calls, and routes subagents to models by agent type or alias.

It is a function-hooks plugin and requires Claude Code 2.1.322 or later.

## Install

```text
/plugin install more-custom-models --marketplace Vigilans/agents
```

## Configuration

The plugin reads its variables from the `env` block of Claude Code's settings files.

### Model aliases

`ANTHROPIC_DEFAULT_<ALIAS>_MODEL` registers `<alias>`, the name in kebab-case (`GPT_SOL` becomes `gpt-sol`), beside the built-in aliases. `/model <alias>` selects its model ID, and Agent calls accept it as `model`.

List each model ID under `modelPicker` in user settings so that the `/model` picker offers it and `/model` selects it without a validation request:

```json
{
  "env": {
    "ANTHROPIC_DEFAULT_GPT_SOL_MODEL": "gpt-5.6-sol"
  },
  "modelPicker": {
    "options": [
      { "model": "gpt-5.6-sol", "label": "GPT-5.6 Sol", "description": "Custom gpt-sol model" }
    ]
  }
}
```

### Subagent models

`CLAUDE_CODE_SUBAGENT_<TYPE>_MODEL`, `CLAUDE_CODE_SUBAGENT_INHERIT_<ALIAS>_MODEL`, `CLAUDE_CODE_SUBAGENT_INHERIT_MODEL` and `CLAUDE_CODE_SUBAGENT_<ALIAS>_MODEL` pick a subagent's model, in that order of precedence:

- `<TYPE>` is the agent type in ENV_STYLE (`re-analyst` becomes `RE_ANALYST`).
- The `INHERIT` variables apply when neither the Agent call nor the agent definition names a model, the `<ALIAS>` one when the parent runs on `<ALIAS>`.
- `CLAUDE_CODE_SUBAGENT_<ALIAS>_MODEL` applies to whichever model the subagent would run on, named in the call, the definition, or inherited.

A subagent left to inherit runs on its parent's model, and keeps it when SendMessage resumes the subagent after the parent switches models.

These variables and Claude Code's own `CLAUDE_CODE_SUBAGENT_MODEL` take a model ID or an alias, written as `gpt-sol` or `GPT_SOL`.

### Subagent permission requests

`CLAUDE_CODE_SUBAGENT_MODE=bypassPermissions+dontAsk` denies subagents' permission requests, telling the subagent to continue without the action or to report it to the main agent. The main thread keeps its permission prompts.

## How Agent calls reach a custom alias

Claude Code's Agent tool accepts only the built-in aliases as `model`. The plugin adds the custom aliases to the Agent tool's `model` enum in each request Claude Code sends, lets a call naming one pass Claude Code's own input check as `haiku`, and spawns the subagent on the alias's model ID.

Claude Code refuses a request a plugin rewrites while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, so set `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and `DISABLE_AUTOUPDATER` individually instead. A signed request no longer verifies after the rewrite, and where an organization loads its own guard plugin, other plugins do not see Claude Code's requests.

## Development

```shell
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

[MIT](LICENSE)

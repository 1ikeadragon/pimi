---
title: Pimi models
description: Which models Pimi uses for chat titles, branch names, commit messages, pull request text, Describe it, provider switch summaries, and Ask Pimi, and how to configure them.
nav: Pimi models
order: 42
category: Configuration
---

# Pimi models

Pimi asks a language model to write short pieces of text for you so you don't have to. This is separate from the agent you're talking to: it's a small, one-shot call made in the background.

Pimi generates these kinds of metadata:

- **Chat titles** — a short, task-shaped name based on the first message, shown in the sidebar and chat header.
- **Worktree branch names** — a slug for a new worktree-isolated chat's branch.
- **Commit messages** — a concise message for the changes you're committing.
- **Pull request title and body** — drafted from the diff when you open a PR.
- **Describe it** — turns an automation description into a draft automation.
- **Provider switch summary** — the summary of a chat's history that the new provider receives when you switch a chat to another provider, or when a limit moves it. It reads the whole chat, so pick a model with a large context.
- **Ask Pimi** — the voice command assistant. It runs only on Claude Code, Codex, or OpenCode.

A chat title and its branch name are produced together from the same prompt, but you configure their wording independently (see below).

## How a model is chosen

Pimi has two modes. **Automatic** is the default and needs no configuration. **Manual** uses only the models you choose.

In Automatic mode, Pimi builds an ordered list of candidates and tries each one until a generation succeeds, so a slow or unavailable model falls through to the next:

1. **Built-in defaults**, matched against the models of the providers you have enabled:
   1. a `haiku` model
   2. `gpt-5.4-mini` (low reasoning)
   3. `minimax-m3`
   4. `nemotron-3-super`
2. **The model currently selected** for that agent or draft, as a last resort.

Each default is a match on the model id or name, so the first enabled provider that ships a matching model wins. Defaults with no match are skipped. Duplicates are removed, then generation tries the list top to bottom. The default order prefers small, fast, cheap models for these short tasks before falling back to whatever you have selected.

In Manual mode, Pimi tries only your configured models, in your order. It never adds the built-in defaults or the selected model, so your prompts and diffs only go to providers you chose. If every configured model is unavailable, generation fails with an error naming the model: chat titles and branch names are not generated, and commit and pull request generation report the error. If a configured model is available but its run fails, commits and pull requests get placeholder text. Pick a model that works for these tasks.

Every failure is written to `$PIMI_HOME/daemon.log` (`~/.pimi/daemon.log` by default) with the provider, the model and the error. Look there when a manual model doesn't produce titles, branch names, commit messages or pull request text.

## Choose a model

Open **Settings → Host → Pimi models** and select **Automatic** or **Manual**. In Manual mode, pick the model Pimi uses. Choosing a model replaces the first entry in `agents.metadataGeneration.providers` and preserves the rest of the list. Switching back to Automatic clears the list.

**Automatically name chats and branches** is on by default for each host. Turn it off to keep the initial titles and worktree branch names. Pimi keeps titles you’ve edited and still generates commit messages and PR drafts on request.

## Use a different model for one feature

The **Per feature** card lists chat titles, branch names, commit messages, pull request text, Describe it, and Ask Pimi. A row left on **Same as default** follows the default above. Pick a model, and optionally a thinking level, to override one row. **Reset** returns it to the default.

A feature override is exact: if its provider is turned off or its model is gone, that feature shows an error and Pimi does not try another model. Overrides live in `agents.metadataGeneration.features` in `config.json`, keyed `title`, `branchName`, `commitMessage`, `pullRequest`, `automation`, and `askPimi`, each with the same `provider`, `model`, and `thinkingOptionId` fields as a list entry.

Every call logs `Pimi model call` with the feature, provider, model, and thinking level to `daemon.log`.

## Configure a custom fallback order

To use more than one model in Manual mode, list them in `agents.metadataGeneration.providers` in `~/.pimi/config.json`. Pimi tries your entries in order and nothing else. An empty list means Automatic.

```json
{
  "agents": {
    "metadataGeneration": {
      "providers": [
        { "provider": "claude", "model": "claude-haiku-4-5-20251001", "thinkingOptionId": "low" },
        { "provider": "opencode" }
      ]
    }
  }
}
```

Each entry accepts:

- `provider` (required) — the provider id. Built-in ids are `claude`, `codex`, `copilot`, `opencode`, and `pi`; custom providers use the id you gave them.
- `model` (optional) — a specific model id. Omit it to use that provider's default model.
- `thinkingOptionId` (optional) — a reasoning/thinking level for models that support one. Falls back to the model's default if the value isn't valid for that model.

The Settings screen replaces only the first entry and preserves the rest of a custom list. Restart the daemon after editing the file directly.

## Per-project instructions

You can steer the wording of each kind of metadata per repository with a `pimi.json` file at your repo root. Pimi reads it from the committed version of the base branch, the same way it reads worktree config.

```json
{
  "metadataGeneration": {
    "title": { "instructions": "Keep titles to a few words, no leading verb." },
    "branchName": { "instructions": "Use the format <type>/<scope>-<short-desc>." },
    "commitMessage": { "instructions": "Follow Conventional Commits." },
    "pullRequest": { "instructions": "Include a Testing section in the body." }
  }
}
```

Each key is optional; only the ones you set are affected. Your instructions **replace** the default style for that metadata type — they are not appended to it — so your wording never competes with Pimi's defaults. The functional requirements (what to produce and the output format) always apply and cannot be overridden.

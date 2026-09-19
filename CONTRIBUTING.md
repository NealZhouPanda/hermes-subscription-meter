# CONTRIBUTING.md

Development principles for hermes-subscription-meter. These apply to every
contribution, whether made by Neal or by an AI agent.

## English-first

All shipped, user-visible text is English by default. The Hermes plugin
catalog is English-first (per plugin-catalog review on PR #115750), and the
plugin must read as a first-class English project.

In scope (must be English):

- `plugin.yaml` — `description`
- `dashboard/manifest.json` — `label`, `description`
- Panel UI copy in `plugin.js` — status labels, settings page, aria-labels,
  error messages, every user-visible string
- `README.md`, commit messages, PR titles and descriptions

Out of scope (Chinese is fine):

- Code comments documenting design decisions (existing Chinese comments do
  not need migration; new comments may use either language)
- Local working papers under `docs/dev/`

When adding a user-facing string, write it in English first. If a Chinese
variant is wanted later, add it as an explicit localization rather than
replacing the English default.

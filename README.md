# hermes-subscription-meter

A subscription-quota dashboard plugin for [Hermes Agent](https://hermes-agent.nousresearch.com). This is not a progress bar: quota is measured in time and drawn as a cell matrix, so how much you have used and how much is left is obvious at a glance, and the color shift tells you the current quota status. The board reads in three zones: the **weekly zone** (84 cells, 7 days × 12 a day, with the 5-hour window overlaid on it), a divider, the **monthly zone** for plans that also cap a month (8-hour cells, 3 a day — a 30-day month is 90 cells), a divider, and the **balance zone** for prepaid accounts. When choosing is hard, the plugin automatically ranks **the model it suggests you use first for the problem at hand** at the top.

**Provider visibility is controlled from the UI** — show or hide each provider yourself, no config-file edits.

## Screenshot

![Time × quota matrix: one provider per row](docs/images/matrix.png)

## Install

One installer, both halves: the agent-side backend (`plugin.yaml` + `__init__.py` + `dashboard/`)
and the desktop panel (`desktop/plugin.js`). In the Hermes desktop app, open
**Settings → Plugins → Install from Git** and enter:

```
NealZhouPanda/hermes-subscription-meter
```

Or from the CLI:

```bash
hermes plugins install NealZhouPanda/hermes-subscription-meter
```

The app copies the desktop half into its own plugin folder. If the panel does not appear,
**restart the Hermes desktop app** or press **Rescan** on the Plugins page. Both halves ship
switched off — turn the plugin and its desktop panel on in **Plugins**; the panel then docks as
a bottom pane, with a sidebar page and a ⌘K command.

## Supported providers

The discovery layer collects candidate credentials from the Hermes provider registry, the current profile's logged-in OAuth (auth.json) and configured environment slots, then picks a fetcher by rule:

| Provider | Source |
|---|---|
| Codex (ChatGPT) | Hermes `account_usage`, fallback to chatgpt.com usage endpoint |
| GLM (Zhipu) | open.bigmodel.cn quota endpoint |
| Kimi (Moonshot) | api.kimi.com coding usage endpoint |
| Command Code | api.commandcode.ai `/alpha/billing/credits` (5h + weekly windows) + `/alpha/billing/subscriptions` (monthly quota, reset on the billing period) |
| DeepSeek | api.deepseek.com balance + platform cost |
| xAI (Grok subscription) | Hermes `account_usage` (xai-oauth), fallback to CLI proxy billing |
| MiniMax | CN plan usage endpoint |
| Qwen (DashScope) | Alibaba Cloud balance API |
| Nous | Hermes `account_usage` |

Anything detected but lacking a fetcher is shown as `no_fetcher` rather than silently dropped. Quota windows and prepaid balances are both supported; unrecognized credentials are labeled instead of guessed at.

## How it works

- `desktop/plugin.js` — the desktop panel: the weekly matrix (84 cells) with the 5-hour lock overlay, the monthly zone (8-hour cells, sized to the length of the current month), balance bars, automatic ranking of the model it suggests you use first, and per-provider visibility toggles. A monthly quota is shown by default when detected; the provider-specific switch can hide it.
- `dashboard/plugin_api.py` — a FastAPI router that turns credentials into provider-neutral quota rows. Secrets stay in memory only; they never appear in API responses, logs or error strings.
- `tests/` — 109 frontend tests (node:test) + 132 backend tests (pytest).

## Development

Frontend tests (no dependencies, Node ≥ 18):

```bash
node --test tests/*.test.mjs
```

Backend tests (requires `fastapi`, `pydantic`; run from the repo root):

```bash
python -m pytest tests/
```

The backend test suite runs fully offline: every test gets a temp `HERMES_HOME` and outbound sockets are blocked by fixtures in `tests/conftest.py`.

Deploying the panel into a running Hermes goes through the guard instead of a
plain copy — it checks syntax, runs the frontend suite, keeps the previous build
as `.last-good`, replaces the live file atomically (a half-written file would be
executed by the app's directory watcher), then watches the app log for a few
seconds and rolls back by itself if this plugin starts throwing:

```bash
node tools/deploy.mjs        # deploy + watch; add --no-sentinel to skip the watch
node tools/rollback.mjs      # put the previous build back by hand
```

`docs/dev/` contains the design-review notes from the provider-neutral refactor. `diagnostics/` holds small local debugging scripts used during development.

## Contact

Questions / issues / collaboration: nealzhou.panda@gmail.com

## License

[MIT](LICENSE) © 2026 Neal Zhou

A Chinese README (`README.zh-CN.md`) may be added later.

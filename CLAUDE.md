# PR Review Radar

A live, shared board of every open pull request in one GitHub organization, with a derived "whose turn" state per pull request. Read `docs/spike.md` for why it exists and `docs/design.md` for how it works.

## Hard rules

- GitHub stays the review tool. Radar never approves, comments, or merges. The one write is an author-started re-request of review.
- No per-person metrics, rankings, or "blocked by" lists. The server stores no state history.
- Presence and notifications are off until the user turns them on.
- No secrets in git. Configuration comes from environment variables. See `docs/runbook.md`.

## Layout

- `packages/core` is the domain: snapshot types, `derive`, ordering, Mine, notification rules. It is pure and has no dependencies. Change state rules here, and update the tables in `docs/design.md` in the same commit.
- `packages/server` is the GitHub App client, webhook receiver, reconcile sweep, SSE hub, auth, presence, and the demo source.
- `packages/web` is the React board.
- `deploy` holds the Dockerfile, the Helm chart in `deploy/helm/pr-review-radar`, and the GitHub App manifest. The chart is the only description of the Kubernetes resources. `.github/workflows/ci.yml` publishes the image and the chart to GHCR. To release, run the `release` workflow, which tags `main` and starts that pipeline on the tag.

## Commands

```
npm install
npm test            # unit tests for every package
npm run typecheck
npm run check:schema  # validate every GraphQL query against GitHub's public schema
npm run dev:demo    # server and web against the simulated source, no GitHub needed
npm run build
npm run verify:demo # build, then drive the real server and client in a browser
npm run verify:chart # lint and render the Helm chart; needs helm and kubeconform
```

Run `npm run verify:demo` before you call a change to the board, the pipeline, or the client done. Unit tests do not show that a change reaches every viewer.

## pstack

This repository enables the pstack plugin in `.claude/settings.json`. Claude Code installs it from the `cursor/plugins` marketplace when you trust the folder. In a cloud session the environment's setup script installs it:

```
claude plugin marketplace add cursor/plugins
claude plugin install pstack@cursor-plugins
```

Use `/pstack:poteto-mode` for work that needs rigor. In Claude Code the `Skill` tool refuses most pstack skills, so read `skills/<name>/SKILL.md` under the plugin's install path and follow it. `docs/harness/claude-code.md` in the plugin maps the Cursor names to Claude Code.

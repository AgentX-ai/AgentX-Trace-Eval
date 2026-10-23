# Materials

## AgentX governance tour

[`agentx-governance-tour.html`](agentx-governance-tour.html) walks through every screen of the
self-hosted governance layer, grouped into its three pillars:

- **Traceability** - integrations (Python and TypeScript SDKs, twelve framework integrations,
  OpenTelemetry), Live Traces, Sessions, trace detail and execution timeline, and the audit trail
  and bulk export
- **Observability** - Overview, Monitor, Topics, dataset coverage with its coverage map and probe,
  the Review queue, Scorers and Rules
- **Evaluations** - Datasets, evaluation runs, AI Analysis, Playground, conversation simulation,
  Model Portability, the prompt and tool registries and improvement proposals

It closes with **Getting started**: installing the engine, sending it traffic, gating merges with CI
Gates, and scaling storage and access.

Each screen reproduces the dashboard UI. All figures are demo data from a fictional project.

### Viewing it

The tour is published at **https://agentx-ai.github.io/AgentX-Trace-Eval/** by the
[Pages workflow](../.github/workflows/pages.yml), which redeploys whenever `materials/` changes on
`main`.

GitHub shows `.html` files as source rather than rendering them, so the link above is the way to
view it in a browser. To keep a copy, open [the raw file](agentx-governance-tour.html?raw=1) and
save it; it is a single self-contained file whose only external request is the Inter Tight font
from Google Fonts.

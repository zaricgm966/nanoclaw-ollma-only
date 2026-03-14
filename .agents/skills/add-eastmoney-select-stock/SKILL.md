---
name: add-eastmoney-select-stock
description: Add the Eastmoney smart stock screening tool to NanoClaw so agents can use fresh Eastmoney data for stock screening, industry/sector constituent lookup, and stock or board recommendation workflows.
---

# Add Eastmoney Select Stock

Adds an Eastmoney-backed stock screening CLI to all container agents. The tool calls the Eastmoney Skills API with natural-language queries, paginates through the full result set, and exports:

- a CSV file with Chinese column headers
- a Markdown description file with column definitions and screening conditions

Supported markets:
- `A股`
- `港股`
- `美股`

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `add-eastmoney-select-stock` is already in `applied_skills`, skip to Phase 3.

### Check API key

The runtime tool reads `EASTMONEY_APIKEY` from the environment. If it is missing, add it to `.env` before using the tool.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` does not exist:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .agents/skills/add-eastmoney-select-stock
```

This deterministically:
- adds `container/skills/eastmoney-select-stock/SKILL.md`
- adds `container/skills/eastmoney-select-stock/eastmoney-select-stock`
- three-way merges the CLI install step into `container/Dockerfile`
- adds `EASTMONEY_APIKEY` to `.env.example`
- records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read:
- `modify/container/Dockerfile.intent.md`

### Rebuild the container

```bash
./container/build.sh
```

## Phase 3: Verify

### Quick verification

After rebuild, ask the agent to use:

```bash
eastmoney-select-stock "今日涨幅2%的股票"
```

Or run a more specific request:

```bash
eastmoney-select-stock "净利润增长率大于20%的半导体股票" --market A股
```

Expected behavior:
- the tool calls the Eastmoney API with a POST request
- it fetches all result pages
- it writes a CSV and a description Markdown file into `eastmoney-output/`

### Empty results

If the API returns no rows, the tool should tell the user:

> 未筛到结果，请到东方财富妙想AI进行选股。

## Troubleshooting

### Missing API key

If the tool says `EASTMONEY_APIKEY is not set`, add the key to `.env` and rebuild or restart the service if needed.

### Command not found

If the agent cannot run `eastmoney-select-stock`, rebuild the container with `./container/build.sh`.

### API request failed

Check:
- whether `EASTMONEY_APIKEY` is valid
- whether the host network can reach `https://mkapi2.dfcfs.com`
- whether the query text is too vague or unsupported

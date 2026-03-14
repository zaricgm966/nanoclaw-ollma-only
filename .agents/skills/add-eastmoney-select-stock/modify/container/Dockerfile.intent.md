# Intent: container/Dockerfile modifications

## What changed

Added the Eastmoney stock screening CLI to the agent container image.

## Key sections

### After agent-runner build

- Added: `COPY skills/eastmoney-select-stock/eastmoney-select-stock /usr/local/bin/eastmoney-select-stock`
- Added: `RUN chmod +x /usr/local/bin/eastmoney-select-stock`

## Invariants (must-keep)

- Base image remains `node:22-slim`
- Existing Chromium and runtime dependencies remain unchanged
- `agent-browser` global install remains unchanged
- `WORKDIR`, `COPY agent-runner`, `npm install`, and `npm run build` order remains unchanged
- Workspace directory creation remains unchanged
- Entrypoint script remains unchanged
- `USER node`, working directory, and `ENTRYPOINT` remain unchanged

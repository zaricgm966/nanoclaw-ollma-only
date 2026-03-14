---
name: eastmoney-select-stock
description: Query Eastmoney's smart stock screener with natural language for A-share, Hong Kong, and US stock screening, industry or sector constituent lookup, board index constituent lookup, and stock or board recommendations. Use when fresh market data matters.
allowed-tools: Bash(eastmoney-select-stock:*)
---

# Eastmoney Select Stock

Use `eastmoney-select-stock` when you need fresh Eastmoney screening results instead of stale model memory.

The command:
- sends a `POST` request to the Eastmoney screening API
- paginates through the full result set
- replaces English field names with Chinese headers in the CSV
- writes a companion Markdown description file with column metadata and parsed screening conditions

## Quick start

```bash
eastmoney-select-stock "今日涨幅2%的股票"
eastmoney-select-stock "净利润增长率大于20%的半导体股票" --market A股
eastmoney-select-stock "港股里PE低于15倍且股息率高的公司" --market 港股
eastmoney-select-stock "推荐美股AI板块股票" --market 美股
```

## Output

By default the command writes files into `eastmoney-output/`:

- `*.csv`: full result set with Chinese headers
- `*.description.md`: screening summary, conditions, totals, and column mapping

## Common options

```bash
eastmoney-select-stock "<查询语句>" --market A股
eastmoney-select-stock "<查询语句>" --page-size 100
eastmoney-select-stock "<查询语句>" --output-dir reports
eastmoney-select-stock "<查询语句>" --prefix momentum-scan
```

## Notes

- `EASTMONEY_APIKEY` must be present in the environment.
- If `--market` is provided and the query text does not already mention that market, the tool prepends it to the natural-language query.
- If the API returns no rows, tell the user: `未筛到结果，请到东方财富妙想AI进行选股。`

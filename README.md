# 赛鸽疫苗登记与隔离转让台

在原有环号档案站基础上补齐疫苗登记、21 天隔离判定与隔离内禁转。

## 运行

```bash
npm start
```

访问 `http://localhost:3024`。

## 分层结构

- `server.js` —— 入口层：HTTP 路由、请求体解析、并发提交去重、页面渲染。不含业务判定。
- `rules.js` —— 判定层：疫苗登记/更正、隔离期（最新一针起 21 天）、转让冲突、履历合成。
- `store.js` —— 记录存储层：`data/pigeons.json` 的读取、旧档迁移，以及写操作串行化。

## 业务规则

1. 同一羽、同一天、同一种疫苗只能登记一次；缺接种日、疫苗名或登记人时**整条拒绝**（不留任何记录）。
2. 最近一次接种后 21 天内（含截止日当天）不得转让；冲突返回 `409 transfer_quarantine_conflict`，**鸽主不变**，请求写入 `transferRequests` 留档。
3. 更正疫苗记录（`PUT .../vaccines/:id`）后，未结束的隔离期按新日期实时重算；旧成功转让保留在 `transfers`，更正前后写入 `amendments`。
4. 重复或并发提交沿用首次结果：疫苗返回 `duplicated:true` 且不新增；相同冲突转让返回首次冲突档。所有写入经存储层串行队列落盘。
5. 列表、单鸽履历（`.../history`）和页面刷新后的隔离状态由同一判定函数计算，保持一致。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/pigeons?asOf=YYYY-MM-DD` | 列表，含每羽实时 `quarantine` |
| POST | `/api/pigeons` | 创建档案 |
| GET | `/api/pigeons/:ring/history?asOf=` | 单鸽履历时间线（疫苗/更正/转让/冲突留档/成绩） |
| GET | `/api/pigeons/:ring/relation` | 血统关系 |
| POST | `/api/pigeons/:ring/vaccines` | 疫苗登记（`date` 可省，默认当日；`name`、`registeredBy` 必填） |
| PUT | `/api/pigeons/:ring/vaccines/:id` | 更正疫苗（date/name/registeredBy） |
| POST | `/api/pigeons/:ring/transfers` | 转让请求（隔离内 409 且留档） |
| POST | `/api/pigeons/:ring/races` | 归巢成绩 |

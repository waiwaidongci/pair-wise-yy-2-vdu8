# 赛鸽疫苗登记与隔离转让台

在环号档案站基础上补齐疫苗登记与隔离期转让管制。入口、判定、记录存储三层分开：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 入口 | `server.js`、`src/page.js` | HTTP 路由与页面，只接收/展示，不写规则 |
| 判定 | `src/rules.js` | 纯函数：日期、疫苗查重、21 天隔离、转让冲突 |
| 存储 | `src/store.js`、`src/services.js` | JSON 档案原子落盘、写操作互斥、业务编排 |

## 运行

```bash
npm start          # http://localhost:3024
npm test           # node:test，19 项判定/服务/并发用例
```

数据文件可用 `PIGEON_DB` 覆盖，端口用 `PORT`。旧档案首次加载时仅补 `id`、`registeredBy` 字段，不删旧记录。

## 规则

- **疫苗登记** `POST /api/pigeons/:ring/vaccines`
  - 每羽同一天、同种疫苗（忽略大小写与首尾空格）只能登记一次；重复或并发提交沿用首次结果（响应 `deduplicated:true`，返回首条记录）。
  - 缺接种日、疫苗名或登记人任一字段，整条拒绝（400），不落任何记录。
- **隔离与转让** `POST /api/pigeons/:ring/transfers`
  - 接种当天起隔离 21 天，第 21 天当天（`接种日+21`）解除；多次接种取最晚结束日。
  - 隔离期内转让请求返回 `409 isolation_active` 并给出 `transferableFrom`，鸽主不变、不留档。
  - 同日同归属人的重复/并发转让沿用首次记录，鸽主只按首次结果变更一次。
- **更正与重算** `PATCH /api/pigeons/:ring/vaccines/:id`
  - 更正接种日或疫苗名（登记人缺省沿用），尚未结束的隔离期立即按新日期重算；改到更近会重新锁转让。
  - 旧值保存在记录的 `correctedFrom`，已发生的转让一律留档、不回滚。
- **一致性**
  - 所有写操作经同一队列串行执行，临时文件 + rename 原子落盘。
  - 列表 `GET /api/pigeons` 与单鸽履历 `GET /api/pigeons/:ring/history`（另有血统 `/relation`）用同一判定函数，刷新或重启后状态一致。

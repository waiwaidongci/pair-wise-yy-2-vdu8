// 存储层：只管 JSON 档案的加载、迁移与原子落盘。
// 所有写操作经同一把互斥锁串行化，避免并发提交交叉覆盖；刷新与写后读取看到同一份数据。

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const defaultDbPath = process.env.PIGEON_DB || join(__dirname, "..", "data", "pigeons.json");

export const seed = {
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ id: "seed-v1", date: "2026-04-01", name: "新城疫", registeredBy: "" }], transfers: [{ id: "seed-t1", date: "2026-04-15", from: "育种棚", to: "北岸棚", registeredBy: "" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
  ]
};

// 旧档案补 id / registeredBy 字段，只加不删，旧转让始终留档。
function migrate(db) {
  let changed = false;
  for (const pigeon of db.pigeons || []) {
    for (const key of ["vaccines", "transfers"]) {
      pigeon[key] = pigeon[key] || [];
      for (const record of pigeon[key]) {
        if (!record.id) { record.id = randomUUID(); changed = true; }
        if (!("registeredBy" in record)) { record.registeredBy = ""; changed = true; }
      }
    }
    pigeon.races = pigeon.races || [];
  }
  return changed;
}

export function createStore(dbPath = defaultDbPath) {
  let bootstrap = null;

  async function load() {
    if (!existsSync(dbPath)) {
      await mkdir(dirname(dbPath), { recursive: true });
      const db = JSON.parse(JSON.stringify(seed));
      migrate(db);
      await writeFile(dbPath, JSON.stringify(db, null, 2));
      return db;
    }
    const db = JSON.parse(await readFile(dbPath, "utf8"));
    if (migrate(db)) await writeFile(dbPath, JSON.stringify(db, null, 2));
    return db;
  }

  // 首次加载期间的并发请求共用同一个 Promise，保证拿到同一份档案。
  function getDb() {
    if (!bootstrap) bootstrap = load();
    return bootstrap;
  }

  async function persist(db) {
    const tmp = `${dbPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, dbPath);
  }

  // 读操作：直接取最新落盘数据对应的内存档案。
  async function read(handler) {
    const db = await getDb();
    return handler(db);
  }

  // 写操作：排队执行，handler 返回的结果即接口结果；只有不抛错时才落盘。
  const queue = { tail: Promise.resolve() };
  function mutate(handler) {
    const run = queue.tail.then(async () => {
      const db = await getDb();
      const result = await handler(db);
      await persist(db);
      return result;
    });
    // 单个任务失败不影响后续任务入队。
    queue.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  return { read, mutate, getDb };
}

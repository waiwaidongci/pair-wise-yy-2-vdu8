// 记录存储层：只负责档案的持久化、旧档迁移和写操作串行化。
// 不包含任何业务判定（缺字段、隔离期、重复登记等规则一律放在 rules.js）。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const dbPath = join(__dirname, "data", "pigeons.json");

export const seed = {
  pigeons: [
    {
      ringNo: "CHN-2026-001",
      owner: "北岸棚",
      fatherRing: "CHN-2022-188",
      motherRing: "CHN-2023-512",
      color: "灰",
      loft: "北岸A棚",
      vaccines: [{ id: "V-SEED-001", date: "2026-04-01", name: "新城疫", registeredBy: "档案室" }],
      transfers: [{ id: "T-SEED-001", date: "2026-04-15", from: "育种棚", to: "北岸棚" }],
      transferRequests: [],
      amendments: [],
      races: [{ id: "C-SEED-001", date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }]
    },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], transferRequests: [], amendments: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], transferRequests: [], amendments: [], races: [] }
  ]
};

let dbPromise = null;
// 所有写操作共用一条链：load -> 内存判定/修改 -> 落盘，保证并发提交不会互相覆盖。
let writeChain = Promise.resolve();

async function load() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return structuredClone(seed);
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (migrate(db)) await writeFile(dbPath, JSON.stringify(db, null, 2));
  return db;
}

// 旧档补字段：疫苗/转让/成绩补 id，疫苗补登记人，新增转让冲突留档与更正留档数组。
function migrate(db) {
  let changed = false;
  for (const p of db.pigeons ?? []) {
    for (const key of ["vaccines", "transfers", "races"]) {
      if (!Array.isArray(p[key])) { p[key] = []; changed = true; }
    }
    for (const key of ["transferRequests", "amendments"]) {
      if (!Array.isArray(p[key])) { p[key] = []; changed = true; }
    }
    p.vaccines.forEach((v, i) => {
      if (!v.id) { v.id = `legacy-V-${i}-${v.date}-${v.name}`; changed = true; }
      if (!("registeredBy" in v)) { v.registeredBy = ""; changed = true; }
    });
    p.transfers.forEach((t, i) => {
      if (!t.id) { t.id = `legacy-T-${i}-${t.date}`; changed = true; }
    });
    p.races.forEach((r, i) => {
      if (!r.id) { r.id = `legacy-C-${i}-${r.date}`; changed = true; }
    });
  }
  return changed;
}

export function getDb() {
  if (!dbPromise) dbPromise = load();
  return dbPromise;
}

// 串行执行一次“读-改-写”。mutator 只在内存 db 上按 rules.js 的判定结果改动，
// 正常 resolve（含 409 冲突留档）后统一落盘；判定前抛错则不写。
export function update(mutator) {
  const result = writeChain.then(async () => {
    const db = await getDb();
    const out = await mutator(db);
    await writeFile(dbPath, JSON.stringify(db, null, 2));
    return out;
  });
  writeChain = result.then(() => {}, () => {});
  return result;
}

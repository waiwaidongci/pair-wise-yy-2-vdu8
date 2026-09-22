import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, seed } from "../src/store.js";
import { createServices, HttpError } from "../src/services.js";

async function makeServices(now = "2026-09-20T08:00:00Z") {
  const dir = await mkdtemp(join(tmpdir(), "pigeon-test-"));
  const dbPath = join(dir, "pigeons.json");
  const store = createStore(dbPath);
  const services = createServices(store, () => new Date(now));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  return { services, cleanup, dbPath };
}

const RING = "CHN-2022-188";

async function expectError(fn, status, code) {
  try {
    await (typeof fn === "function" ? fn() : fn);
    assert.fail("应当抛错");
  } catch (err) {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
  }
}

test("缺接种日/疫苗名/登记人：整条拒绝，不产生记录", async () => {
  const { services, cleanup } = await makeServices();
  await expectError(() => services.registerVaccine(RING, { date: "", name: "新城疫", registeredBy: "张三" }), 400, "vaccine_date_required");
  await expectError(() => services.registerVaccine(RING, { date: "2026-09-10", name: "", registeredBy: "张三" }), 400, "vaccine_name_required");
  await expectError(() => services.registerVaccine(RING, { date: "2026-09-10", name: "新城疫", registeredBy: "  " }), 400, "vaccine_registeredBy_required");
  const history = await services.getHistory(RING);
  assert.equal(history.vaccines.length, 0);
  await cleanup();
});

test("同一天同种疫苗重复登记沿用首次结果", async () => {
  const { services, cleanup } = await makeServices();
  const first = await services.registerVaccine(RING, { date: "2026-09-10", name: "新城疫", registeredBy: "张三" });
  assert.equal(first.body.deduplicated, false);
  assert.equal(first.body.vaccine.registeredBy, "张三");
  const again = await services.registerVaccine(RING, { date: "2026-09-10", name: " 新城疫 ", registeredBy: "李四" });
  assert.equal(again.body.deduplicated, true);
  assert.equal(again.body.vaccine.id, first.body.vaccine.id);
  assert.equal(again.body.vaccine.registeredBy, "张三", "沿用首次登记人");
  const history = await services.getHistory(RING);
  assert.equal(history.vaccines.length, 1);
  await cleanup();
});

test("接种后 21 天内转让冲突，鸽主不变且不落档", async () => {
  const { services, cleanup, dbPath } = await makeServices();
  await services.registerVaccine(RING, { date: "2026-09-10", name: "新城疫", registeredBy: "张三" });
  await expectError(() => services.requestTransfer(RING, { date: "2026-09-20", to: "南岸棚" }), 409, "isolation_active");

  const history = await services.getHistory(RING);
  assert.equal(history.owner, "育种棚", "冲突不改变鸽主");
  assert.equal(history.transfers.length, 0, "冲突请求不留档");
  assert.equal(history.isolation.isolated, true);
  assert.equal(history.isolation.transferableFrom, "2026-10-01");
  await cleanup();
});

test("满 21 天当天可转让，鸽主更新并留档", async () => {
  const { services, cleanup } = await makeServices();
  await services.registerVaccine(RING, { date: "2026-09-10", name: "新城疫", registeredBy: "张三" });
  const result = await services.requestTransfer(RING, { date: "2026-10-01", to: "南岸棚" });
  assert.equal(result.body.deduplicated, false);
  assert.equal(result.body.transfer.from, "育种棚");
  assert.equal(result.body.transfer.to, "南岸棚");
  const history = await services.getHistory(RING);
  assert.equal(history.owner, "南岸棚");
  assert.equal(history.transfers.length, 1);
  await cleanup();
});

test("同日同人重复转让沿用首次记录，不再次变更", async () => {
  const { services, cleanup } = await makeServices();
  await services.requestTransfer(RING, { date: "2026-09-05", to: "南岸棚" });
  const dup = await services.requestTransfer(RING, { date: "2026-09-05", to: "南岸棚" });
  assert.equal(dup.body.deduplicated, true);
  const history = await services.getHistory(RING);
  assert.equal(history.transfers.length, 1);
  assert.equal(history.owner, "南岸棚");
  await cleanup();
});

test("更正疫苗日期后未结束隔离按新日期重算，旧转让留档", async () => {
  const { services, cleanup } = await makeServices();
  const reg = await services.registerVaccine(RING, { date: "2026-09-10", name: "新城疫", registeredBy: "张三" });
  // 隔离期内此前转让一律冲突；先制造一条更早的合法转让留档。
  await services.requestTransfer(RING, { date: "2026-09-05", to: "老棚" });
  await expectError(() => services.requestTransfer(RING, { date: "2026-09-15", to: "新棚" }), 409, "isolation_active");

  // 把接种日改到更早，隔离期在 09-20 已结束。
  await services.correctVaccine(RING, reg.body.vaccine.id, { date: "2026-08-20", name: "新城疫+传支" });

  const history = await services.getHistory(RING);
  assert.equal(history.isolation.isolated, false);
  assert.equal(history.vaccines[0].date, "2026-08-20");
  assert.deepEqual(history.vaccines[0].correctedFrom, { date: "2026-09-10", name: "新城疫" });
  assert.equal(history.transfers.length, 1, "旧转让仍在档");
  assert.equal(history.transfers[0].to, "老棚");

  // 重算后此前冲突的日期现在可以转让。
  const result = await services.requestTransfer(RING, { date: "2026-09-15", to: "新棚" });
  assert.equal(result.body.transfer.to, "新棚");
  await cleanup();
});

test("把接种日改到更近则隔离延长，转让再次冲突", async () => {
  const { services, cleanup } = await makeServices();
  const reg = await services.registerVaccine(RING, { date: "2026-08-20", name: "新城疫", registeredBy: "张三" });
  assert.equal((await services.getHistory(RING)).isolation.isolated, false);
  await services.correctVaccine(RING, reg.body.vaccine.id, { date: "2026-09-15", name: "新城疫" });
  const history = await services.getHistory(RING);
  assert.equal(history.isolation.isolated, true);
  assert.equal(history.isolation.transferableFrom, "2026-10-06");
  await expectError(() => services.requestTransfer(RING, { date: "2026-09-20", to: "新棚" }), 409, "isolation_active");
  await cleanup();
});

test("并发重复登记：只有一次落库，另一次沿用首次结果", async () => {
  const { services, cleanup } = await makeServices();
  const payload = { date: "2026-09-10", name: "腺病毒", registeredBy: "张三" };
  const [a, b] = await Promise.all([
    services.registerVaccine(RING, payload),
    services.registerVaccine(RING, { ...payload, registeredBy: "李四" })
  ]);
  const flags = [a.body.deduplicated, b.body.deduplicated].sort();
  assert.deepEqual(flags, [false, true]);
  assert.equal(a.body.vaccine.id, b.body.vaccine.id);
  const winner = a.body.deduplicated ? b : a;
  assert.equal(winner.body.vaccine.registeredBy, "张三");
  const history = await services.getHistory(RING);
  assert.equal(history.vaccines.length, 1);
  await cleanup();
});

test("并发转让：隔离期内全部冲突；解除后首个请求生效，其余沿用", async () => {
  const { services, cleanup } = await makeServices();
  await services.registerVaccine(RING, { date: "2026-09-10", name: "新城疫", registeredBy: "张三" });
  const results = await Promise.allSettled([
    services.requestTransfer(RING, { date: "2026-09-20", to: "新棚A" }),
    services.requestTransfer(RING, { date: "2026-09-20", to: "新棚B" })
  ]);
  assert.ok(results.every(r => r.status === "rejected" && r.reason.code === "isolation_active"));

  const ok = await Promise.all([
    services.requestTransfer(RING, { date: "2026-10-01", to: "新棚A" }),
    services.requestTransfer(RING, { date: "2026-10-01", to: "新棚A" })
  ]);
  const flags = ok.map(r => r.body.deduplicated).sort();
  assert.deepEqual(flags, [false, true]);
  const history = await services.getHistory(RING);
  assert.equal(history.transfers.length, 1);
  assert.equal(history.owner, "新棚A");
  await cleanup();
});

test("列表、单鸽履历与重新加载（刷新）后状态一致", async () => {
  const { services, cleanup, dbPath } = await makeServices();
  await services.registerVaccine(RING, { date: "2026-09-10", name: "新城疫", registeredBy: "张三" });
  const list1 = await services.listPigeons();
  const inList = list1.find(p => p.ringNo === RING);
  const history1 = await services.getHistory(RING);
  assert.equal(inList.isolation.transferableFrom, history1.isolation.transferableFrom);
  assert.equal(inList.owner, history1.owner);

  // 用全新 store 重新打开同一数据文件，模拟页面刷新 / 服务重启。
  const reopened = createServices(createStore(dbPath), () => new Date("2026-09-20T08:00:00Z"));
  const list2 = await reopened.listPigeons();
  const history2 = await reopened.getHistory(RING);
  assert.equal(list2.find(p => p.ringNo === RING).isolation.transferableFrom, "2026-10-01");
  assert.equal(history2.vaccines.length, 1);
  assert.equal(history2.vaccines[0].registeredBy, "张三");
  assert.equal(history2.isolation.transferableFrom, history1.isolation.transferableFrom);
  await cleanup();
});

test("种子档案可加载且结构完整", () => {
  assert.ok(Array.isArray(seed.pigeons));
  assert.equal(seed.pigeons[0].vaccines[0].name, "新城疫");
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  ISOLATION_DAYS,
  addDays,
  checkTransfer,
  dateSpan,
  findVaccine,
  isolationStatus,
  normalizeDate,
  validateVaccineInput,
  vaccineIsolation
} from "../src/rules.js";

function pigeonWith(vaccines = []) {
  return { ringNo: "X", owner: "甲", vaccines: vaccines.map((v, i) => ({ id: "v" + i, ...v })), transfers: [] };
}

test("normalizeDate 拒绝空值、非法和不存在的日期", () => {
  assert.equal(normalizeDate(""), null);
  assert.equal(normalizeDate("2026/04/01"), null);
  assert.equal(normalizeDate("2026-02-31"), null);
  assert.equal(normalizeDate(undefined), null);
  assert.equal(normalizeDate("2026-04-01"), "2026-04-01");
});

test("疫苗输入缺接种日、疫苗名或登记人时整条拒绝", () => {
  assert.deepEqual(validateVaccineInput({ date: "2026-09-01", name: "新城疫", registeredBy: "张三" }).ok, true);
  assert.equal(validateVaccineInput({ date: "", name: "新城疫", registeredBy: "张三" }).field, "date");
  assert.equal(validateVaccineInput({ date: "2026-09-01", name: "  ", registeredBy: "张三" }).field, "name");
  assert.equal(validateVaccineInput({ date: "2026-09-01", name: "新城疫", registeredBy: "" }).field, "registeredBy");
  assert.equal(validateVaccineInput({ date: "not-a-date", name: "新城疫", registeredBy: "张三" }).field, "date");
});

test("同一天同种疫苗（忽略大小写和首尾空格）才算重复", () => {
  const p = pigeonWith([{ date: "2026-09-01", name: "新城疫" }]);
  assert.ok(findVaccine(p, { date: "2026-09-01", name: " 新城疫 " }));
  assert.ok(findVaccine(p, { date: "2026-09-01", name: "新城疫" }));
  assert.ok(!findVaccine(p, { date: "2026-09-02", name: "新城疫" }));
  assert.ok(!findVaccine(p, { date: "2026-09-01", name: "腺病毒" }));
});

test("接种后 21 天内隔离中，满 21 天当天解除", () => {
  const v = { id: "v1", date: "2026-09-01", name: "新城疫" };
  assert.equal(vaccineIsolation(v, "2026-09-01").active, true);
  assert.equal(vaccineIsolation(v, "2026-09-21").active, true);
  assert.equal(vaccineIsolation(v, addDays("2026-09-01", ISOLATION_DAYS)).active, false);
  assert.equal(vaccineIsolation(v, "2026-09-22").active, false);
  assert.equal(dateSpan("2026-09-01", "2026-09-22"), 21);

  const p = pigeonWith([{ date: "2026-09-01", name: "新城疫" }]);
  const locked = isolationStatus(p, "2026-09-10");
  assert.equal(locked.isolated, true);
  assert.equal(locked.transferableFrom, "2026-09-22");
  assert.equal(locked.remaining, 12);

  const open = isolationStatus(p, "2026-09-22");
  assert.equal(open.isolated, false);
});

test("多次接种取最晚结束的隔离期", () => {
  const p = pigeonWith([
    { date: "2026-09-01", name: "新城疫" },
    { date: "2026-09-15", name: "腺病毒" }
  ]);
  const status = isolationStatus(p, "2026-09-20");
  assert.equal(status.isolated, true);
  assert.equal(status.transferableFrom, "2026-10-06");
  assert.equal(status.blocks.length, 2);
});

test("未来接种日不提前产生隔离", () => {
  const p = pigeonWith([{ date: "2026-12-01", name: "新城疫" }]);
  assert.equal(isolationStatus(p, "2026-09-20").isolated, false);
});

test("隔离中转让冲突且给出最早可转让日；无隔离可转让", () => {
  const p = pigeonWith([{ date: "2026-09-10", name: "新城疫" }]);
  const blocked = checkTransfer(p, { date: "2026-09-20", to: "乙棚" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.code, "isolation_active");
  assert.equal(blocked.isolation.transferableFrom, "2026-10-01");

  const allowed = checkTransfer(p, { date: "2026-10-01", to: "乙棚" });
  assert.deepEqual(allowed, { ok: true, date: "2026-10-01", to: "乙棚" });

  assert.equal(checkTransfer(p, { date: "2026-10-01", to: "  " }).status, 400);
});

test("更正日期后旧隔离提前结束：判定层按新日期重算", () => {
  const v = { id: "v1", date: "2026-09-10", name: "新城疫" };
  assert.equal(vaccineIsolation(v, "2026-09-20").active, true);
  const corrected = { ...v, date: "2026-08-01" };
  assert.equal(vaccineIsolation(corrected, "2026-09-20").active, false);
});

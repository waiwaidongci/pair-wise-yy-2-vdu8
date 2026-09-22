// 服务层：业务编排。判定全部委托 rules.js，读写全部委托 store.js，
// 自己不实现日期/隔离规则，也不直接碰文件。

import { randomUUID } from "node:crypto";
import {
  ISOLATION_DAYS,
  checkTransfer,
  dateSpan,
  findVaccine,
  todayStamp,
  validateVaccineInput,
  vaccineIsolation,
  isolationStatus
} from "./rules.js";

export class HttpError extends Error {
  constructor(status, code, details = undefined) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createServices(store, clock = () => new Date()) {
  const today = () => todayStamp(clock());

  function getPigeon(db, ringNo) {
    const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
    if (!pigeon) throw new HttpError(404, "pigeon_not_found");
    return pigeon;
  }

  // 列表：每羽附带同一套规则算出的隔离状态，保证列表与单鸽履历一致。
  function listPigeons() {
    return store.read(db => {
      const onDate = today();
      return db.pigeons.map(pigeon => ({ ...pigeon, isolation: isolationStatus(pigeon, onDate) }));
    });
  }

  // 单鸽履历：疫苗、转让（含被拒绝的冲突不落档，旧转让全留档）、成绩与当前隔离状态。
  function getHistory(ringNo) {
    return store.read(db => {
      const pigeon = getPigeon(db, ringNo);
      const onDate = today();
      const vaccines = pigeon.vaccines.map(v => ({ ...v, isolation: vaccineIsolation(v, onDate) }));
      return {
        ringNo,
        owner: pigeon.owner,
        isolation: isolationStatus(pigeon, onDate),
        vaccines,
        transfers: pigeon.transfers,
        races: pigeon.races
      };
    });
  }

  function getRelation(ringNo) {
    return store.read(db => {
      const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
      if (!pigeon) return null;
      const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
      const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
      const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
      return { pigeon, father, mother, children, isolation: isolationStatus(pigeon, today()) };
    });
  }

  function createPigeon(input) {
    return store.mutate(db => {
      const ringNo = String(input.ringNo || "").trim();
      if (!ringNo) throw new HttpError(400, "ring_no_required");
      if (db.pigeons.some(item => item.ringNo === ringNo)) throw new HttpError(409, "ring_exists");
      const pigeon = {
        ringNo,
        owner: String(input.owner || "").trim(),
        fatherRing: String(input.fatherRing || "").trim(),
        motherRing: String(input.motherRing || "").trim(),
        color: String(input.color || "").trim(),
        loft: String(input.loft || "").trim(),
        vaccines: [],
        transfers: [],
        races: []
      };
      db.pigeons.unshift(pigeon);
      return { status: 201, body: pigeon };
    });
  }

  // 疫苗登记：缺接种日/疫苗名/登记人整条拒绝；同一天同种疫苗沿用首次结果。
  function registerVaccine(ringNo, input) {
    const checked = validateVaccineInput(input, { requireRegisteredBy: true });
    if (!checked.ok) throw new HttpError(400, `vaccine_${checked.field}_required`);
    return store.mutate(db => {
      const pigeon = getPigeon(db, ringNo);
      const existing = findVaccine(pigeon, checked.value);
      if (existing) return { status: 200, body: { pigeon, vaccine: existing, deduplicated: true } };
      const vaccine = { id: randomUUID(), ...checked.value };
      pigeon.vaccines.push(vaccine);
      return { status: 200, body: { pigeon, vaccine, deduplicated: false } };
    });
  }

  // 更正疫苗记录：改日期/名称；登记人缺省沿用。尚未结束的隔离期由判定层按新日期重算。
  function correctVaccine(ringNo, vaccineId, input) {
    const checked = validateVaccineInput(input, { requireRegisteredBy: false });
    if (!checked.ok) throw new HttpError(400, `vaccine_${checked.field}_required`);
    return store.mutate(db => {
      const pigeon = getPigeon(db, ringNo);
      const index = pigeon.vaccines.findIndex(v => v.id === vaccineId);
      if (index === -1) throw new HttpError(404, "vaccine_not_found");
      const current = pigeon.vaccines[index];
      const candidate = {
        date: checked.value.date,
        name: checked.value.name,
        registeredBy: typeof input.registeredBy === "string" && input.registeredBy.trim()
          ? input.registeredBy.trim()
          : current.registeredBy
      };
      const clash = pigeon.vaccines.some((v, i) => i !== index && v.date === candidate.date && v.name.trim().toLowerCase() === candidate.name.toLowerCase());
      if (clash) throw new HttpError(409, "vaccine_conflict");
      // 旧值留痕，便于追溯“按新日期重算”的来源。
      pigeon.vaccines[index] = { id: current.id, ...candidate, correctedFrom: { date: current.date, name: current.name } };
      return { status: 200, body: { pigeon, vaccine: pigeon.vaccines[index] } };
    });
  }

  // 转让请求：隔离中返回冲突且不改变鸽主；同日同人重复/并发请求沿用首次转让记录。
  function requestTransfer(ringNo, input) {
    const rawDate = input.date ? String(input.date) : today();
    return store.mutate(db => {
      const pigeon = getPigeon(db, ringNo);
      const verdict = checkTransfer(pigeon, { date: rawDate, to: input.to, from: input.from });
      if (!verdict.ok) {
        throw new HttpError(verdict.status, verdict.code, verdict.isolation ? { isolation: verdict.isolation } : undefined);
      }
      const existing = pigeon.transfers.find(t => t.date === verdict.date && t.to === verdict.to);
      if (existing) return { status: 200, body: { pigeon, transfer: existing, deduplicated: true } };
      const transfer = {
        id: randomUUID(),
        date: verdict.date,
        from: pigeon.owner,
        to: verdict.to,
        registeredBy: typeof input.registeredBy === "string" ? input.registeredBy.trim() : ""
      };
      pigeon.owner = verdict.to;
      pigeon.transfers.push(transfer);
      return { status: 200, body: { pigeon, transfer, deduplicated: false } };
    });
  }

  function addRace(ringNo, input) {
    return store.mutate(db => {
      const pigeon = getPigeon(db, ringNo);
      const race = {
        date: typeof input.date === "string" && input.date.trim() ? input.date.trim() : today(),
        event: String(input.event || "未命名赛事"),
        distance: Number(input.distance || 0),
        returnTime: String(input.returnTime || ""),
        rank: Number(input.rank || 0)
      };
      pigeon.races.push(race);
      return { status: 200, body: pigeon };
    });
  }

  return {
    isolationDays: ISOLATION_DAYS,
    listPigeons,
    getHistory,
    getRelation,
    createPigeon,
    registerVaccine,
    correctVaccine,
    requestTransfer,
    addRace,
    // 测试辅助：今天距离某日期的天数。
    _dateSpan: dateSpan
  };
}

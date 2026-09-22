// 入口层：HTTP 路由与页面。不写业务判定、不直接读写数据文件——
// 判定在 src/rules.js，记录存储在 src/store.js，编排在 src/services.js。

import http from "node:http";
import { createStore } from "./src/store.js";
import { createServices, HttpError } from "./src/services.js";
import { page } from "./src/page.js";

const port = Number(process.env.PORT || 3024);
const services = createServices(createStore());

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    if (req.method === "GET" && p === "/api/pigeons") {
      return sendJson(res, 200, await services.listPigeons());
    }
    if (req.method === "POST" && p === "/api/pigeons") {
      const { status, body } = await services.createPigeon(await readBody(req));
      return sendJson(res, status, body);
    }

    const vaccinePatch = p.match(/^\/api\/pigeons\/(.+?)\/vaccines\/([^/]+)$/);
    if (vaccinePatch && req.method === "PATCH") {
      const ringNo = decodeURIComponent(vaccinePatch[1]);
      const { status, body } = await services.correctVaccine(ringNo, decodeURIComponent(vaccinePatch[2]), await readBody(req));
      return sendJson(res, status, body);
    }

    const historyMatch = p.match(/^\/api\/pigeons\/(.+?)\/history$/);
    if (historyMatch && req.method === "GET") {
      return sendJson(res, 200, await services.getHistory(decodeURIComponent(historyMatch[1])));
    }

    const relationMatch = p.match(/^\/api\/pigeons\/(.+?)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const data = await services.getRelation(decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }

    const actionMatch = p.match(/^\/api\/pigeons\/(.+?)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const ringNo = decodeURIComponent(actionMatch[1]);
      const input = await readBody(req);
      let result;
      if (actionMatch[2] === "vaccines") result = await services.registerVaccine(ringNo, input);
      if (actionMatch[2] === "transfers") result = await services.requestTransfer(ringNo, input);
      if (actionMatch[2] === "races") result = await services.addRace(ringNo, input);
      return sendJson(res, result.status, result.body);
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof HttpError) {
      return sendJson(res, error.status, { error: error.code, ...(error.details || {}) });
    }
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Pigeon vaccine & isolation transfer desk listening on http://localhost:${port}`));

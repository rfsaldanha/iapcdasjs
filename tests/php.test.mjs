import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, cp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "../src/index.js";
import { root, php, mockService, startPhp, testToken } from "./helpers.mjs";

test("sintaxe PHP e testes de contrato/configuração", async () => {
  for (const directory of ["server", "public/api", "config", "tests", "scripts"]) {
    for (const entry of await readdir(join(root, directory))) {
      if (!entry.endsWith(".php") || entry === "local.php") continue;
      const result = spawnSync(php, ["-l", join(root, directory, entry)], { encoding: "utf8" });
      assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
    }
  }
  for (const file of ["server.test.php", "controls.test.php"]) {
    const result = spawnSync(php, [join(root, "tests", file)], { encoding: "utf8" });
    assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
  }
});

test("JavaScript → endpoint PHP → cURL → serviço simulado", async t => {
  const mock = await mockService(t);
  const server = await startPhp(t, { upstream: mock.url });
  const client = createClient({ endpoint: server.url + "/api/chatpcdas.php" });
  const input = {
    tables: [
      { name: "teste", rows: [{ codigo: "0001", valor: 0, ausente: null, texto: "Informação suprimida" }] },
      { name: "outra", rows: [{ valor: 1.25, "0": { teste: true } }] },
    ],
    prompt: "  Prompt técnico de teste.\n",
  };
  const expected = "  Resposta com **marcação** e <script>texto</script>.\n";
  mock.state.body = JSON.stringify({ text_description: expected, campoExtra: testToken });
  assert.equal(await client.describe(input), expected);
  assert.equal(mock.requests.length, 1);
  const outgoing = mock.requests[0];
  assert.equal(outgoing.method, "POST");
  assert.match(outgoing.headers["content-type"], /application\/json/);
  assert.equal(outgoing.body.token.token, testToken);
  assert.equal(outgoing.body.data.context, input.prompt);
  assert.equal(typeof outgoing.body.data.data, "string");
  assert.deepEqual(JSON.parse(outgoing.body.data.data), input.tables);
  assert.doesNotMatch(server.logs(), new RegExp(testToken));

  for (const [status, body, code] of [
    [401, testToken, "AUTHENTICATION_ERROR"],
    [403, testToken, "AUTHENTICATION_ERROR"],
    [422, testToken, "UPSTREAM_ERROR"],
    [500, testToken, "UPSTREAM_ERROR"],
    [200, "<html>" + testToken + "</html>", "INVALID_RESPONSE"],
  ]) {
    Object.assign(mock.state, { status, body });
    await assert.rejects(client.describe(input), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, new RegExp(testToken));
      return true;
    });
  }
  assert.equal(mock.requests.length, 6, "Uma única chamada por consulta");

  Object.assign(mock.state, { status: 302, body: "redirecionamento" });
  await assert.rejects(client.describe(input), { code: "UPSTREAM_ERROR" });

  const blocked = await fetch(server.url + "/api/chatpcdas.php", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(input),
  });
  assert.equal(blocked.status, 415);
  assert.equal(mock.requests.length, 7);
});

test("timeout real do cURL devolve erro 504 sem detalhes", async t => {
  const mock = await mockService(t);
  mock.state.delay = 1200;
  const server = await startPhp(t, { upstream: mock.url, timeout: "1" });
  const response = await fetch(server.url + "/api/chatpcdas.php", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tables: [{ name: "teste", rows: [{ valor: 0 }] }], prompt: "Teste" }),
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "TIMEOUT");
});

test("entrada pública real sem configuração retorna erro sem consultar a API", async t => {
  const temporary = await mkdtemp(join(tmpdir(), "iapcdas-public-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(join(temporary, "public/api"), { recursive: true });
  await cp(join(root, "public/api/chatpcdas.php"), join(temporary, "public/api/chatpcdas.php"));
  await cp(join(root, "server"), join(temporary, "server"), { recursive: true });
  const server = await startPhp(t, { directory: temporary, router: false });
  const response = await fetch(server.url + "/api/chatpcdas.php", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tables: [{ name: "teste", rows: [{ valor: 0 }] }], prompt: "Teste" }),
  });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type"), /application\/json; charset=UTF-8/i);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal((await response.json()).error.code, "CONFIGURATION_ERROR");
});

test("cotas HTTP limitam chamadas e não confiam em X-Forwarded-For", async t => {
  const mock = await mockService(t);
  const server = await startPhp(t, { upstream: mock.url, settings: { usage: { per_client: 2 } } });
  const body = JSON.stringify({ tables: [{ name: "teste", rows: [{ valor: 0 }] }], prompt: "Teste privado" });
  for (let count = 0; count < 2; count++) {
    const response = await fetch(server.url + "/api/chatpcdas.php", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-request-id"), /^[a-f0-9]{32}$/);
  }
  const response = await fetch(server.url + "/api/chatpcdas.php", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.1" },
    body,
  });
  const data = await response.json();
  assert.equal(response.status, 429);
  assert.equal(data.error.code, "RATE_LIMITED");
  assert.equal(data.error.request_id, response.headers.get("x-request-id"));
  assert.ok(Number(response.headers.get("retry-after")) > 0);
  assert.equal(mock.requests.length, 2);
  assert.doesNotMatch(server.logs(), /Teste privado/);
  assert.match(server.logs(), /iapcdas.request/);
});

test("autorização negada e corpo excessivo não alcançam o serviço remoto", async t => {
  const mock = await mockService(t);
  const denied = await startPhp(t, { upstream: mock.url, authorize: false });
  const body = JSON.stringify({ tables: [{ name: "teste", rows: [{ valor: 0 }] }], prompt: "Teste" });
  const result = await fetch(denied.url + "/api/chatpcdas.php", {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  assert.equal(result.status, 403);
  const limited = await startPhp(t, { upstream: mock.url, settings: { limits: { request_bytes: 64 } } });
  for (const payload of [body, (async function* () { yield body; })()]) {
    const response = await fetch(limited.url + "/api/chatpcdas.php", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: payload, duplex: "half",
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.field, "body");
  }
  assert.equal(mock.requests.length, 0);
});

test("cURL interrompe resposta maior que o limite e libera a vaga", async t => {
  const mock = await mockService(t);
  mock.state.body = JSON.stringify({ text_description: "x".repeat(4096) });
  const server = await startPhp(t, {
    upstream: mock.url, settings: { limits: { response_bytes: 128 }, usage: { concurrent: 1 } },
  });
  const client = createClient({ endpoint: server.url + "/api/chatpcdas.php" });
  const input = { tables: [{ name: "teste", rows: [{ valor: 0 }] }], prompt: "Teste" };
  await assert.rejects(client.describe(input), { code: "RESPONSE_TOO_LARGE" });
  mock.state.body = '{"text_description":"ok"}';
  assert.equal(await client.describe(input), "ok");
});

test("dois processos PHP compartilham o limite de concorrência", async t => {
  const mock = await mockService(t);
  mock.state.delay = 250;
  const storageDir = await mkdtemp(join(tmpdir(), "iapcdas-shared-"));
  const options = { upstream: mock.url, storageDir, settings: { usage: { concurrent: 1 } } };
  const first = await startPhp(t, options);
  const second = await startPhp(t, options);
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const input = { tables: [{ name: "teste", rows: [{ valor: 0 }] }], prompt: "Teste" };
  const a = createClient({ endpoint: first.url + "/api/chatpcdas.php" });
  const b = createClient({ endpoint: second.url + "/api/chatpcdas.php" });
  const pending = a.describe(input);
  const deadline = Date.now() + 3000;
  while (mock.requests.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(mock.requests.length, 1);
  await assert.rejects(b.describe(input), error => {
    assert.equal(error.code, "SERVER_BUSY");
    assert.equal(error.retryAfter, 1);
    return true;
  });
  assert.equal(await pending, "Resposta técnica de teste.");
  assert.equal(await b.describe(input), "Resposta técnica de teste.");
});

test("verificador real exige execução explícita", () => {
  const result = spawnSync(php, [join(root, "scripts/verify-live.php")], {
    encoding: "utf8", env: { ...process.env, PCDAS_TOKEN: "" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--confirm/);
  assert.equal(result.stdout, "");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, IAPCDASError } from "../src/index.js";

// Fixtures técnicas; não representam indicadores do Proadess.
const tables = [{ name: "teste", rows: [{ codigo: "0001", valor: 0, ausente: null, nome: "Ação" }] }];
const request = () => ({ tables: structuredClone(tables), prompt: "  Prompt de teste.\n" });
const client = options => createClient({ endpoint: "http://localhost/api/chatpcdas.php", ...options });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const hasCode = code => error => error instanceof IAPCDASError && error.code === code;

test("envia uma ou várias tabelas intactas e devolve texto sem formatar", async t => {
  for (const count of [1, 2]) {
    const input = request();
    if (count === 2) input.tables.push({ name: "outra", rows: [{ "0": "coluna numérica", nested: { ok: true } }] });
    const original = structuredClone(input);
    const text = "  **Resposta técnica**\n<script>não executar</script>  ";
    const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(url, "http://localhost/api/chatpcdas.php");
      assert.equal(options.method, "POST");
      assert.equal(options.mode, "same-origin");
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "same-origin");
      assert.match(options.headers["Content-Type"], /application\/json/);
      assert.deepEqual(JSON.parse(options.body), original);
      assert.equal(Object.hasOwn(JSON.parse(options.body), "token"), false);
      return response({ text_description: text });
    });
    assert.equal(await client().describe(input), text);
    assert.deepEqual(input, original);
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});

test("rejeita configuração inválida e endpoint de outro domínio", t => {
  for (const options of [null, {}, { endpoint: "" }, { endpoint: "file:///tmp/file" },
    { endpoint: "http://user:secret@localhost/" }, { endpoint: "http://localhost", timeoutMs: 0 }]) {
    assert.throws(() => createClient(options), hasCode("CONFIGURATION_ERROR"));
  }
  const old = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://site.example/path/") });
  t.after(() => old ? Object.defineProperty(globalThis, "location", old) : delete globalThis.location);
  assert.ok(createClient({ endpoint: "../api/chatpcdas.php" }));
  assert.throws(() => createClient({ endpoint: "https://other.example/api" }), hasCode("CONFIGURATION_ERROR"));
});

test("rejeita entradas inválidas antes de acessar a rede", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Não deve consultar"); });
  const invalid = [undefined, null, [], {}, { ...request(), prompt: "\n\u00a0" },
    { ...request(), tables: [] }, { ...request(), tables: [{}] },
    { ...request(), tables: [{ name: "", rows: [{}] }] },
    { ...request(), tables: [{ name: "teste", rows: [] }] },
    { ...request(), tables: [{ name: "teste", rows: [[]] }] },
    { ...request(), tables: [{ name: "teste", rows: [{}] }] },
    { ...request(), tables: [{ name: "teste", rows: [{ a: 1 }], extra: 1 }] },
    { ...request(), signal: {} }];
  for (const input of invalid) await assert.rejects(client().describe(input), hasCode("INVALID_INPUT"));
  assert.equal(fetch.mock.callCount(), 0);
});

test("não perde valores não JSON, propriedades ou estruturas cíclicas", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Não deve consultar"); });
  const cyclic = {}; cyclic.self = cyclic;
  const getter = {}; Object.defineProperty(getter, "value", { enumerable: true, get() { throw new Error("Não executar"); } });
  const hidden = {}; Object.defineProperty(hidden, "secret", { value: "hidden" });
  const symbol = { [Symbol("key")]: "value" };
  const arrayWithExtra = [1]; arrayWithExtra.label = "não descartar";
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol("v"),
    new Date(), new Map(), cyclic, getter, hidden, symbol, new Array(2), arrayWithExtra]) {
    const input = request(); input.tables[0].rows[0].extra = value;
    await assert.rejects(client().describe(input), hasCode("INVALID_INPUT"));
  }
});

test("preserva objetos reutilizados e não executa toJSON", async t => {
  const input = request();
  const shared = { valor: null };
  input.tables[0].rows[0].a = shared;
  input.tables[0].rows[0].b = shared;
  t.mock.method(globalThis, "fetch", async () => response({ text_description: "ok" }));
  assert.equal(await client().describe(input), "ok");
  input.tables[0].rows[0].toJSON = () => { throw new Error("Não executar"); };
  await assert.rejects(client().describe(input), hasCode("INVALID_INPUT"));
});

test("respostas inválidas e falhas HTTP não expõem conteúdo remoto", async t => {
  const cases = [
    [response({}), "INVALID_RESPONSE"], [response({ text_description: " \n" }), "INVALID_RESPONSE"],
    [response({ text_description: 42 }), "INVALID_RESPONSE"], [response(null), "INVALID_RESPONSE"],
    [new Response("<html>segredo</html>"), "INVALID_RESPONSE"],
    [new Response("<html>segredo</html>", { status: 503 }), "HTTP_ERROR"],
    [response({ error: { code: "AUTHENTICATION_ERROR", message: "segredo" } }, 502), "AUTHENTICATION_ERROR"],
    [response({ error: { code: "UPSTREAM_ERROR", message: "segredo" } }, 502), "UPSTREAM_ERROR"],
    [response({ error: { code: "CONFIGURATION_ERROR" } }, 500), "CONFIGURATION_ERROR"],
    [response({ error: { code: "TIMEOUT" } }, 504), "TIMEOUT"],
    [response({ error: { code: "desconhecido", message: "segredo" } }, 500), "HTTP_ERROR"],
  ];
  for (const [result, code] of cases) {
    const fetch = t.mock.method(globalThis, "fetch", async () => result);
    await assert.rejects(client().describe(request()), error => {
      assert.equal(error.code, code);
      assert.equal(error.status, result.status);
      assert.doesNotMatch(error.message, /segredo/);
      return true;
    });
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});

test("falha de rede não repete a consulta", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new TypeError("segredo"); });
  await assert.rejects(client().describe(request()), hasCode("NETWORK_ERROR"));
  assert.equal(fetch.mock.callCount(), 1);
});

test("cancelamento anterior à consulta não acessa a rede", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Não consultar"); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client().describe({ ...request(), signal: controller.signal }), hasCode("ABORTED"));
  assert.equal(fetch.mock.callCount(), 0);
});

test("cancelamento durante a consulta aborta o fetch e remove o listener", async t => {
  let innerSignal;
  t.mock.method(globalThis, "fetch", (_url, options) => {
    innerSignal = options.signal;
    return new Promise(() => {});
  });
  const controller = new AbortController();
  const remove = t.mock.method(controller.signal, "removeEventListener");
  const pending = client().describe({ ...request(), signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, hasCode("ABORTED"));
  assert.equal(innerSignal.aborted, true);
  assert.equal(remove.mock.callCount(), 1);
});

test("timeout cobre também a leitura do corpo da resposta", async t => {
  let innerSignal;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    innerSignal = options.signal;
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  });
  await assert.rejects(client({ timeoutMs: 15 }).describe(request()), hasCode("TIMEOUT"));
  assert.equal(innerSignal.aborted, true);
});

test("timeout padrão é de 130 segundos e não permanece após sucesso", async t => {
  const set = t.mock.method(globalThis, "setTimeout", (_fn, ms) => { assert.equal(ms, 130000); return 77; });
  const clear = t.mock.method(globalThis, "clearTimeout", id => assert.equal(id, 77));
  t.mock.method(globalThis, "fetch", async () => response({ text_description: "ok" }));
  assert.equal(await client().describe(request()), "ok");
  assert.equal(set.mock.callCount(), 1);
  assert.equal(clear.mock.callCount(), 1);
});

test("validação informa o caminho do campo sem incluir seu valor", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Não consultar"); });
  const input = request();
  input.tables[0].rows[0].valor = Infinity;
  await assert.rejects(client().describe(input), error => {
    assert.equal(error.field, "tables[0].rows[0].valor");
    assert.match(error.message, /tables\[0\]\.rows\[0\]\.valor/);
    assert.doesNotMatch(error.message, /Infinity/);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 0);
});

test("preserva código, campo, identificador e Retry-After de erros do PHP", async t => {
  const id = "a".repeat(32);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    error: { code: "RATE_LIMITED", message: "não repassar", field: "tables" },
  }), { status: 429, headers: { "X-Request-ID": id, "Retry-After": "45" } }));
  await assert.rejects(client().describe(request()), error => {
    assert.equal(error.code, "RATE_LIMITED");
    assert.equal(error.requestId, id);
    assert.equal(error.retryAfter, 45);
    assert.equal(error.field, "tables");
    assert.doesNotMatch(error.message, /não repassar/);
    return true;
  });
});

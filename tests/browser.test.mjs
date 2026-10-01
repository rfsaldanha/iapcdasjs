import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { mockService, startPhp, testToken } from "./helpers.mjs";

test("navegador real: script comum, módulo ES, exemplo Proadess e erros", async t => {
  const mock = await mockService(t);
  const server = await startPhp(t, { upstream: mock.url });
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  const network = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => network.push({ url: request.url(), body: request.postData() }));
  await page.goto(server.url + "/__browser");
  await page.addScriptTag({ url: server.url + "/js/iapcdas.js" });

  const tables = [
    { name: "teste", rows: [{ codigo: "0001", valor: 0, ausente: null, texto: "Ação" }] },
    { name: "outra", rows: [{ status: "Informação suprimida" }] },
  ];
  const responseText = '**Resposta técnica**\n<img src=x onerror="window.executou=true">';
  mock.state.body = JSON.stringify({ text_description: responseText, campoExtra: testToken });

  assert.equal(await page.evaluate(async tables => {
    const client = IAPCDAS.createClient({ endpoint: "/api/chatpcdas.php" });
    return client.describe({ tables, prompt: "Prompt de teste." });
  }, tables), responseText);

  assert.equal(await page.evaluate(async tables => {
    const { createClient } = await import("/js/iapcdas.esm.js");
    return createClient({ endpoint: "/api/chatpcdas.php" }).describe({ tables, prompt: "Prompt de teste." });
  }, tables), responseText);

  await page.addScriptTag({ url: server.url + "/proadess.js" });
  const displayed = await page.evaluate(async tables => {
    const texto = await analisarDadosProadess({
      tables,
      indicador: "Metadado técnico de teste",
      periodo: "Período de teste",
      unidade: "Unidade de teste",
      recorteGeografico: "Recorte de teste",
      significadoDasColunas: "Nomes técnicos de teste",
      convencoesDeAusenciaESupressao: "Nulos indicam ausência; a string indica supressão",
      elementoResposta: document.getElementById("resposta"),
    });
    return {
      texto,
      exibido: document.getElementById("resposta").textContent,
      imagens: document.querySelectorAll("#resposta img").length,
      executou: Boolean(window.executou),
    };
  }, tables);
  assert.deepEqual(displayed, { texto: responseText, exibido: responseText, imagens: 0, executou: false });
  assert.match(mock.requests[2].body.data.context, /Use somente os dados fornecidos/);
  assert.match(mock.requests[2].body.data.context, /Período de teste/);

  for (const outgoing of mock.requests) {
    assert.equal(outgoing.body.token.token, testToken);
    assert.deepEqual(JSON.parse(outgoing.body.data.data), tables);
  }
  const browserCalls = network.filter(request => request.url.endsWith("/api/chatpcdas.php"));
  assert.equal(browserCalls.length, 3);
  for (const request of browserCalls) {
    assert.deepEqual(Object.keys(JSON.parse(request.body)).sort(), ["prompt", "tables"]);
    assert.doesNotMatch(request.body, new RegExp(testToken));
  }
  assert.ok(network.every(request => new URL(request.url).origin === server.url));
  assert.doesNotMatch(await page.content(), new RegExp(testToken));

  mock.state.status = 401;
  mock.state.body = testToken;
  const failure = await page.evaluate(async tables => {
    try {
      await IAPCDAS.createClient({ endpoint: "/api/chatpcdas.php" }).describe({ tables, prompt: "Teste" });
    } catch (error) {
      return { code: error.code, status: error.status, message: error.message };
    }
  }, tables);
  assert.equal(failure.code, "AUTHENTICATION_ERROR");
  assert.equal(failure.status, 502);
  assert.doesNotMatch(failure.message, new RegExp(testToken));
  assert.deepEqual(errors, []);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { IAPCDASError } from "../src/index.js";

function fixture() {
  const pending = [];
  const context = vm.createContext({
    AbortController,
    IAPCDAS: {
      IAPCDASError,
      createClient: () => ({
        // Ignora abort de propósito para testar também o descarte por identidade.
        describe: input => new Promise((resolve, reject) => pending.push({ ...input, resolve, reject })),
      }),
    },
  });
  vm.runInContext(readFileSync(new URL("../examples/proadess.js", import.meta.url), "utf8"), context);
  const input = element => ({
    tables: [{ name: "teste", rows: [{ valor: 0 }] }],
    indicador: "Teste", periodo: "Teste", unidade: "Teste", recorteGeografico: "Teste",
    significadoDasColunas: "Teste", convencoesDeAusenciaESupressao: "Teste", elementoResposta: element,
  });
  return { context, pending, input };
}

test("a resposta antiga nunca substitui a seleção mais recente", async () => {
  const { context, pending, input } = fixture();
  const element = { textContent: "" };
  const old = context.analisarDadosProadess(input(element));
  const current = context.analisarDadosProadess(input(element));
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve("Seleção atual");
  assert.equal(await current, "Seleção atual");
  pending[0].resolve("Seleção antiga");
  await assert.rejects(old, { code: "ABORTED" });
  assert.equal(element.textContent, "Seleção atual");
});

test("mudar filtros sem nova consulta cancela e descarta o resultado pendente", async () => {
  const { context, pending, input } = fixture();
  const element = { textContent: "Texto anterior" };
  const result = context.analisarDadosProadess(input(element));
  context.cancelarAnaliseProadess(element);
  pending[0].resolve("Resultado descartado");
  await assert.rejects(result, { code: "ABORTED" });
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(element.textContent, "Texto anterior");
});

test("elementos distintos mantêm consultas independentes", async () => {
  const { context, pending, input } = fixture();
  const first = { textContent: "" }, second = { textContent: "" };
  const a = context.analisarDadosProadess(input(first));
  const b = context.analisarDadosProadess(input(second));
  pending[1].resolve("B"); pending[0].resolve("A");
  await Promise.all([a, b]);
  assert.equal(first.textContent, "A");
  assert.equal(second.textContent, "B");
  assert.equal(pending[0].signal.aborted, false);
});

test("cancelamento externo e falhas permitem uma nova consulta no mesmo elemento", async () => {
  const { context, pending, input } = fixture();
  const element = { textContent: "" };
  const controller = new AbortController();
  const a = context.analisarDadosProadess({ ...input(element), signal: controller.signal });
  controller.abort();
  pending[0].resolve("Descartar");
  await assert.rejects(a, { code: "ABORTED" });
  const b = context.analisarDadosProadess(input(element));
  pending[1].reject(new IAPCDASError("UPSTREAM_ERROR", "Erro de teste"));
  await assert.rejects(b, { code: "UPSTREAM_ERROR" });
  const c = context.analisarDadosProadess(input(element));
  pending[2].resolve("Recuperado");
  assert.equal(await c, "Recuperado");
  assert.equal(element.textContent, "Recuperado");
});

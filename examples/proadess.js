/**
 * Exemplo sem coleta automática: o site fornece tabelas e metadados reais.
 * Carregue public/js/iapcdas.js antes deste arquivo.
 */
const consultasProadess = new WeakMap();

/** Chame ao mudar filtros, mesmo quando ainda não houver uma nova consulta. */
function cancelarAnaliseProadess(elementoResposta) {
  const current = consultasProadess.get(elementoResposta);
  if (current) {
    consultasProadess.delete(elementoResposta);
    current.controller.abort();
  }
}

async function analisarDadosProadess({
  tables, indicador, periodo, unidade, recorteGeografico, significadoDasColunas,
  convencoesDeAusenciaESupressao, elementoResposta, signal, endpoint = "/api/chatpcdas.php",
}) {
  if (!elementoResposta || typeof elementoResposta !== "object" || !("textContent" in elementoResposta)) {
    throw new Error("Informe o elemento que receberá o texto da análise.");
  }
  cancelarAnaliseProadess(elementoResposta);
  const current = { controller: new AbortController() };
  consultasProadess.set(elementoResposta, current);
  const abort = () => current.controller.abort();
  let listening = false;
  try {
    const metadados = [indicador, periodo, unidade, recorteGeografico,
      significadoDasColunas, convencoesDeAusenciaESupressao];
    if (metadados.some(value => typeof value !== "string" || !value.trim())) {
      throw new Error("Forneça os metadados reais do indicador e das tabelas.");
    }
    if (signal !== undefined) {
      if (!signal || typeof signal.addEventListener !== "function" ||
          typeof signal.removeEventListener !== "function" || typeof signal.aborted !== "boolean") {
        throw new IAPCDAS.IAPCDASError("INVALID_INPUT", "Informe um AbortSignal válido.");
      }
      signal.addEventListener("abort", abort, { once: true });
      listening = true;
      if (signal.aborted) abort();
    }
    const prompt = [
      "Descreva tecnicamente, em português, os dados das tabelas fornecidas.",
      "Indicador: " + indicador + ". Período: " + periodo + ". Unidade de medida: " + unidade + ".",
      "Recorte geográfico: " + recorteGeografico + ".",
      "Significado das tabelas e colunas: " + significadoDasColunas + ".",
      "Convenções de ausência e supressão: " + convencoesDeAusenciaESupressao + ".",
      "Use somente os dados fornecidos. Não invente valores, não preencha lacunas",
      "e não trate informação ausente ou suprimida como zero.",
      "Não infira relações causais. Identifique as limitações presentes nos dados.",
    ].join("\n");
    const client = IAPCDAS.createClient({ endpoint });
    const texto = await client.describe({ tables, prompt, signal: current.controller.signal });
    // Confere também a identidade: protege mesmo se um transporte ignorar o abort.
    if (consultasProadess.get(elementoResposta) !== current || current.controller.signal.aborted) {
      throw new IAPCDAS.IAPCDASError("ABORTED", "A consulta foi cancelada ou substituída.");
    }
    elementoResposta.textContent = texto;
    return texto;
  } finally {
    if (listening) signal.removeEventListener("abort", abort);
    if (consultasProadess.get(elementoResposta) === current) consultasProadess.delete(elementoResposta);
  }
}

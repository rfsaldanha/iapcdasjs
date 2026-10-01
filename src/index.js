/** Erro público da integração. As mensagens nunca incluem o corpo remoto. */
export class IAPCDASError extends Error {
  constructor(code, message, status = null, details = {}) {
    super(message);
    this.name = "IAPCDASError";
    this.code = code;
    this.status = status;
    this.field = typeof details.field === "string" ? details.field.slice(0, 256) : null;
    this.requestId = /^[a-f0-9]{32}$/.test(details.requestId ?? "") ? details.requestId : null;
    this.retryAfter = Number.isInteger(details.retryAfter) && details.retryAfter > 0 ? details.retryAfter : null;
  }
}

const messages = Object.freeze({
  INVALID_INPUT: "Informe um prompt e pelo menos uma tabela válida.",
  CONFIGURATION_ERROR: "A integração com o ChatPCDAS não está configurada.",
  METHOD_NOT_ALLOWED: "Use POST para consultar o ChatPCDAS.",
  UNSUPPORTED_MEDIA_TYPE: "Envie os dados como JSON em UTF-8.",
  FORBIDDEN: "A consulta não foi autorizada.",
  PAYLOAD_TOO_LARGE: "Os dados excedem os limites configurados para a consulta.",
  RESPONSE_TOO_LARGE: "A resposta do serviço excedeu o limite configurado.",
  RATE_LIMITED: "O limite de consultas foi atingido. Aguarde antes de tentar novamente.",
  SERVER_BUSY: "O limite de consultas simultâneas foi atingido. Tente novamente em instantes.",
  STORAGE_ERROR: "O controle de uso está indisponível.",
  INTERNAL_ERROR: "Não foi possível processar a consulta.",
  AUTHENTICATION_ERROR: "O ChatPCDAS recusou o token configurado no servidor.",
  UPSTREAM_ERROR: "Não foi possível consultar o ChatPCDAS. Tente novamente mais tarde.",
  INVALID_RESPONSE: "O serviço retornou uma resposta inválida.",
  HTTP_ERROR: "O servidor não conseguiu atender à consulta.",
  NETWORK_ERROR: "Não foi possível conectar ao servidor.",
  TIMEOUT: "O tempo de espera pela resposta foi excedido.",
  ABORTED: "A consulta foi cancelada.",
});

function failure(code, status = null, details = {}) {
  const message = code === "INVALID_INPUT" && details.field
    ? "Valor inválido no campo " + details.field.slice(0, 256) + "."
    : messages[code];
  return new IAPCDASError(code, message, status, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function fieldPath(parent, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? parent + "." + key : parent + "[" + JSON.stringify(key) + "]";
}

// Cria uma cópia JSON sem executar getters/toJSON ou perder valores silenciosamente.
function copyJson(value, path = "tables", ancestors = new Set(), depth = 0) {
  const invalid = field => failure("INVALID_INPUT", null, { field });
  if (depth > 64) throw invalid(path);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!Array.isArray(value) && !isObject(value)) throw invalid(path);
  if (ancestors.has(value)) throw invalid(path);

  ancestors.add(value);
  const array = Array.isArray(value);
  const result = array ? [] : Object.create(null);
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) throw invalid(path);
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string") throw invalid(path);
    const childPath = array ? path + "[" + key + "]" : fieldPath(path, key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !("value" in descriptor)) throw invalid(childPath);
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw invalid(childPath);
    result[key] = copyJson(descriptor.value, childPath, ancestors, depth + 1);
  }
  ancestors.delete(value);
  return result;
}

function requestBody(tables, prompt) {
  const invalid = field => failure("INVALID_INPUT", null, { field });
  if (typeof prompt !== "string" || !prompt.trim()) throw invalid("prompt");
  let copy;
  try {
    copy = copyJson(tables);
  } catch (error) {
    if (error instanceof IAPCDASError) throw error;
    throw invalid("tables");
  }
  if (!Array.isArray(copy) || copy.length === 0) throw invalid("tables");
  for (const [index, table] of copy.entries()) {
    const path = "tables[" + index + "]";
    if (!isObject(table) || Object.keys(table).length !== 2) throw invalid(path);
    if (typeof table.name !== "string" || !table.name.trim()) throw invalid(path + ".name");
    if (!Array.isArray(table.rows) || table.rows.length === 0) throw invalid(path + ".rows");
    table.rows.forEach((row, rowIndex) => {
      if (!isObject(row) || Object.keys(row).length === 0) throw invalid(path + ".rows[" + rowIndex + "]");
    });
  }
  return JSON.stringify({ tables: copy, prompt });
}

/**
 * Cria um cliente para o intermediário PHP no mesmo domínio.
 * @param {{endpoint: string, timeoutMs?: number}} options
 * @returns {{describe: (request: {tables: Array<{name: string, rows: object[]}>, prompt: string, signal?: AbortSignal}) => Promise<string>}}
 */
export function createClient(options = {}) {
  if (!isObject(options)) throw failure("CONFIGURATION_ERROR");
  const { endpoint, timeoutMs = 130000 } = options;
  if (typeof endpoint !== "string" || !endpoint.trim() ||
      !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw failure("CONFIGURATION_ERROR");
  }

  let url;
  try {
    url = new URL(endpoint, globalThis.location?.href);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
        (globalThis.location && url.origin !== globalThis.location.origin)) throw new Error();
  } catch {
    throw failure("CONFIGURATION_ERROR");
  }

  return Object.freeze({
    async describe(request = {}) {
      if (!isObject(request)) throw failure("INVALID_INPUT");
      const { tables, prompt, signal } = request;
      if (signal?.aborted) throw failure("ABORTED");
      const body = requestBody(tables, prompt);
      if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" ||
          typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
        throw failure("INVALID_INPUT");
      }
      if (signal?.aborted) throw failure("ABORTED");

      const controller = new AbortController();
      let interrupted;
      let rejectInterruption;
      const interruption = new Promise((_, reject) => { rejectInterruption = reject; });
      const interrupt = code => {
        if (interrupted) return;
        interrupted = code;
        controller.abort();
        rejectInterruption(failure(code));
      };
      const onAbort = () => interrupt("ABORTED");
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => interrupt("TIMEOUT"), timeoutMs);

      const execute = async () => {
        const response = await fetch(url.href, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=UTF-8", Accept: "application/json" },
          body,
          mode: "same-origin",
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        });
        const responseError = (code, field = null) => failure(code, response.status, {
          field: typeof field === "string" ? field : null,
          requestId: response.headers?.get("X-Request-ID"),
          retryAfter: Number(response.headers?.get("Retry-After")),
        });
        let data;
        try {
          data = await response.json();
        } catch {
          throw responseError(response.ok ? "INVALID_RESPONSE" : "HTTP_ERROR");
        }
        if (!response.ok) {
          const code = data?.error?.code;
          // Só usa mensagens locais conhecidas; nunca repassa mensagens remotas.
          throw responseError(Object.hasOwn(messages, code) ? code : "HTTP_ERROR", data?.error?.field);
        }
        if (!data || typeof data.text_description !== "string" || !data.text_description.trim()) {
          throw responseError("INVALID_RESPONSE");
        }
        return data.text_description;
      };

      try {
        return await Promise.race([execute(), interruption]);
      } catch (error) {
        if (interrupted) throw failure(interrupted);
        if (error instanceof IAPCDASError) throw error;
        throw failure("NETWORK_ERROR");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  });
}

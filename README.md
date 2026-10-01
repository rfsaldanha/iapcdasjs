# IAPCDASJS

Biblioteca JavaScript para obter uma resposta textual do ChatPCDAS a partir de uma ou mais tabelas nomeadas e um prompt. Um intermediário PHP mantém o token no servidor.

O contrato de autenticação e de envio segue a integração de `../sentseca2/R/ai.R`. Não há interface visual, histórico de conversa, coleta automática de dados ou dependências de execução no JavaScript.

## Requisitos

- Servidor com **PHP 8.0 ou superior**, extensões **cURL** e **JSON**, certificados TLS e acesso HTTPS a `bigdata-api.fiocruz.br`.
- Navegador moderno com ES2022, `fetch`, `Promise` e `AbortController`.
- JavaScript e endpoint PHP na **mesma origem**: mesmo protocolo, domínio e porta.
- Dados, prompt, scripts e resposta em **UTF-8**.

Node.js e npm são necessários somente para desenvolver ou regenerar os arquivos distribuídos. O servidor do site não precisa deles, nem de Composer, jQuery ou framework.

## Instalação no servidor

A estrutura separa os arquivos públicos da configuração privada:

```text
iapcdasjs/
├── public/                  ← raiz pública do servidor
│   ├── api/chatpcdas.php
│   └── js/
│       ├── iapcdas.js        ← script comum: global IAPCDAS
│       └── iapcdas.esm.js    ← módulo ES
├── server/                  ← implementação privada
│   ├── ChatPCDAS.php
│   └── Controls.php
├── var/                     ← cotas e locks privados (ignorado pelo Git)
├── config/
│   └── local.example.php
└── examples/proadess.js     ← exemplo para adaptar ao site
```

1. Copie o projeto preservando essa estrutura e configure a raiz pública como `public/`. Os dois arquivos JavaScript distribuíveis já estão incluídos no repositório.
2. Crie o diretório privado `var/`, gravável pelo usuário do PHP, para compartilhar cotas entre os workers.
3. Configure o token por uma das opções abaixo.
4. Carregue um dos scripts JavaScript na página e use o endpoint PHP da mesma origem.

**Token em variável de ambiente:** configure `PCDAS_TOKEN` no ambiente do processo PHP. Em PHP-FPM, o ambiente do terminal pode não ser repassado aos workers; configure-o no serviço/pool que atende ao site. A biblioteca não carrega arquivos `.env` automaticamente.

**Token em arquivo privado:**

```sh
cp config/local.example.php config/local.php
```

Edite o campo `token` de `config/local.php` com sua credencial. Esse arquivo está ignorado pelo Git e deve permanecer fora da raiz pública, acessível apenas ao processo PHP e aos administradores.

Uma variável `PCDAS_TOKEN` não vazia tem precedência sobre o arquivo. Sem variável ou com variável vazia, o PHP usa o arquivo local. Uma variável contendo somente espaços é um erro de configuração. As demais opções do arquivo local continuam sendo lidas mesmo quando o token vem do ambiente. O navegador não recebe nem fornece o token.

Para desenvolvimento local, após configurar o token:

```sh
php -S 127.0.0.1:8080 -t public
```

Esse comando inicia o endpoint e os arquivos estáticos, sem página inicial. Abrir o endpoint diretamente resulta em HTTP 405 porque ele aceita somente POST. A chamada ao serviço real só acontece quando uma entrada válida é enviada.

### Instalação em um site PHP existente

Mantenha `server/` e `config/` fora da raiz pública, por exemplo em `/srv/iapcdas/`. Copie os arquivos de `public/js/` para a pasta de scripts do site. No endpoint do site, adapte o caminho absoluto do arquivo privado:

```php
<?php
declare(strict_types=1);

ini_set('display_errors', '0');
require '/srv/iapcdas/server/ChatPCDAS.php';

\IAPCDAS\serve();
```

Nesse exemplo, a configuração local fica em `/srv/iapcdas/config/local.php`. Não copie a configuração nem os testes para a pasta pública.

## Uso com script comum

Carregue o arquivo antes do código de integração:

```html
<script src="/js/iapcdas.js" charset="utf-8"></script>
```

No código do site:

```javascript
const client = IAPCDAS.createClient({
  endpoint: "/api/chatpcdas.php"
});

async function obterAnalise(linhasDoSite, promptDaAnalise) {
  return client.describe({
    tables: [{ name: "indicadores", rows: linhasDoSite }],
    prompt: promptDaAnalise
  });
}
```

As variáveis de entrada representam os dados e o prompt reais da aplicação. A biblioteca não inclui valores ou indicadores demonstrativos.

## Uso como módulo ES

Em um script com `type="module"`, ou em outro módulo JavaScript:

```javascript
import { createClient, IAPCDASError } from "/js/iapcdas.esm.js";

const client = createClient({ endpoint: "/api/chatpcdas.php" });

async function obterAnalise(tabelasDoSite, promptDaAnalise) {
  try {
    return await client.describe({
      tables: tabelasDoSite,
      prompt: promptDaAnalise
    });
  } catch (error) {
    if (error instanceof IAPCDASError) {
      console.error(error.code, error.message);
    }
    throw error;
  }
}
```

## Interface e formato dos dados

`createClient({ endpoint, timeoutMs? })` retorna um cliente com `describe({ tables, prompt, signal? })`. Cada chamada é independente e devolve `Promise<string>`.

| Campo | Significado |
| --- | --- |
| `endpoint` | URL do intermediário PHP, relativa à página ou absoluta na mesma origem. |
| `timeoutMs` | Tempo máximo no navegador, em milissegundos. Padrão: 130000. |
| `tables` | Array não vazio de objetos com exatamente `name` e `rows`. |
| `name` | Nome não vazio que identifica a tabela no prompt. |
| `rows` | Array não vazio de objetos não vazios; cada chave é uma coluna. |
| `prompt` | Texto não vazio enviado sem alterações. Descreva colunas, unidades e contexto. |
| `signal` | `AbortSignal` opcional para interromper a espera no navegador. |

Para várias tabelas:

```javascript
async function compararTabelas(linhasIndicadores, linhasContexto, promptDaAnalise) {
  return client.describe({
    tables: [
      { name: "indicadores", rows: linhasIndicadores },
      { name: "contexto", rows: linhasContexto }
    ],
    prompt: promptDaAnalise
  });
}
```

Os valores podem ser strings, números finitos, booleanos, nulos, arrays e objetos JSON. Zero, nulo, texto acentuado e códigos como strings são preservados. Use strings para identificadores com zeros à esquerda e inteiros que ultrapassem a precisão segura do JavaScript. A biblioteca não converte tipos, arredonda indicadores, resume tabelas ou preenche lacunas.

Entradas vazias ou inválidas são rejeitadas antes da consulta. Também são rejeitados valores que JSON perderia ou transformaria silenciosamente: `undefined`, `NaN`, `Infinity`, `BigInt`, funções, símbolos, datas, instâncias de classes, referências cíclicas, arrays com lacunas ou propriedades extras, getters e propriedades não enumeráveis. Objetos de dados têm limite de 64 níveis de profundidade.

Transforme explicitamente os dados para valores JSON antes da chamada quando necessário. Preserve a semântica das ausências e supressões; não substitua esses valores por zero.

### Cancelamento e apresentação da resposta

```javascript
async function analisarComCancelamento(tables, prompt, elementoResposta, signal) {
  const texto = await client.describe({ tables, prompt, signal });
  elementoResposta.textContent = texto;
  return texto;
}

const controller = new AbortController();
// Passe controller.signal à função acima.
// No evento de cancelamento do próprio site, execute controller.abort().
```

A resposta é texto bruto, incluindo eventuais quebras de linha ou marcação Markdown. A biblioteca não converte Markdown nem renderiza HTML. Para preservar quebras ao exibir, use um elemento `<pre>` ou CSS `white-space: pre-wrap`.

O cancelamento interrompe a espera e a conexão do navegador. Ele não garante o cancelamento do trabalho que já começou no PHP ou no serviço remoto. Não há repetição automática de consultas.

## Contrato HTTP

Navegador → PHP:

```javascript
{
  tables: [{ name: "indicadores", rows: linhasDoSite }],
  prompt: promptDaAnalise
}
```

PHP → `https://bigdata-api.fiocruz.br/text_description/`:

```javascript
{
  token: { token: tokenDoServidor },
  data: {
    data: JSON.stringify(tables),
    context: prompt
  }
}
```

`data.data` é uma **string contendo JSON**, inclusive quando há somente uma tabela. O intermediário não aceita token nem URL remota enviados pelo navegador. A autenticação segue o campo aninhado `token.token`, sem substituir esse contrato por Bearer.

Em sucesso, o PHP devolve apenas `{ text_description: texto }`; o JavaScript retorna a string. Em falha, o PHP devolve `{ error: { code, message } }`, e o cliente rejeita com `IAPCDASError`. Corpos de erro e campos extras do serviço remoto não são repassados.

O PHP aceita somente POST com `Content-Type: application/json`. Não habilita CORS, rejeita requisições identificadas pelo navegador como originadas de outro site e responde com `Cache-Control: no-store`. A integração não cria contas ou autenticação de usuários; aplica limites por IP, globais e de concorrência e permite integrar a autorização do site.

## Erros

Os erros JavaScript possuem `code`, `message`, `status`, `field`, `requestId` e `retryAfter`. Os três últimos identificam o campo inválido, a consulta nos logs e a espera sugerida, quando disponíveis. `status` é o status HTTP do intermediário, ou `null` quando a falha ocorre localmente.

| Código | Situação |
| --- | --- |
| `INVALID_INPUT` | Prompt, tabelas ou valores inválidos. |
| `PAYLOAD_TOO_LARGE` | Limite de corpo, prompt ou tabelas excedido; HTTP 413. |
| `RESPONSE_TOO_LARGE` | Resposta remota excessiva; HTTP 502. |
| `RATE_LIMITED` | Cota por IP ou global excedida; HTTP 429 com `Retry-After`. |
| `SERVER_BUSY` | Sem vaga de concorrência ou lock de admissão ocupado; HTTP 429. |
| `STORAGE_ERROR` | Armazenamento das cotas indisponível; HTTP 503. |
| `INTERNAL_ERROR` | Falha interna inesperada; HTTP 500. |
| `CONFIGURATION_ERROR` | Configuração do cliente inválida, token ausente ou cURL indisponível. |
| `METHOD_NOT_ALLOWED` | Método diferente de POST; HTTP 405. |
| `UNSUPPORTED_MEDIA_TYPE` | Corpo não identificado como JSON; HTTP 415. |
| `FORBIDDEN` | Origem recusada ou autorização negada pelo site; HTTP 403. |
| `AUTHENTICATION_ERROR` | Serviço remoto respondeu 401/403; o intermediário devolve HTTP 502. |
| `UPSTREAM_ERROR` | Falha de conexão ou HTTP do serviço remoto; HTTP 502. |
| `INVALID_RESPONSE` | JSON inválido ou texto ausente, vazio ou de tipo incorreto. |
| `HTTP_ERROR` | Resposta HTTP de erro que não segue o contrato do intermediário. |
| `NETWORK_ERROR` | Navegador não conseguiu se comunicar com o intermediário. |
| `TIMEOUT` | Prazo do cliente ou do serviço remoto excedido; timeout remoto usa HTTP 504. |
| `ABORTED` | Consulta cancelada por `AbortSignal`. |

As mensagens são em português e não contêm o token nem detalhes brutos do serviço remoto.

## Limites, autorização e diagnóstico

Por padrão, cada consulta aceita até 2 MiB de JSON, 10 tabelas, 20000 linhas no total e 100 colunas por linha. A resposta remota aceita até 1 MiB. Há cotas de 10 chamadas por IP e 60 globais por janela móvel de 60 segundos, com 4 consultas simultâneas. Esses padrões são locais e configuráveis.

Consulte [o guia de operação](docs/operacao.md) para configurar limites, armazenamento privado, autorização do site e logs sem dados sensíveis.

## Timeouts e codificação

A chamada PHP ao ChatPCDAS tem limite de **120 segundos**, incluindo até 10 segundos para conexão. O cliente espera **130 segundos**, por padrão. O endpoint ajusta o limite de execução PHP para 130 segundos quando permitido.

Configure também os limites externos acima de 130 segundos, por exemplo 150 segundos em `request_terminate_timeout` do PHP-FPM e `fastcgi_read_timeout` do Nginx. Se houver um proxy HTTP, ajuste seu timeout de leitura. A configuração efetiva depende da infraestrutura do site.

Sirva os scripts como JavaScript em UTF-8. Dados vindos de bancos ou arquivos com outra codificação devem ser convertidos para UTF-8 na origem, antes de gerar JSON. A integração não adivinha a codificação nem altera os dados automaticamente.

## Integração com o Proadess

Consulte [o guia do Proadess](docs/proadess.md) e [a função de exemplo](examples/proadess.js). O site fornece os arrays e metadados reais; o exemplo não coleta camadas Leaflet nem muda filtros.

## Desenvolvimento e testes

Requer Node.js 22 ou superior, npm, PHP 8 com cURL e Google Chrome instalado. As dependências npm são exclusivamente de desenvolvimento, com versões fixadas no lockfile:

```sh
npm ci
npm run check
```

Comandos separados:

```sh
npm run build:check    # confere os distribuíveis sem modificá-los
npm run build          # regenera os dois arquivos em public/js/
npm test               # JavaScript, sintaxe PHP, contrato e integração HTTP/cURL
npm run test:browser   # navegador real com script comum, módulo ES e exemplo
php tests/server.test.php
php tests/controls.test.php
```

Para instalações não padrão:

```sh
PHP_BINARY=/caminho/do/php CHROME_PATH=/caminho/do/chrome npm run check
```

`PHPRC` também pode apontar para um `php.ini` específico. Os testes iniciam servidores somente em `127.0.0.1`, escolhem portas livres e encerram os processos ao terminar. O roteador de testes exige um serviço simulado local, substitui qualquer token herdado por uma fixture e nunca consulta a API real.

As verificações cobrem validação e fidelidade dos dados, uma e várias tabelas, contrato de autenticação, configuração por ambiente/arquivo, erros HTTP, timeout real do cURL, cancelamento, ausência de token no tráfego do navegador e exibição sem executar HTML.

O contrato foi obtido da implementação de referência. Além dos testes simulados, foram executadas consultas reais com uma e duas tabelas e dados do sentseca2. Veja [o registro da validação real](docs/validacao-real.md), incluindo a amostra e seus limites. Para repetir com dados autorizados, use [o verificador manual](docs/operacao.md#verificação-real-da-api).

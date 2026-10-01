# Operação, limites e diagnóstico

Os controles abaixo são locais ao intermediário. Seus valores são padrões deste projeto, não limites declarados pela API ChatPCDAS. Ajuste-os à capacidade e ao uso esperado do site em `config/local.php`.

## Limites padrão

| Configuração | Padrão | O que limita |
| --- | --- | --- |
| `limits.request_bytes` | 2097152 (2 MiB) | Corpo JSON recebido do navegador. |
| `limits.response_bytes` | 1048576 (1 MiB) | Corpo da resposta remota. |
| `limits.prompt_bytes` | 20000 | Prompt em bytes UTF-8. |
| `limits.tables` | 10 | Tabelas por consulta. |
| `limits.rows` | 20000 | Total de linhas somando as tabelas. |
| `limits.columns` | 100 | Colunas de cada linha. |
| `usage.window_seconds` | 60 | Janela móvel das cotas. |
| `usage.per_client` | 10 | Consultas iniciadas por IP na janela. |
| `usage.global` | 60 | Consultas iniciadas na instalação na janela. |
| `usage.concurrent` | 4 | Consultas remotas simultâneas na instalação. |

As configurações numéricas exigem inteiros positivos. Os campos de `limits` aceitam valores de até 104857600; os de `usage`, até 10000. Campos desconhecidos ou configurações inválidas causam `CONFIGURATION_ERROR`.

O PHP lê no máximo o limite do corpo mais um byte, inclusive quando `Content-Length` está ausente. A resposta remota é limitada durante a transferência cURL. Dados excessivos resultam em `PAYLOAD_TOO_LARGE` (413); resposta excessiva resulta em `RESPONSE_TOO_LARGE` (502). Nenhuma tabela é truncada silenciosamente.

## Cotas compartilhadas e armazenamento

Crie o diretório privado `var/`, fora da raiz pública, e conceda leitura e escrita ao usuário dos workers PHP. O caminho pode ser alterado por `storage_dir`. Quando puder criar o diretório, o projeto usa permissão 0700; os arquivos criados recebem 0600.

Os processos PHP compartilham contadores e locks nesse diretório. A janela é móvel: eventos antigos são removidos na próxima consulta admitida. Cada chamada remota iniciada consome cota, mesmo se falhar; entradas inválidas, autorização negada e recusas por concorrência não consomem cota.

As vagas de concorrência usam `flock`. São liberadas no término da consulta, na exceção e no encerramento do processo. O lock dos contadores é mantido apenas durante a admissão, sem abranger a chamada remota. Falta de vagas ou contenção desse lock gera `SERVER_BUSY`. Cota por IP ou global excedida gera `RATE_LIMITED`. Ambos usam HTTP 429 e `Retry-After` em segundos.

A identificação usa `REMOTE_ADDR`. Cabeçalhos como `X-Forwarded-For` enviados pelo cliente não alteram a cota. Atrás de um proxy, configure o próprio servidor web para reconhecer somente proxies confiáveis e preencher `REMOTE_ADDR` corretamente. Pessoas que compartilham um IP também compartilham essa cota.

O arquivo de contadores guarda horário e hash SHA-256 do identificador de IP, sem prompt, tabelas ou token. Hash de IP é pseudonimização, não anonimização. O diretório deve permanecer privado.

Use disco local compartilhado pelos workers da mesma instalação. Os limites não se coordenam entre máquinas com diretórios separados. Para múltiplos servidores, aplique cotas globais também no balanceador ou substitua o controle por armazenamento centralizado. Não apague os arquivos de lock durante consultas em andamento. Ao reduzir o número de vagas, encerre as consultas existentes antes de reiniciar os workers.

Se o estado estiver corrompido ou não puder ser gravado, o endpoint retorna `STORAGE_ERROR` (503) e não chama a API. Interrompa os workers antes de reparar ou reinicializar o estado.

## Autorização do site

Por padrão, o endpoint continua público, sujeito às cotas. Os controles de origem e de uso não identificam quem está usando a interface do Proadess.

Quando o site já possuir autorização de usuários, configure `authorize` como uma função que receba o contexto HTTP e retorne exatamente `true` para permitir a consulta. A função roda antes da leitura do corpo e do token.

Exemplo para adaptar à sessão já existente no site:

~~~php
'authorize' => static function (array $server): bool {
    if (session_status() !== PHP_SESSION_ACTIVE) session_start();
    // Substitua esta chave pela regra de autorização real da aplicação.
    $allowed = ($_SESSION['pode_consultar_ia'] ?? false) === true;
    session_write_close(); // Libera a sessão antes de esperar pela IA.
    return $allowed;
},
~~~

A biblioteca não cria login ou sessões automaticamente. Uma recusa retorna `FORBIDDEN` (403). O token ChatPCDAS continua sendo uma credencial exclusiva do servidor.

## Erros e logs

Cada consulta HTTP recebe um identificador aleatório em `X-Request-ID`. Em erros, o mesmo identificador aparece em `error.request_id`. O cliente JavaScript expõe:

| Propriedade | Conteúdo |
| --- | --- |
| `code` | Código estável do erro. |
| `message` | Mensagem em português, sem corpo bruto da API. |
| `status` | Status HTTP do intermediário, ou `null` para falhas locais. |
| `field` | Caminho inválido, quando identificável, como `tables[0].rows[3].valor`. |
| `requestId` | Identificador recebido do PHP, ou `null`. |
| `retryAfter` | Espera sugerida em segundos, ou `null`. |

Não há repetição automática, mesmo quando `retryAfter` está presente.

O PHP escreve um evento JSON por requisição em `error_log`, com somente `event`, `request_id`, `duration_ms`, `status` e `code`. Não são registrados token, prompt, tabelas, IP ou mensagens brutas de exceções. Erros internos inesperados usam `INTERNAL_ERROR` (500), diferenciando-os de falhas HTTP do ChatPCDAS.

Para usar outro destino de logs, configure `logger` como `callable(array $event): void`. O evento recebido mantém os mesmos campos. Uma falha do logger não altera a resposta da consulta.

## Verificação real da API

O comando abaixo faz uma chamada real e é separado dos testes automatizados:

~~~sh
php scripts/verify-live.php --confirm /caminho/consulta.json
~~~

O arquivo deve conter o mesmo objeto `{ tables, prompt }` usado no navegador, com dados reais autorizados para envio. Guarde os arquivos em `verification-inputs/`, ignorado pelo Git, ou fora do repositório.

O comando usa `PCDAS_TOKEN` ou a configuração privada, aplica os limites e as cotas e escreve em stdout o status, o identificador e o resultado. O log de diagnóstico vai para stderr. Ele não copia a credencial. Como ferramenta administrativa CLI, não executa a função de autorização HTTP do site.

Sem `--confirm`, o comando exibe ajuda e termina sem consultar. Não faz parte da CI e não usa credenciais de outro projeto automaticamente.

Para conferir a interpretação, compare respostas de uma tabela e de tabelas relacionadas com os valores originais, as chaves e as unidades. Teste ausências e supressões somente com casos que realmente existam nos dados. O sucesso HTTP sozinho não comprova a correção da análise.

Veja [o registro dos testes reais executados](validacao-real.md).

## Verificação contínua

O workflow `.github/workflows/test.yml` executa testes com PHP 8.0 a 8.5 e uma etapa com Chrome. As versões 8.0 e 8.1 são incluídas para testar a compatibilidade mínima anunciada pelo projeto.

`npm run build:check` compara os dois arquivos distribuídos com uma compilação em memória. Falha se houver diferença ou arquivo ausente, sem reescrever o repositório. `npm run check` começa por essa conferência; após mudar o código-fonte, execute `npm run build` antes.

A CI usa somente tokens e serviços simulados. A criação do workflow não significa que essa matriz já foi executada no GitHub; a execução depende do envio do repositório.

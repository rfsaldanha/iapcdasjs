# Uso no Proadess

Este guia prepara a biblioteca para [o site de mapas do Proadess](https://mapas.proadess.icict.fiocruz.br/), que usa PHP e JavaScript. O projeto entrega a função de consulta; a interface e o evento que dispara a análise ficam sob responsabilidade do site.

## Publicar os componentes

Siga [a instalação para um site existente](../README.md#instalação-em-um-site-php-existente). Mantenha o token e o código PHP privado fora da raiz pública e disponibilize o endpoint no mesmo domínio do Proadess.

Copie também [examples/proadess.js](../examples/proadess.js) para a pasta de scripts do site. Carregue-o após a biblioteca:

```html
<script src="/js/iapcdas.js" charset="utf-8"></script>
<script src="/js/proadess.js" charset="utf-8"></script>
```

A função `analisarDadosProadess` fica disponível para o JavaScript do site. Não depende de jQuery ou Leaflet.

## Fornecer os dados reais

Passe arrays tabulares produzidos pelo próprio site após aplicar os filtros relevantes. Cada tabela deve ter um nome e linhas como objetos.

- Envie as colunas necessárias à análise: identificadores, nomes geográficos, valores e outras informações pertinentes ao prompt.
- Não inclua coordenadas, polígonos ou objetos Leaflet. Se a origem for GeoJSON, faça no código do site uma seleção explícita das propriedades tabulares.
- Preserve os códigos geográficos como strings quando isso for necessário para manter zeros à esquerda.
- Mantenha ausências e informações suprimidas distintas de zero e de valores observados. Explique os códigos ou marcadores usados no prompt.
- Use os metadados do conjunto efetivamente apresentado, incluindo indicador, período, unidade e recorte. Não deduza esses metadados de nomes de variáveis.

A biblioteca não calcula estatísticas nem reduz o volume de dados automaticamente. Se o site enviar resumos, eles devem ser calculados a partir dos dados reais e identificados como resumos no prompt.

## Chamar a função

O exemplo abaixo recebe todos os valores do site, sem indicadores ou números inventados:

```javascript
async function descreverSelecaoProadess({
  linhasDoIndicador,
  linhasComplementares,
  metadados,
  elementoResposta,
  signal
}) {
  const tables = [
    { name: "indicador_selecionado", rows: linhasDoIndicador }
  ];

  if (linhasComplementares?.length) {
    tables.push({
      name: "contexto_da_selecao",
      rows: linhasComplementares
    });
  }

  return analisarDadosProadess({
    tables,
    indicador: metadados.indicador,
    periodo: metadados.periodo,
    unidade: metadados.unidade,
    recorteGeografico: metadados.recorteGeografico,
    significadoDasColunas: metadados.significadoDasColunas,
    convencoesDeAusenciaESupressao:
      metadados.convencoesDeAusenciaESupressao,
    elementoResposta,
    signal,
    endpoint: "/api/chatpcdas.php"
  });
}
```

Os seis campos de metadados são textos não vazios. Quando não houver unidade ou marcador de supressão, descreva essa condição explicitamente conforme a definição real do indicador.

`elementoResposta` é um elemento existente da página. A função usa `textContent`, retorna o mesmo texto e deixa o tratamento de erros para quem a chamou. Não cria botão, modal, spinner ou efeito de digitação. As instruções do prompt pedem português, uso exclusivo dos dados fornecidos, preservação de ausências e nenhuma inferência causal.

O exemplo cancela a chamada anterior para o mesmo elemento e só exibe a resposta da consulta mais recente. Elementos diferentes mantêm consultas independentes. Quando os filtros mudarem sem uma nova consulta, chame `cancelarAnaliseProadess(elementoResposta)`. Consultas canceladas ou substituídas rejeitam com `ABORTED`; o site pode ignorar esse código. Capture os dados e metadados da mesma seleção antes de chamar a função.

## Exportar tabelas do PHP para JavaScript

Caso as tabelas estejam no PHP, serialize as variáveis reais como JSON. Em um bloco de script, escape também caracteres que poderiam fechar o elemento HTML:

```php
<script>
const tabelasDoSite = <?= json_encode(
    $tabelasDoSite,
    JSON_THROW_ON_ERROR
    | JSON_HEX_TAG
    | JSON_HEX_AMP
    | JSON_HEX_APOS
    | JSON_HEX_QUOT
    | JSON_PRESERVE_ZERO_FRACTION
) ?>;
</script>
```

`$tabelasDoSite` deve ter a estrutura `[{ name, rows }]`. Arrays de linhas PHP precisam ter índices sequenciais; após filtros que preservam índices, use `array_values()` na lista de linhas para que `json_encode()` produza um array JSON. Cada linha deve ser um objeto/registro com nomes de colunas.

Não use `JSON_NUMERIC_CHECK`: ele converteria strings numéricas e poderia alterar códigos. Não insira o token nesse bloco.

## UTF-8 e limites de tempo

O HTML público observado no Proadess declara ISO-8859-1, enquanto o cabeçalho HTTP observado declara UTF-8. Verifique a codificação efetiva dos arquivos e das consultas ao banco durante a integração.

Os scripts desta biblioteca e a API usam UTF-8. Para dados de uma fonte legada, converta a partir da codificação conhecida antes de serializar. Não aplique conversões repetidas ou substituições de caracteres sem verificar a origem.

Configure PHP-FPM e servidor web para permitir a conclusão da chamada remota de 120 segundos; o navegador espera 130 segundos por padrão. Consulte [timeouts e codificação](../README.md#timeouts-e-codificação).

## Validação no site

Após conectar dados e metadados reais, confira se a seleção enviada corresponde ao mapa exibido, se zeros e ausências continuam distintos e se o texto aparece no elemento escolhido.

Os testes automatizados usam fixtures e um serviço simulado. Também foram executadas duas consultas reais ao ChatPCDAS com o token autorizado do sentseca2 e dados reais desse projeto; [o registro descreve o resultado e as limitações](validacao-real.md). Não houve publicação no Proadess. Verifique ainda a interpretação dos indicadores e das convenções de supressão específicos do Proadess com seus próprios dados.

Antes da publicação, configure os [limites e o diretório privado de cotas](operacao.md). Se o site tiver autorização de usuários, conecte-a pelo callback `authorize`.

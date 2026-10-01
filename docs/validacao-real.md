# Validação real do ChatPCDAS

Execução em 1 de outubro de 2026, autorizada pelo usuário, com o token do projeto `../sentseca2` carregado apenas em memória. Nenhuma credencial foi copiada para este repositório.

## Dados de origem

Amostra de precipitação mensal do TerraClimate, em mm, de dezembro de 2025. Fonte local: `sentseca2/data/releases/20260930T200759-1243406/terraclimate.duckdb`, tabela `terraclimate`, indicador `ppt`. Os nomes foram associados pelo `geo.rds` da mesma publicação.

Foram selecionados os dois menores valores observados e o maior valor observado nesse recorte do banco. A amostra não representa a distribuição nacional.

| Código | Município | UF | Precipitação (mm) |
| --- | --- | --- | --- |
| 240480 | Ipueira | RN | 0.26523420214653 |
| 241210 | São João do Sabugi | RN | 0.264010280370712 |
| 313680 | Juramento | MG | 246.550155639648 |

## Consultas e resultado

| Caso | Estrutura enviada | Resultado | Identificador |
| --- | --- | --- | --- |
| single | Uma tabela nomeada com valores e nomes | HTTP 200 | `c0ae1e3f9d3ad1006005dd532692c09a` |
| multiple | Duas tabelas nomeadas relacionadas por cod_mun | HTTP 200 | `a0e472210e3cb913f51b05127901f41c` |

Nas duas respostas, a IA reproduziu todos os nomes, códigos e valores enviados, usou mm e identificou Juramento como o maior valor da amostra. Na consulta com duas tabelas, os nomes e os valores foram relacionados corretamente pela chave `cod_mun`. Esses elementos foram conferidos automaticamente contra o JSON de entrada e as respostas foram inspecionadas.

## Limites desta verificação

A amostra não contém zero, valor nulo ou informação suprimida. Esses cenários têm testes simulados de preservação dos dados, mas sua interpretação pela IA não foi validada nesta execução real. Também não houve consulta com o volume completo de um mapa nem teste com indicadores próprios do Proadess.

O resultado confirma o funcionamento para estes casos e esta amostra. Não garante a correção de futuras respostas. A credencial não foi salva como configuração deste projeto, e consultas reais não fazem parte da CI.

Para repetir com dados autorizados, use [o verificador manual](operacao.md#verificação-real-da-api).

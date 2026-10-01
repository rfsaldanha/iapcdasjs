<?php
declare(strict_types=1);

require dirname(__DIR__) . '/server/ChatPCDAS.php';

use IAPCDAS\ApiError;
use function IAPCDAS\handleRequest as rawHandleRequest;
use function IAPCDAS\loadToken;

$testStorage = sys_get_temp_dir() . '/iapcdas-unit-' . bin2hex(random_bytes(6));
register_shutdown_function(static function () use ($testStorage): void {
    foreach (glob($testStorage . '/*') ?: [] as $file) unlink($file);
    if (is_dir($testStorage)) rmdir($testStorage);
});
function handleRequest(array $server, string $body, callable $token, ?callable $transport = null): array
{
    global $testStorage;
    return rawHandleRequest($server, $body, $token, $transport, [
        'storage_dir' => $testStorage,
        'usage' => ['per_client' => 1000, 'global' => 1000],
        'logger' => static function (array $event): void {},
    ]);
}

// Fixtures exclusivamente técnicas, sem indicadores ou credenciais reais.
function check(bool $condition, string $label): void
{
    if (!$condition) {
        throw new RuntimeException($label);
    }
}

$server = ['REQUEST_METHOD' => 'POST', 'CONTENT_TYPE' => 'application/json; charset=UTF-8'];
$body = '{"tables":[{"name":"teste","rows":[{"codigo":"0001","zero":0,"ausente":null,"nome":"Ação","0":{"vazio":{}}}]}],"prompt":"  Prompt de teste.\n"}';
$calls = 0;
$transport = function ($url, $payload, $timeout) use (&$calls, $body): array {
    $calls++;
    check($url === 'https://bigdata-api.fiocruz.br/text_description/', 'URL do contrato');
    check($timeout === 120, 'Timeout de 120 s');
    $input = json_decode($body);
    $request = json_decode($payload);
    check($request->token->token === 'token-exclusivo-de-teste', 'Token no corpo remoto');
    check(is_string($request->data->data), 'Tabelas serializadas em string');
    check($request->data->context === $input->prompt, 'Prompt sem alteração');
    check(json_encode(json_decode($request->data->data)) === json_encode($input->tables), 'Tipos e valores preservados');
    return ['status' => 200, 'body' => '{"text_description":"  **Resposta**\n<script>não executar</script>  "}'];
};
$token = static fn(): string => 'token-exclusivo-de-teste';
[$status, $result] = handleRequest($server, $body, $token, $transport);
check($status === 200 && str_starts_with($result['text_description'], '  **Resposta**'), 'Resposta intacta');
check(!str_contains(json_encode($result), 'token-exclusivo'), 'Token ausente na resposta');
check($calls === 1, 'Sem repetição automática');

$multiple = json_decode($body);
$multiple->tables[] = (object) ['name' => 'outra', 'rows' => [(object) ['decimal' => 1.25, 'suprimido' => 'suprimido']]];
[$status] = handleRequest($server, json_encode($multiple), $token, static function ($url, $payload): array {
    $request = json_decode($payload);
    check(count(json_decode($request->data->data)) === 2, 'Múltiplas tabelas');
    return ['status' => 200, 'body' => '{"text_description":"ok"}'];
});
check($status === 200, 'Consulta com múltiplas tabelas');

foreach (['', 'null', '[]', '{}', '{', '{"tables":[],"prompt":"teste"}',
    '{"tables":[{"name":"teste","rows":[]}],"prompt":"teste"}',
    '{"tables":[{"name":"teste","rows":[[]]}],"prompt":"teste"}',
    '{"tables":[{"name":"teste","rows":[{}]}],"prompt":"teste"}',
    '{"tables":[{"name":" ","rows":[{"v":1}]}],"prompt":"teste"}',
    '{"tables":[{"name":"teste","rows":[{"v":1}]}],"prompt":"\u00a0"}',
    '{"tables":[{"name":"teste","rows":[{"v":1e999}]}],"prompt":"teste"}',
    '{"tables":[{"name":"teste","rows":[{"v":1}]}],"prompt":"teste","token":"intruso"}',
] as $invalid) {
    [$status, $result] = handleRequest($server, $invalid, static function () { throw new RuntimeException('Não ler token'); }, $transport);
    check($status === 400 && $result['error']['code'] === 'INVALID_INPUT', 'Entrada inválida antes de ler token');
}
check($calls === 1, 'Entradas inválidas não consultam API');

foreach ([
    [['REQUEST_METHOD' => 'GET'], 405, 'METHOD_NOT_ALLOWED'],
    [['REQUEST_METHOD' => 'OPTIONS'], 405, 'METHOD_NOT_ALLOWED'],
    [['REQUEST_METHOD' => 'POST', 'CONTENT_TYPE' => 'text/plain'], 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [$server + ['HTTP_SEC_FETCH_SITE' => 'cross-site'], 403, 'FORBIDDEN'],
    [$server + ['HTTP_SEC_FETCH_SITE' => 'same-site'], 403, 'FORBIDDEN'],
] as [$headers, $expectedStatus, $code]) {
    [$status, $result] = handleRequest($headers, $body, $token, $transport);
    check($status === $expectedStatus && $result['error']['code'] === $code, 'Validação HTTP');
}

foreach ([
    [401, 'segredo', 'AUTHENTICATION_ERROR'], [403, 'segredo', 'AUTHENTICATION_ERROR'],
    [422, 'segredo', 'UPSTREAM_ERROR'], [429, 'segredo', 'UPSTREAM_ERROR'],
    [500, 'segredo', 'UPSTREAM_ERROR'], [302, 'segredo', 'UPSTREAM_ERROR'],
    [200, '<html>segredo</html>', 'INVALID_RESPONSE'], [200, '{}', 'INVALID_RESPONSE'],
    [200, '{"text_description":"\n "}', 'INVALID_RESPONSE'],
    [200, '{"text_description":42}', 'INVALID_RESPONSE'],
] as [$remoteStatus, $remoteBody, $code]) {
    [$status, $result] = handleRequest($server, $body, $token,
        static fn(): array => ['status' => $remoteStatus, 'body' => $remoteBody]);
    check($status === 502 && $result['error']['code'] === $code, 'Erro remoto padronizado');
    check(!str_contains(json_encode($result), 'segredo'), 'Erro remoto sem conteúdo sensível');
}
foreach ([new ApiError('TIMEOUT', 504), new RuntimeException('segredo')] as $exception) {
    [$status, $result] = handleRequest($server, $body, $token, static function () use ($exception): array { throw $exception; });
    check($result['error']['code'] === ($exception instanceof ApiError ? 'TIMEOUT' : 'INTERNAL_ERROR'), 'Exceção sanitizada');
    check(!str_contains(json_encode($result), 'segredo'), 'Exceção sem detalhes');
}

$temporary = tempnam(sys_get_temp_dir(), 'iapcdas-config-');
$previous = getenv('PCDAS_TOKEN');
try {
    file_put_contents($temporary, "<?php return ['token' => 'token-local-de-teste'];");
    putenv('PCDAS_TOKEN=token-ambiente-de-teste');
    check(loadToken($temporary) === 'token-ambiente-de-teste', 'Ambiente tem precedência');
    file_put_contents($temporary, '<?php sintaxe inválida');
    check(loadToken($temporary) === 'token-ambiente-de-teste', 'Ambiente dispensa arquivo');
    file_put_contents($temporary, "<?php return ['token' => 'token-local-de-teste'];");
    putenv('PCDAS_TOKEN');
    check(loadToken($temporary) === 'token-local-de-teste', 'Configuração local');
    unlink($temporary);
    try {
        loadToken($temporary);
        throw new RuntimeException('Deveria falhar sem token');
    } catch (ApiError $error) {
        check($error->errorCode === 'CONFIGURATION_ERROR', 'Ausência de token');
    }
} finally {
    if (is_file($temporary)) unlink($temporary);
    $previous === false ? putenv('PCDAS_TOKEN') : putenv('PCDAS_TOKEN=' . $previous);
}

echo "Testes PHP aprovados: contrato, validação, erros e configuração.\n";

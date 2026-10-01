<?php
declare(strict_types=1);
require dirname(__DIR__) . '/server/ChatPCDAS.php';

use IAPCDAS\ApiError;
use IAPCDAS\UsageLimiter;
use function IAPCDAS\handleRequest;
use function IAPCDAS\normalizeSettings;

function check(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}
function expectCode(callable $call, string $code): ApiError
{
    try {
        $call();
    } catch (ApiError $error) {
        check($error->errorCode === $code, 'Código esperado: ' . $code . ', obtido: ' . $error->errorCode);
        return $error;
    }
    throw new RuntimeException('Faltou erro: ' . $code);
}
$base = sys_get_temp_dir() . '/iapcdas-controls-' . bin2hex(random_bytes(6));
register_shutdown_function(static function () use ($base): void {
    foreach (glob($base . '/*') ?: [] as $directory) {
        if (is_dir($directory)) {
            foreach (glob($directory . '/*') ?: [] as $file) unlink($file);
            rmdir($directory);
        } else unlink($directory);
    }
    if (is_dir($base)) rmdir($base);
});
$events = [];
$options = normalizeSettings([
    'storage_dir' => $base . '/requests',
    'usage' => ['per_client' => 1000, 'global' => 1000],
    'logger' => static function (array $event) use (&$events): void { $events[] = $event; },
]);
$server = ['REQUEST_METHOD' => 'POST', 'CONTENT_TYPE' => 'application/json', 'REMOTE_ADDR' => '192.0.2.1'];
$input = ['tables' => [['name' => 'teste', 'rows' => [['valor' => 0]]]], 'prompt' => 'Prompt confidencial de teste'];
$body = json_encode($input);
$calls = 0;
$transport = static function ($url, $body, $timeout, $maxBytes) use (&$calls): array {
    $calls++;
    check($maxBytes === 1048576, 'Limite da resposta chega ao transporte');
    return ['status' => 200, 'body' => '{"text_description":"ok"}'];
};
$token = static fn(): string => 'token-confidencial-de-teste';

foreach ([
    ['request_bytes', strlen($body) - 1, 'body'],
    ['prompt_bytes', 2, 'prompt'],
    ['tables', 1, 'tables'],
    ['rows', 1, 'tables[0].rows'],
    ['columns', 1, 'tables[0].rows[0]'],
] as [$key, $limit, $field]) {
    $case = $input;
    if ($key === 'tables') $case['tables'][] = $case['tables'][0];
    if ($key === 'rows') $case['tables'][0]['rows'][] = ['valor' => 1];
    if ($key === 'columns') $case['tables'][0]['rows'][0]['outra'] = null;
    $config = $options;
    $config['limits'][$key] = $limit;
    [$status, $result] = handleRequest($server, json_encode($case), $token, $transport, $config);
    check($status === 413 && $result['error']['code'] === 'PAYLOAD_TOO_LARGE', 'Limite ' . $key);
    check($result['error']['field'] === $field, 'Campo do limite ' . $key);
}
check($calls === 0, 'Limites não chamam a API');
[$status] = handleRequest($server, 'strlen', $token, $transport, $options);
check($status === 400, 'Corpo em texto nunca é interpretado como função PHP');

$bounded = $options;
$bounded['limits']['request_bytes'] = strlen($body);
[$status] = handleRequest($server, $body, $token, $transport, $bounded);
check($status === 200 && $calls === 1, 'Limite exato é aceito');

$denied = $options;
$denied['authorize'] = static fn(array $server): bool => false;
[$status] = handleRequest($server, static function () { throw new RuntimeException('Não ler corpo'); },
    static function () { throw new RuntimeException('Não ler token'); }, $transport, $denied);
check($status === 403 && $calls === 1, 'Autorização precede leitura e chamada remota');

$oversize = $server + ['CONTENT_LENGTH' => '99999999'];
[$status] = handleRequest($oversize, static function () { throw new RuntimeException('Não ler corpo'); }, $token, $transport, $options);
check($status === 413, 'Content-Length excessivo rejeitado antes da leitura');
[$status, $result] = handleRequest($server, '{"tables":[{"name":"t","rows":[{"valor":1e999}]}],"prompt":"p"}', $token, $transport, $options);
check($status === 400 && $result['error']['field'] === 'tables[0].rows[0].valor', 'Caminho detalhado');

$unicode = str_repeat('á', 300);
[$status, $result] = handleRequest($server, '{"tables":[{"name":"t","rows":[{"' . $unicode . '":1e999}]}],"prompt":"p"}', $token, $transport, $options);
check($status === 400 && json_encode($result, JSON_THROW_ON_ERROR) !== '', 'Caminho longo preserva UTF-8');

$limitedResponse = $options;
$limitedResponse['limits']['response_bytes'] = 8;
[$status, $result] = handleRequest($server, $body, $token,
    static fn(): array => ['status' => 200, 'body' => str_repeat('x', 9)], $limitedResponse);
check($status === 502 && $result['error']['code'] === 'RESPONSE_TOO_LARGE', 'Resposta excessiva');

foreach ([new ApiError('TIMEOUT', 504), new RuntimeException('token-confidencial-de-teste')] as $exception) {
    [$status, $result, $headers] = handleRequest($server, $body, $token,
        static function () use ($exception): array { throw $exception; }, $options);
    check($headers['X-Request-ID'] === $result['error']['request_id'], 'ID de erro e cabeçalho coincidem');
    $slot = (new UsageLimiter($options))->acquire('outro');
    UsageLimiter::release($slot);
}
foreach ($events as $event) {
    check(array_keys($event) === ['event', 'request_id', 'duration_ms', 'status', 'code'], 'Log só contém campos permitidos');
    check(preg_match('/^[a-f0-9]{32}$/', $event['request_id']) === 1, 'ID aleatório');
    check($event['duration_ms'] >= 0, 'Duração válida');
}
check(!str_contains(json_encode($events), 'confidencial'), 'Logs sem prompt ou token');
check(!str_contains(json_encode($events), '192.0.2.1'), 'Logs sem IP');

$rate = normalizeSettings(['storage_dir' => $base . '/rate',
    'usage' => ['window_seconds' => 60, 'per_client' => 2, 'global' => 3, 'concurrent' => 2]]);
$limiter = new UsageLimiter($rate);
UsageLimiter::release($limiter->acquire('A', 100));
UsageLimiter::release($limiter->acquire('A', 101));
$error = expectCode(static fn() => $limiter->acquire('A', 102), 'RATE_LIMITED');
check($error->retryAfter === 58, 'Retry-After da janela móvel');
UsageLimiter::release($limiter->acquire('B', 102));
expectCode(static fn() => $limiter->acquire('C', 103), 'RATE_LIMITED');
UsageLimiter::release($limiter->acquire('A', 162));
check(count(json_decode(file_get_contents($base . '/rate/usage.json'), true)) === 1, 'Contadores expirados removidos');

$concurrent = normalizeSettings(['storage_dir' => $base . '/concurrent', 'usage' => ['concurrent' => 1]]);
$limiter = new UsageLimiter($concurrent);
$first = $limiter->acquire('A', 100);
expectCode(static fn() => $limiter->acquire('B', 100), 'SERVER_BUSY');
UsageLimiter::release($first);
UsageLimiter::release($limiter->acquire('B', 101));
check(count(json_decode(file_get_contents($base . '/concurrent/usage.json'), true)) === 2, 'Recusa por concorrência não consome cota');

file_put_contents($base . '/concurrent/usage.json', '{arquivo corrompido');
expectCode(static fn() => $limiter->acquire('C', 102), 'STORAGE_ERROR');
file_put_contents($base . '/concurrent/usage.json', '{}');
expectCode(static fn() => $limiter->acquire('C', 102), 'STORAGE_ERROR');

foreach ([['limits' => null], ['usage' => ['per_client' => 0]], ['authorize' => 'inexistente'],
    ['storage_dir' => 'https://invalido'], ['desconhecido' => 1]] as $invalid) {
    expectCode(static fn() => normalizeSettings($invalid), 'CONFIGURATION_ERROR');
}
echo "Controles aprovados: limites, autorização, logs, cotas, concorrência e expiração.\n";

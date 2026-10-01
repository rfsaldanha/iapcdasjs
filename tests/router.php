<?php
declare(strict_types=1);

// Somente para o servidor de testes: nunca copiar esta pasta para produção.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/__browser') {
    header('Content-Type: text/html; charset=UTF-8');
    echo '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Teste IAPCDAS</title><body><pre id="resposta"></pre></body></html>';
    return true;
}
if ($path === '/proadess.js') {
    header('Content-Type: application/javascript; charset=UTF-8');
    readfile(dirname(__DIR__) . '/examples/proadess.js');
    return true;
}
if ($path !== '/api/chatpcdas.php') {
    return false;
}
require dirname(__DIR__) . '/server/ChatPCDAS.php';
$settings = json_decode(getenv('IAPCDAS_TEST_SETTINGS'), true, 32, JSON_THROW_ON_ERROR);
$settings['authorize'] = static fn(array $server): bool => getenv('IAPCDAS_TEST_AUTHORIZE') !== 'deny';
\IAPCDAS\serve(static function (string $url, string $body, int $timeout, int $maxBytes): array {
    if ($url !== \IAPCDAS\API_URL || $timeout !== 120) {
        throw new RuntimeException('Contrato inesperado');
    }
    $mock = getenv('IAPCDAS_TEST_UPSTREAM');
    // Falha fechada: este teste nunca pode alcançar a API real.
    if (!is_string($mock) || !preg_match('#^http://127\.0\.0\.1:\d+/text_description/$#', $mock)) {
        throw new RuntimeException('Serviço simulado local obrigatório');
    }
    return \IAPCDAS\curlTransport($mock, $body, (int) getenv('IAPCDAS_TEST_TIMEOUT'), $maxBytes);
}, $settings);
return true;

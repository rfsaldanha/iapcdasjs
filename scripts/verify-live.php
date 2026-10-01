<?php
declare(strict_types=1);

// Execução manual explícita. Este comando não faz parte de npm test nem da CI.
require dirname(__DIR__) . '/server/ChatPCDAS.php';

if (PHP_SAPI !== 'cli' || count($argv) !== 3 || $argv[1] !== '--confirm') {
    fwrite(STDERR, "Uso: php scripts/verify-live.php --confirm /caminho/consulta.json\n");
    fwrite(STDERR, "Envia uma consulta real ao ChatPCDAS usando o token configurado. O JSON deve conter tables e prompt reais.\n");
    exit(2);
}
try {
    $config = \IAPCDAS\readLocalConfig(dirname(__DIR__) . '/config/local.php');
    $settings = \IAPCDAS\normalizeSettings($config);
    $token = \IAPCDAS\tokenFromConfig($config);
    $stream = @fopen($argv[2], 'rb');
    if ($stream === false) throw new RuntimeException('Não foi possível abrir o arquivo de consulta.');
    try {
        $raw = stream_get_contents($stream, $settings['limits']['request_bytes'] + 1);
    } finally {
        fclose($stream);
    }
    if ($raw === false) throw new RuntimeException('Não foi possível ler o arquivo de consulta.');
    \IAPCDAS\parseRequest($raw, $settings['limits']);
    // A ferramenta CLI é administrativa; a autorização HTTP do site não se aplica.
    $settings['authorize'] = null;
    [$status, $body, $headers] = \IAPCDAS\handleRequest(
        ['REQUEST_METHOD' => 'POST', 'CONTENT_TYPE' => 'application/json', 'REMOTE_ADDR' => 'manual-cli'],
        $raw,
        static fn(): string => $token,
        null,
        $settings
    );
    echo json_encode(['status' => $status, 'request_id' => $headers['X-Request-ID'], 'result' => $body],
        \IAPCDAS\JSON_FLAGS | JSON_PRETTY_PRINT) . "\n";
    exit($status === 200 ? 0 : 1);
} catch (Throwable $error) {
    $code = $error instanceof \IAPCDAS\ApiError ? $error->errorCode : 'VERIFICATION_ERROR';
    fwrite(STDERR, "Verificação não executada: " . $code . ". Confira o token, a configuração e o arquivo de entrada.\n");
    exit(1);
}

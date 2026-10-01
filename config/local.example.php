<?php
declare(strict_types=1);

// Copie como config/local.php, sempre fora da pasta pública.
// PCDAS_TOKEN não vazio tem precedência sobre o token deste arquivo.
return [
    'token' => '',
    'limits' => [
        'request_bytes' => 2 * 1024 * 1024,
        'response_bytes' => 1024 * 1024,
        'prompt_bytes' => 20000,
        'tables' => 10,
        'rows' => 20000, // Total de linhas somando todas as tabelas.
        'columns' => 100, // Máximo de colunas por linha.
    ],
    'usage' => [
        'window_seconds' => 60,
        'per_client' => 10, // Por REMOTE_ADDR na janela móvel.
        'global' => 60, // Todas as origens na mesma instalação.
        'concurrent' => 4,
    ],
    'storage_dir' => dirname(__DIR__) . '/var', // Diretório privado e gravável pelo PHP.
    // Opcional: callable(array $server): bool que consulta a autorização do próprio site.
    'authorize' => null,
    // Opcional: callable(array $event): void. O padrão escreve JSON em error_log.
    'logger' => null,
];

<?php
declare(strict_types=1);

namespace IAPCDAS;

use JsonException;
use RuntimeException;
use stdClass;
use Throwable;

const API_URL = 'https://bigdata-api.fiocruz.br/text_description/';
const API_TIMEOUT_SECONDS = 120;
const JSON_FLAGS = JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION;

require_once __DIR__ . '/Controls.php';

final class ApiError extends RuntimeException
{
    public string $errorCode;
    public int $httpStatus;
    public ?string $field;
    public ?int $retryAfter;

    public function __construct(string $code, int $status, ?string $field = null, ?int $retryAfter = null)
    {
        $messages = [
            'INVALID_INPUT' => 'Informe um prompt e pelo menos uma tabela válida.',
            'PAYLOAD_TOO_LARGE' => 'Os dados excedem os limites configurados para a consulta.',
            'RESPONSE_TOO_LARGE' => 'A resposta do serviço excedeu o limite configurado.',
            'RATE_LIMITED' => 'O limite de consultas foi atingido. Aguarde antes de tentar novamente.',
            'SERVER_BUSY' => 'O limite de consultas simultâneas foi atingido. Tente novamente em instantes.',
            'STORAGE_ERROR' => 'O controle de uso está indisponível.',
            'INTERNAL_ERROR' => 'Não foi possível processar a consulta.',
            'CONFIGURATION_ERROR' => 'A integração com o ChatPCDAS não está configurada.',
            'METHOD_NOT_ALLOWED' => 'Use POST para consultar o ChatPCDAS.',
            'UNSUPPORTED_MEDIA_TYPE' => 'Envie os dados como JSON em UTF-8.',
            'FORBIDDEN' => 'A consulta não foi autorizada.',
            'AUTHENTICATION_ERROR' => 'O ChatPCDAS recusou o token configurado no servidor.',
            'UPSTREAM_ERROR' => 'Não foi possível consultar o ChatPCDAS. Tente novamente mais tarde.',
            'INVALID_RESPONSE' => 'O serviço retornou uma resposta inválida.',
            'TIMEOUT' => 'O tempo de espera pela resposta foi excedido.',
        ];
        $this->field = null;
        if ($field !== null && preg_match('/\A.{0,256}/us', $field, $match)) $this->field = $match[0];
        parent::__construct($messages[$code]);
        $this->errorCode = $code;
        $this->httpStatus = $status;
        $this->retryAfter = $retryAfter;
    }
}

function nonBlank(mixed $value): bool
{
    return is_string($value) && preg_match('/[^\s\p{Z}\x{FEFF}]/u', $value) === 1;
}

function tokenFromConfig(array $config): string
{
    $environment = getenv('PCDAS_TOKEN');
    $token = $environment !== false && $environment !== '' ? $environment : ($config['token'] ?? null);
    if (!nonBlank($token)) throw new ApiError('CONFIGURATION_ERROR', 500);
    return $token;
}

/** Mantém a precedência e a leitura opcional da configuração de token. */
function loadToken(string $configPath): string
{
    $environment = getenv('PCDAS_TOKEN');
    return tokenFromConfig($environment !== false && $environment !== '' ? [] : readLocalConfig($configPath));
}

function fieldPath(string $parent, string $key): string
{
    return preg_match('/^[A-Za-z_$][A-Za-z0-9_$]*$/', $key)
        ? $parent . '.' . $key
        : $parent . '[' . json_encode($key, JSON_FLAGS) . ']';
}

function validateJson(mixed $value, string $path = 'tables', int $depth = 0): void
{
    if ($depth > 64 || (is_float($value) && !is_finite($value))) {
        throw new ApiError('INVALID_INPUT', 400, $path);
    }
    if (is_array($value) || $value instanceof stdClass) {
        foreach ($value as $key => $child) {
            validateJson($child, is_array($value) ? $path . '[' . $key . ']' : fieldPath($path, (string) $key), $depth + 1);
        }
    }
}

function parseRequest(string $rawBody, ?array $limits = null): stdClass
{
    $limits = $limits ?? defaultSettings()['limits'];
    if (strlen($rawBody) > $limits['request_bytes']) throw new ApiError('PAYLOAD_TOO_LARGE', 413, 'body');
    try {
        $input = json_decode($rawBody, false, 128, JSON_THROW_ON_ERROR);
    } catch (JsonException $error) {
        throw new ApiError('INVALID_INPUT', 400, 'body');
    }
    if (!$input instanceof stdClass || count(get_object_vars($input)) !== 2) {
        throw new ApiError('INVALID_INPUT', 400, 'body');
    }
    if (!nonBlank($input->prompt ?? null)) throw new ApiError('INVALID_INPUT', 400, 'prompt');
    if (strlen($input->prompt) > $limits['prompt_bytes']) throw new ApiError('PAYLOAD_TOO_LARGE', 413, 'prompt');
    if (!isset($input->tables) || !is_array($input->tables) || count($input->tables) === 0) {
        throw new ApiError('INVALID_INPUT', 400, 'tables');
    }
    if (count($input->tables) > $limits['tables']) throw new ApiError('PAYLOAD_TOO_LARGE', 413, 'tables');
    validateJson($input->tables);
    $rows = 0;
    foreach ($input->tables as $index => $table) {
        $path = 'tables[' . $index . ']';
        if (!$table instanceof stdClass || count(get_object_vars($table)) !== 2) {
            throw new ApiError('INVALID_INPUT', 400, $path);
        }
        if (!nonBlank($table->name ?? null)) throw new ApiError('INVALID_INPUT', 400, $path . '.name');
        if (!isset($table->rows) || !is_array($table->rows) || count($table->rows) === 0) {
            throw new ApiError('INVALID_INPUT', 400, $path . '.rows');
        }
        $rows += count($table->rows);
        if ($rows > $limits['rows']) throw new ApiError('PAYLOAD_TOO_LARGE', 413, $path . '.rows');
        foreach ($table->rows as $rowIndex => $row) {
            $rowPath = $path . '.rows[' . $rowIndex . ']';
            if (!$row instanceof stdClass || count(get_object_vars($row)) === 0) {
                throw new ApiError('INVALID_INPUT', 400, $rowPath);
            }
            if (count(get_object_vars($row)) > $limits['columns']) throw new ApiError('PAYLOAD_TOO_LARGE', 413, $rowPath);
        }
    }
    return $input;
}

/** O callback de escrita interrompe a transferência antes de acumular uma resposta excessiva. */
function curlTransport(string $url, string $body, int $timeout, int $maxResponseBytes = 1048576): array
{
    if (!extension_loaded('curl')) throw new ApiError('CONFIGURATION_ERROR', 500);
    $handle = curl_init($url);
    if ($handle === false) throw new ApiError('UPSTREAM_ERROR', 502);
    $response = '';
    $oversize = false;
    try {
        curl_setopt_array($handle, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json; charset=UTF-8', 'Accept: application/json'],
            CURLOPT_CONNECTTIMEOUT => min(10, $timeout),
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$response, &$oversize, $maxResponseBytes): int {
                if (strlen($response) + strlen($chunk) > $maxResponseBytes) {
                    $oversize = true;
                    return 0;
                }
                $response .= $chunk;
                return strlen($chunk);
            },
        ]);
        $ok = curl_exec($handle);
        if ($oversize) throw new ApiError('RESPONSE_TOO_LARGE', 502);
        if ($ok === false) {
            $timedOut = curl_errno($handle) === CURLE_OPERATION_TIMEDOUT;
            throw new ApiError($timedOut ? 'TIMEOUT' : 'UPSTREAM_ERROR', $timedOut ? 504 : 502);
        }
        return ['status' => (int) curl_getinfo($handle, CURLINFO_HTTP_CODE), 'body' => $response];
    } finally {
        curl_close($handle);
    }
}

function describe(stdClass $input, string $token, ?callable $transport = null, int $maxResponseBytes = 1048576): string
{
    ini_set('serialize_precision', '-1');
    $body = json_encode([
        'token' => ['token' => $token],
        'data' => ['data' => json_encode($input->tables, JSON_FLAGS, 128), 'context' => $input->prompt],
    ], JSON_FLAGS, 128);
    $transport = $transport ?? __NAMESPACE__ . '\\curlTransport';
    $response = $transport(API_URL, $body, API_TIMEOUT_SECONDS, $maxResponseBytes);
    $status = $response['status'];
    if ($status === 401 || $status === 403) throw new ApiError('AUTHENTICATION_ERROR', 502);
    if ($status < 200 || $status >= 300) throw new ApiError('UPSTREAM_ERROR', 502);
    if (strlen($response['body']) > $maxResponseBytes) throw new ApiError('RESPONSE_TOO_LARGE', 502);
    try {
        $result = json_decode($response['body'], false, 128, JSON_THROW_ON_ERROR);
    } catch (JsonException $error) {
        throw new ApiError('INVALID_RESPONSE', 502);
    }
    if (!$result instanceof stdClass || !nonBlank($result->text_description ?? null)) {
        throw new ApiError('INVALID_RESPONSE', 502);
    }
    return $result->text_description;
}

function audit(array $event, ?callable $logger): void
{
    // O evento contém apenas campos fixos; nunca dados, prompt, token, IP ou exceções brutas.
    try {
        if ($logger !== null) $logger($event);
        else error_log(json_encode($event, JSON_FLAGS));
    } catch (Throwable $error) {
        error_log('IAPCDAS: falha no destino de logs.');
    }
}

/**
 * $rawBody pode ser uma string (testes) ou um leitor limitado (endpoint HTTP).
 * O terceiro item retornado contém cabeçalhos de diagnóstico e Retry-After.
 */
function handleRequest(array $server, mixed $rawBody, callable $tokenProvider, ?callable $transport = null, array $settings = []): array
{
    $start = microtime(true);
    $requestId = bin2hex(random_bytes(16));
    $status = 500;
    $code = 'INTERNAL_ERROR';
    $logger = null;
    $slot = null;
    $headers = ['X-Request-ID' => $requestId];
    try {
        $settings = normalizeSettings($settings);
        $logger = $settings['logger'];
        if (($server['REQUEST_METHOD'] ?? '') !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', 405);
        $site = $server['HTTP_SEC_FETCH_SITE'] ?? 'same-origin';
        if ($site !== 'same-origin' && $site !== 'none') throw new ApiError('FORBIDDEN', 403);
        $contentType = strtolower(trim(explode(';', $server['CONTENT_TYPE'] ?? '')[0]));
        if ($contentType !== 'application/json') throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 415);
        if ($settings['authorize'] !== null && ($settings['authorize'])($server) !== true) {
            throw new ApiError('FORBIDDEN', 403);
        }
        if (isset($server['CONTENT_LENGTH']) && (float) $server['CONTENT_LENGTH'] > $settings['limits']['request_bytes']) {
            throw new ApiError('PAYLOAD_TOO_LARGE', 413, 'body');
        }
        if (!is_string($rawBody)) {
            if (!is_callable($rawBody)) throw new ApiError('INVALID_INPUT', 400, 'body');
            $rawBody = $rawBody($settings['limits']['request_bytes']);
            if (!is_string($rawBody)) throw new ApiError('INTERNAL_ERROR', 500);
        }
        $input = parseRequest($rawBody, $settings['limits']);
        $token = $tokenProvider();
        if (!nonBlank($token)) throw new ApiError('CONFIGURATION_ERROR', 500);
        // REMOTE_ADDR deve ser normalizado pelo proxy confiável, não por cabeçalhos arbitrários.
        $slot = (new UsageLimiter($settings))->acquire($server['REMOTE_ADDR'] ?? 'unknown');
        $answer = describe($input, $token, $transport, $settings['limits']['response_bytes']);
        $status = 200;
        $code = 'OK';
        return [$status, ['text_description' => $answer], $headers];
    } catch (Throwable $error) {
        if (!$error instanceof ApiError) $error = new ApiError('INTERNAL_ERROR', 500);
        $status = $error->httpStatus;
        $code = $error->errorCode;
        $details = ['code' => $code, 'message' => $error->getMessage(), 'request_id' => $requestId];
        if ($error->field !== null) $details['field'] = $error->field;
        if ($error->retryAfter !== null) $headers['Retry-After'] = (string) $error->retryAfter;
        if ($status === 405) $headers['Allow'] = 'POST';
        return [$status, ['error' => $details], $headers];
    } finally {
        UsageLimiter::release($slot);
        audit([
            'event' => 'iapcdas.request',
            'request_id' => $requestId,
            'duration_ms' => (int) round((microtime(true) - $start) * 1000),
            'status' => $status,
            'code' => $code,
        ], $logger);
    }
}

function serve(?callable $transport = null, ?array $settingsOverride = null): void
{
    ini_set('display_errors', '0');
    @set_time_limit(130);
    try {
        $config = $settingsOverride ?? readLocalConfig(dirname(__DIR__) . '/config/local.php');
    } catch (ApiError $error) {
        // Encaminha a falha pelo mesmo caminho de logs e respostas sanitizadas.
        $config = ['invalid_configuration' => true];
    }
    [$status, $body, $headers] = handleRequest(
        $_SERVER,
        static function (int $maxBytes): string {
            $stream = fopen('php://input', 'rb');
            if ($stream === false) throw new ApiError('INTERNAL_ERROR', 500);
            try {
                $body = stream_get_contents($stream, $maxBytes + 1);
                if ($body === false) throw new ApiError('INTERNAL_ERROR', 500);
                return $body;
            } finally {
                fclose($stream);
            }
        },
        static fn(): string => tokenFromConfig($config),
        $transport,
        $config
    );
    http_response_code($status);
    header('Content-Type: application/json; charset=UTF-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    foreach ($headers as $name => $value) header($name . ': ' . $value);
    echo json_encode($body, JSON_FLAGS);
}

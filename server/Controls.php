<?php
declare(strict_types=1);

namespace IAPCDAS;

use Throwable;

function defaultSettings(): array
{
    return [
        'limits' => [
            'request_bytes' => 2 * 1024 * 1024,
            'response_bytes' => 1024 * 1024,
            'prompt_bytes' => 20000,
            'tables' => 10,
            'rows' => 20000,
            'columns' => 100,
        ],
        'usage' => ['window_seconds' => 60, 'per_client' => 10, 'global' => 60, 'concurrent' => 4],
        'storage_dir' => dirname(__DIR__) . '/var',
        'authorize' => null,
        'logger' => null,
    ];
}

function normalizeSettings(array $settings): array
{
    $defaults = defaultSettings();
    unset($settings['token']);
    foreach ($settings as $key => $value) {
        if (!array_key_exists($key, $defaults)) throw new ApiError('CONFIGURATION_ERROR', 500);
    }
    foreach (['limits', 'usage'] as $group) {
        if (array_key_exists($group, $settings) && !is_array($settings[$group])) {
            throw new ApiError('CONFIGURATION_ERROR', 500);
        }
        foreach ($settings[$group] ?? [] as $key => $value) {
            if (!array_key_exists($key, $defaults[$group]) || !is_int($value) || $value <= 0 ||
                $value > ($group === 'usage' ? 10000 : 100 * 1024 * 1024)) {
                throw new ApiError('CONFIGURATION_ERROR', 500);
            }
        }
    }
    $settings = array_replace_recursive($defaults, $settings);
    if (!is_string($settings['storage_dir']) || trim($settings['storage_dir']) === '' ||
        str_contains($settings['storage_dir'], '://')) {
        throw new ApiError('CONFIGURATION_ERROR', 500);
    }
    foreach (['authorize', 'logger'] as $callback) {
        if ($settings[$callback] !== null && !is_callable($settings[$callback])) {
            throw new ApiError('CONFIGURATION_ERROR', 500);
        }
    }
    return $settings;
}

function readLocalConfig(string $path): array
{
    if (!is_file($path)) return [];
    // Uma configuração não deve escrever conteúdo na resposta HTTP.
    $level = ob_get_level();
    ob_start();
    try {
        $config = require $path;
        if (!is_array($config)) throw new ApiError('CONFIGURATION_ERROR', 500);
        return $config;
    } catch (Throwable $error) {
        throw new ApiError('CONFIGURATION_ERROR', 500);
    } finally {
        while (ob_get_level() > $level) ob_end_clean();
    }
}

/**
 * Cotas compartilhadas entre workers no mesmo servidor.
 * O lock do slot é liberado inclusive quando o processo PHP termina.
 */
final class UsageLimiter
{
    private array $settings;

    public function __construct(array $settings)
    {
        $this->settings = $settings;
    }

    /** @return resource Slot que o chamador deve liberar em finally. */
    public function acquire(string $client, ?float $now = null)
    {
        $now = $now ?? microtime(true);
        $directory = $this->settings['storage_dir'];
        $usage = $this->settings['usage'];
        if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new ApiError('STORAGE_ERROR', 503);
        }
        $lock = @fopen($directory . '/usage.lock', 'c');
        if ($lock === false) throw new ApiError('STORAGE_ERROR', 503);
        @chmod($directory . '/usage.lock', 0600);
        if (!flock($lock, LOCK_EX | LOCK_NB)) {
            fclose($lock);
            throw new ApiError('SERVER_BUSY', 429, null, 1);
        }
        $slot = null;
        $temporary = null;
        try {
            $path = $directory . '/usage.json';
            $events = [];
            if (is_file($path)) {
                $raw = @file_get_contents($path, false, null, 0, 4 * 1024 * 1024 + 1);
                if ($raw === false || strlen($raw) > 4 * 1024 * 1024) throw new ApiError('STORAGE_ERROR', 503);
                $decoded = json_decode($raw, false, 16, JSON_THROW_ON_ERROR);
                if (!is_array($decoded)) throw new ApiError('STORAGE_ERROR', 503);
                foreach ($decoded as $event) {
                    if (!$event instanceof \stdClass || count(get_object_vars($event)) !== 2 ||
                        !isset($event->at, $event->client) || (!is_int($event->at) && !is_float($event->at)) ||
                        !is_finite((float) $event->at) || !is_string($event->client) ||
                        !preg_match('/^[a-f0-9]{64}$/', $event->client)) {
                        throw new ApiError('STORAGE_ERROR', 503);
                    }
                    if ($event->at > $now - $usage['window_seconds']) {
                        $events[] = ['at' => $event->at, 'client' => $event->client];
                    }
                }
            }
            $key = hash('sha256', $client);
            $own = array_values(array_filter($events, static fn(array $event): bool => $event['client'] === $key));
            foreach ([[$events, $usage['global']], [$own, $usage['per_client']]] as [$list, $limit]) {
                if (count($list) >= $limit) {
                    $retry = max(1, (int) ceil($list[0]['at'] + $usage['window_seconds'] - $now));
                    throw new ApiError('RATE_LIMITED', 429, null, $retry);
                }
            }
            for ($index = 0; $index < $usage['concurrent']; $index++) {
                $candidate = @fopen($directory . '/slot-' . $index . '.lock', 'c');
                if ($candidate === false) throw new ApiError('STORAGE_ERROR', 503);
                @chmod($directory . '/slot-' . $index . '.lock', 0600);
                if (flock($candidate, LOCK_EX | LOCK_NB)) {
                    $slot = $candidate;
                    break;
                }
                fclose($candidate);
            }
            if ($slot === null) throw new ApiError('SERVER_BUSY', 429, null, 1);
            $events[] = ['at' => $now, 'client' => $key];
            $encoded = json_encode($events, JSON_THROW_ON_ERROR);
            $temporary = @tempnam($directory, 'usage-');
            if ($temporary === false ||
                @file_put_contents($temporary, $encoded) !== strlen($encoded) ||
                !@rename($temporary, $path)) {
                throw new ApiError('STORAGE_ERROR', 503);
            }
            $temporary = null;
            $acquired = $slot;
            $slot = null;
            return $acquired;
        } catch (Throwable $error) {
            if ($error instanceof ApiError) throw $error;
            throw new ApiError('STORAGE_ERROR', 503);
        } finally {
            if (is_resource($slot)) self::release($slot);
            if (is_string($temporary)) @unlink($temporary);
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    public static function release($slot): void
    {
        if (is_resource($slot)) {
            flock($slot, LOCK_UN);
            fclose($slot);
        }
    }
}

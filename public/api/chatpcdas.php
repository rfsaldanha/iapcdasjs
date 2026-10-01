<?php
declare(strict_types=1);

ini_set('display_errors', '0');
require dirname(__DIR__, 2) . '/server/ChatPCDAS.php';

\IAPCDAS\serve();

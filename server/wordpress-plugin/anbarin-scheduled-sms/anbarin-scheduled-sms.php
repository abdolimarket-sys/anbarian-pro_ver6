<?php
/**
 * Plugin Name: Anbarin Scheduled SMS Queue
 * Description: صف‌بندی امن پیامک‌های زمان‌بندی‌شده انبارین با WP-Cron و سرویس‌دهنده‌های پیامک ایران.
 * Version: 1.0.0
 * Requires PHP: 7.4
 */
if (!defined('ABSPATH')) { exit; }

final class Anbarin_Scheduled_SMS_Queue {
    const TABLE_SUFFIX = 'anbarin_sms_queue';
    const HOOK = 'anbarin_send_scheduled_sms';

    public static function boot() {
        add_action('rest_api_init', [__CLASS__, 'routes']);
        add_action(self::HOOK, [__CLASS__, 'send_queued'], 10, 1);
        add_filter('rest_pre_serve_request', [__CLASS__, 'cors'], 10, 4);
    }

    public static function activate() {
        global $wpdb;
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        $table = $wpdb->prefix . self::TABLE_SUFFIX;
        $charset = $wpdb->get_charset_collate();
        $sql = "CREATE TABLE {$table} (
            id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
            provider varchar(24) NOT NULL,
            phone varchar(16) NOT NULL,
            message text NOT NULL,
            scheduled_at datetime NOT NULL,
            status varchar(16) NOT NULL DEFAULT 'pending',
            provider_result text NULL,
            created_at datetime NOT NULL,
            sent_at datetime NULL,
            idempotency_key varchar(64) NOT NULL,
            PRIMARY KEY  (id),
            UNIQUE KEY idempotency_key (idempotency_key),
            KEY status_scheduled (status, scheduled_at)
        ) {$charset};";
        dbDelta($sql);
    }

    public static function routes() {
        register_rest_route('anbarin/v1', '/sms/schedule', [
            'methods' => 'POST',
            'callback' => [__CLASS__, 'schedule'],
            'permission_callback' => [__CLASS__, 'authorize'],
        ]);
    }

    public static function authorize($request) {
        $expected = defined('ANBARIN_SMS_SCHEDULER_TOKEN') ? (string) ANBARIN_SMS_SCHEDULER_TOKEN : '';
        $header = (string) $request->get_header('authorization');
        $provided = preg_match('/^Bearer\s+(.+)$/i', $header, $m) ? trim($m[1]) : '';
        if ($expected === '' || $provided === '' || !hash_equals($expected, $provided)) {
            return new WP_Error('anbarin_sms_forbidden', 'توکن API زمان‌بندی معتبر نیست.', ['status' => 401]);
        }
        return true;
    }

    public static function schedule($request) {
        global $wpdb;
        $data = $request->get_json_params();
        $provider = isset($data['provider']) ? sanitize_key($data['provider']) : '';
        $phone = isset($data['phone']) ? preg_replace('/\D+/', '', (string) $data['phone']) : '';
        $message = isset($data['message']) ? sanitize_textarea_field((string) $data['message']) : '';
        $when = isset($data['scheduledAt']) ? strtotime((string) $data['scheduledAt']) : false;
        $idempotency = isset($data['idempotencyKey']) ? sanitize_text_field((string) $data['idempotencyKey']) : '';
        if (!in_array($provider, ['kavenegar', 'faraz', 'melipayamak'], true)) {
            return new WP_REST_Response(['ok' => false, 'message' => 'سرویس‌دهنده انتخابی در صف زمان‌بندی پشتیبانی نمی‌شود.'], 400);
        }
        if (!preg_match('/^09\d{9}$/', $phone) || $message === '' || (function_exists('mb_strlen') ? mb_strlen($message) : strlen($message)) > 900) {
            return new WP_REST_Response(['ok' => false, 'message' => 'شماره موبایل یا متن پیام معتبر نیست.'], 400);
        }
        if (!$when || $when < time() + 60 || !preg_match('/^[a-f0-9]{8,64}$/i', $idempotency)) {
            return new WP_REST_Response(['ok' => false, 'message' => 'زمان ارسال یا کلید جلوگیری از تکرار معتبر نیست.'], 400);
        }
        if (!self::provider_ready($provider)) {
            return new WP_REST_Response(['ok' => false, 'message' => 'کلیدها و تنظیمات سرویس‌دهنده در wp-config.php کامل نیست.'], 400);
        }
        $table = $wpdb->prefix . self::TABLE_SUFFIX;
        $existing_id = $wpdb->get_var($wpdb->prepare("SELECT id FROM {$table} WHERE idempotency_key = %s", $idempotency));
        if ($existing_id) return new WP_REST_Response(['ok' => true, 'id' => (string) $existing_id, 'duplicate' => true], 200);
        $ok = $wpdb->insert($table, [
            'provider' => $provider,
            'phone' => $phone,
            'message' => $message,
            'scheduled_at' => gmdate('Y-m-d H:i:s', $when),
            'status' => 'pending',
            'created_at' => gmdate('Y-m-d H:i:s'),
            'idempotency_key' => $idempotency,
        ], ['%s', '%s', '%s', '%s', '%s', '%s', '%s']);
        if (!$ok) {
            $existing_id = $wpdb->get_var($wpdb->prepare("SELECT id FROM {$table} WHERE idempotency_key = %s", $idempotency));
            if ($existing_id) return new WP_REST_Response(['ok' => true, 'id' => (string) $existing_id, 'duplicate' => true], 200);
            return new WP_REST_Response(['ok' => false, 'message' => 'ذخیره پیام در صف انجام نشد.'], 500);
        }
        $id = (int) $wpdb->insert_id;
        if (!wp_schedule_single_event($when, self::HOOK, [$id])) {
            $wpdb->update($table, ['status' => 'failed', 'provider_result' => 'ثبت رویداد Cron ناموفق بود.'], ['id' => $id], ['%s', '%s'], ['%d']);
            return new WP_REST_Response(['ok' => false, 'message' => 'ثبت زمان اجرای پیامک در Cron ناموفق بود.'], 500);
        }
        return new WP_REST_Response(['ok' => true, 'id' => (string) $id], 201);
    }

    private static function provider_ready($provider) {
        if ($provider === 'kavenegar') return defined('ANBARIN_KAVENEGAR_API_KEY') && ANBARIN_KAVENEGAR_API_KEY !== '';
        if ($provider === 'faraz') return defined('ANBARIN_FARAZ_ACCESS_KEY') && ANBARIN_FARAZ_ACCESS_KEY !== '' && defined('ANBARIN_FARAZ_SENDER') && ANBARIN_FARAZ_SENDER !== '';
        if ($provider === 'melipayamak') return defined('ANBARIN_MELIPAYAMAK_USERNAME') && ANBARIN_MELIPAYAMAK_USERNAME !== '' && defined('ANBARIN_MELIPAYAMAK_PASSWORD') && ANBARIN_MELIPAYAMAK_PASSWORD !== '' && defined('ANBARIN_MELIPAYAMAK_SENDER') && ANBARIN_MELIPAYAMAK_SENDER !== '';
        return false;
    }

    public static function send_queued($id) {
        global $wpdb;
        $table = $wpdb->prefix . self::TABLE_SUFFIX;
        $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$table} WHERE id = %d", (int) $id));
        if (!$row || $row->status !== 'pending') return;
        if (strtotime($row->scheduled_at . ' UTC') > time()) {
            wp_schedule_single_event(strtotime($row->scheduled_at . ' UTC'), self::HOOK, [(int) $id]);
            return;
        }
        // قفل اتمیک برای جلوگیری از ارسال دوباره در اجرای هم‌زمان Cron.
        $claimed = $wpdb->update($table, ['status' => 'sending'], ['id' => (int) $id, 'status' => 'pending'], ['%s'], ['%d', '%s']);
        if ($claimed !== 1) return;
        $result = self::send_provider($row->provider, $row->phone, $row->message);
        if (is_wp_error($result)) {
            $wpdb->update($table, ['status' => 'failed', 'provider_result' => $result->get_error_message()], ['id' => (int) $id], ['%s', '%s'], ['%d']);
        } else {
            $wpdb->update($table, ['status' => 'sent', 'provider_result' => wp_json_encode($result), 'sent_at' => gmdate('Y-m-d H:i:s')], ['id' => (int) $id], ['%s', '%s', '%s'], ['%d']);
        }
    }

    private static function send_provider($provider, $phone, $message) {
        if ($provider === 'kavenegar') {
            $key = rawurlencode(ANBARIN_KAVENEGAR_API_KEY);
            $body = ['receptor' => $phone, 'message' => $message];
            if (defined('ANBARIN_KAVENEGAR_SENDER') && ANBARIN_KAVENEGAR_SENDER !== '') $body['sender'] = ANBARIN_KAVENEGAR_SENDER;
            $response = wp_remote_post("https://api.kavenegar.com/v1/{$key}/sms/send.json", ['timeout' => 25, 'body' => $body]);
            if (is_wp_error($response)) return $response;
            $json = json_decode(wp_remote_retrieve_body($response), true);
            if (wp_remote_retrieve_response_code($response) < 200 || wp_remote_retrieve_response_code($response) >= 300 || (isset($json['return']['status']) && (int) $json['return']['status'] !== 200)) return new WP_Error('kavenegar_failed', $json['return']['message'] ?? 'ارسال کاوه‌نگار ناموفق بود.');
            return $json;
        }
        if ($provider === 'faraz') {
            $response = wp_remote_post('https://api2.ippanel.com/api/v1/sms/send/webservice/single', [
                'timeout' => 25,
                'headers' => ['Content-Type' => 'application/json', 'Authorization' => 'AccessKey ' . ANBARIN_FARAZ_ACCESS_KEY],
                'body' => wp_json_encode(['recipient' => [$phone], 'sender' => ANBARIN_FARAZ_SENDER, 'message' => $message]),
            ]);
            if (is_wp_error($response)) return $response;
            $json = json_decode(wp_remote_retrieve_body($response), true);
            if (wp_remote_retrieve_response_code($response) < 200 || wp_remote_retrieve_response_code($response) >= 300 || (isset($json['status']['code']) && (int) $json['status']['code'] >= 400)) return new WP_Error('faraz_failed', $json['message'] ?? 'ارسال فراز اس‌ام‌اس ناموفق بود.');
            return $json ?: ['http' => wp_remote_retrieve_response_code($response)];
        }
        if ($provider === 'melipayamak') {
            $response = wp_remote_post('https://rest.payamak-panel.com/api/SendSMS/SendSMS', [
                'timeout' => 25,
                'headers' => ['Content-Type' => 'application/json'],
                'body' => wp_json_encode(['username' => ANBARIN_MELIPAYAMAK_USERNAME, 'password' => ANBARIN_MELIPAYAMAK_PASSWORD, 'to' => $phone, 'from' => ANBARIN_MELIPAYAMAK_SENDER, 'text' => $message, 'isFlash' => false]),
            ]);
            if (is_wp_error($response)) return $response;
            $body = wp_remote_retrieve_body($response);
            if (wp_remote_retrieve_response_code($response) < 200 || wp_remote_retrieve_response_code($response) >= 300 || trim($body) === '' || preg_match('/^-\d+$/', trim($body))) return new WP_Error('melipayamak_failed', 'ارسال ملی‌پیامک ناموفق بود: ' . sanitize_text_field($body));
            return ['response' => sanitize_text_field($body)];
        }
        return new WP_Error('provider_unknown', 'سرویس‌دهنده ناشناخته است.');
    }

    public static function cors($served, $result, $request, $server) {
        if (strpos($request->get_route(), '/anbarin/v1/sms/schedule') !== 0) return $served;
        $origin = isset($_SERVER['HTTP_ORIGIN']) ? esc_url_raw(wp_unslash($_SERVER['HTTP_ORIGIN'])) : '';
        $site = untrailingslashit(get_site_url());
        $site_origin = (is_ssl() ? 'https://' : 'http://') . wp_parse_url($site, PHP_URL_HOST) . (wp_parse_url($site, PHP_URL_PORT) ? ':' . wp_parse_url($site, PHP_URL_PORT) : '');
        $allowed = ['https://localhost', 'capacitor://localhost', 'http://localhost', $site_origin];
        if ($origin && in_array($origin, $allowed, true)) {
            header('Access-Control-Allow-Origin: ' . $origin);
            header('Vary: Origin', false);
            header('Access-Control-Allow-Methods: POST, OPTIONS');
            header('Access-Control-Allow-Headers: Authorization, Content-Type, X-WP-Nonce');
        }
        return $served;
    }
}

register_activation_hook(__FILE__, ['Anbarin_Scheduled_SMS_Queue', 'activate']);
Anbarin_Scheduled_SMS_Queue::boot();

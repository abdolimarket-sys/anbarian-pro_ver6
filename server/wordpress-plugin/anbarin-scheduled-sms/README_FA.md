# افزونه صف پیامک زمان‌بندی‌شده انبارین

این افزونه یک صف پایدار در WordPress ایجاد می‌کند و پیامک را در زمان مقرر از طریق کاوه‌نگار، فراز اس‌ام‌اس یا ملی‌پیامک ارسال می‌کند. ارسال در سرور انجام می‌شود؛ بنابراین باز بودن برنامه انبارین لازم نیست.

## نصب

1. پوشه `anbarin-scheduled-sms` را در `wp-content/plugins/` سایت WordPress قرار دهید.
2. در `wp-config.php`، قبل از خط `/* That's all, stop editing! */`، توکن و کلیدهای سرویس مورد استفاده را اضافه کنید:

```php
define('ANBARIN_SMS_SCHEDULER_TOKEN', 'یک-توکن-تصادفی-طولانی-و-منحصر-به-فرد');

// فقط سرویس انتخابی را تنظیم کنید:
define('ANBARIN_KAVENEGAR_API_KEY', 'کلید-کاوه-نگار');
define('ANBARIN_KAVENEGAR_SENDER', 'شماره-خط-اختیاری');

define('ANBARIN_FARAZ_ACCESS_KEY', 'کلید-دسترسی-فراز');
define('ANBARIN_FARAZ_SENDER', 'شماره-خط-ارسال');

define('ANBARIN_MELIPAYAMAK_USERNAME', 'نام-کاربری');
define('ANBARIN_MELIPAYAMAK_PASSWORD', 'رمز-عبور');
define('ANBARIN_MELIPAYAMAK_SENDER', 'شماره-خط-ارسال');
```

3. افزونه را از پیشخوان WordPress فعال کنید.
4. در تنظیمات انبارین، آدرس API را به `https://YOUR-DOMAIN/wp-json/anbarin/v1/sms/schedule` و توکن را دقیقاً برابر `ANBARIN_SMS_SCHEDULER_TOKEN` قرار دهید. سرویس‌دهنده انتخاب‌شده در انبارین باید با کلیدهای تعریف‌شده در WordPress یکسان باشد.
5. در تنظیمات سرور cPanel یک Cron Job هر یک دقیقه تنظیم کنید تا صف حتی در سایت‌های کم‌ترافیک اجرا شود. نمونه:

```bash
* * * * * /usr/bin/curl -fsS https://YOUR-DOMAIN/wp-cron.php?doing_wp_cron >/dev/null 2>&1
```

در صورت استفاده از Cron واقعی cPanel، برای جلوگیری از اجرای هم‌زمان غیرضروری می‌توانید `define('DISABLE_WP_CRON', true);` را در `wp-config.php` اضافه کنید.

## امنیت و محدودیت‌ها

- سایت باید HTTPS فعال داشته باشد.
- توکن و کلید سرویس‌ها را محرمانه نگه دارید و از توکن طولانی و تصادفی استفاده کنید.
- اطلاعات صف در جدول اختصاصی WordPress ذخیره می‌شود؛ وضعیت هر پیام `pending`، `sent` یا `failed` است. کلید idempotency ارسالی از برنامه نیز از ثبت چندباره یک درخواست جلوگیری می‌کند.
- این نسخه ارسال زمان‌بندی‌شده را برای کاوه‌نگار، فراز و ملی‌پیامک پیاده‌سازی می‌کند. حالت «پیامک گوشی» و API سفارشی فاقد قرارداد صف اختصاصی، پشتیبانی نمی‌شوند.
- WP-Cron به‌تنهایی ممکن است در سایت کم‌ترافیک دیر اجرا شود؛ Cron Job یک‌دقیقه‌ای cPanel برای اجرای به‌موقع ضروری است.

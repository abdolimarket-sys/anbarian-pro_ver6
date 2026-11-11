# Anbarin Pro 1.5.7 — Phase 59

## Phase 59: Transaction integrity and duplicate prevention
- Serializes invoice posting and receipt/payment creation within the running app instance.
- Re-reads persisted commerce data before validating critical operations.
- Blocks duplicate invoice numbers at posting time.
- Blocks duplicate receipt/payment numbers within document type and fiscal year.
- Blocks reuse of an active cheque number with the same bank.
- Moves stock concurrency validation before accounting journal posting.
- Preserves warehouse negative-stock policy and existing costing behavior.
- No database schema migration; scanner source remains unchanged.

Limit: the in-process lock does not coordinate multiple devices, browser tabs, or independent clients. Shared-server/database constraints are required for cross-device concurrency guarantees.

Automated tests: 168 passed. TypeScript/Vite build and APK/device validation were not run.

## Phase 60 — Inventory and accounting reconciliation
- Added a read-only reconciliation report for operational quantities, costing balances, and posted inventory-ledger lines.
- Flags quantity mismatches, negative balances, orphan costing balances, and unvalued stock.
- No stock, journal, or accounting data is modified automatically.
- Barcode scanner source remains unchanged.

## فاز ۶۱ — مرکز سلامت داده‌ها
- صفحه مستقل بررسی سلامت کالاها، بارکدها، اسناد حسابداری، بهای تمام‌شده، لاگ و پشتیبان.
- گزارش خطاها و هشدارها به‌صورت فقط‌خواندنی؛ بدون اصلاح یا حذف خودکار داده.
- ماژول اسکنر بارکد بدون تغییر.

## فاز ۶۲ — تشخیص و کنترل تعارض همگام‌سازی
- پیش‌بررسی بسته‌های JSON و توقف امن برای شناسه‌های تکراری/مبهم.
- تأیید صریح برای تعارض اطلاعات پایه کالا و ثبت جزئیات در گزارش و لاگ.
- هشدار تعارض اطلاعات پایه بین دستگاه‌های آنلاین بدون بازنویسی خودکار اطلاعات کالا.
- محدودیت اندازه بسته و کنترل تعداد اقلام.
- محدودیت: هماهنگی تراکنشی واقعی بین دستگاه‌ها نیازمند منطق سمت سرور است.


## فاز ۶۵ — تکمیل فرم فاکتور خرید و فروش
- شماره فاکتور خودکار و قابل ورود دستی، با پیش‌شماره مستقل خرید و فروش و کنترل شماره تکراری.
- تاریخ امروز شمسی با امکان ورود دستی و انتخاب تاریخ از تقویم.
- جست‌وجوی کالا با نام/بارکد/SKU، ورود دستی بارکد و اسکن دوربین از فرم فاکتور.
- ردیف‌های منظم کالا با واحد، تعداد، قیمت، تخفیف و مبلغ خودکار.
- شرایط پرداخت نقدی، چکی، اعتباری، ترکیبی و کارت‌خوان. ثبت وجوه واقعی همچنان در صفحه دریافت و پرداخت است.
- ۱۹۴ تست خودکار موفق؛ APK و تست فیزیکی دوربین انجام نشده است.

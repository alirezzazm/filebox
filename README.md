# 📦 FileBox

انبار فایل شخصی — آپلود، چت با ارسال فایل، و پنل ادمین با رمز.

پنل ادمین نشان می‌دهد چقدر فضا مصرف شده و اجازه می‌دهد فایل‌ها را
تکی یا گروهی دانلود و حذف کنی، تا دیسک سرور بی‌سروصدا پر نشود.

دو حالت اجرا دارد:
- **داکر** روی کامپیوتر خانگی + Cloudflare Tunnel
- **PM2 + nginx** روی سرور ویندوزی (کانفیگ نمونه در `deploy/`)

## روی چه آدرسی بالا می‌آید؟

```
http://localhost:8080
```

پورت داخل کانتینر هم **8080** است. در `docker-compose.yml` به صورت
`127.0.0.1:8080:8080` بایند شده — یعنی فقط از خود همان کامپیوتر باز می‌شود
و از اینترنت فقط از راه تانل کلادفلر.
اگر می‌خواهی از گوشی داخل شبکه خانه هم باز شود، آن خط را به `"8080:8080"` تغییر بده.

سه بخش برنامه:

| بخش | آدرس |
|---|---|
| آپلود فایل | `http://localhost:8080/#upload` |
| چت (با ارسال فایل) | `http://localhost:8080/#chat` |
| پنل دانلود (رمزدار) | `http://localhost:8080/#panel` |

## راه‌اندازی

```bash
cp .env.example .env
nano .env          # حداقل ADMIN_PASSWORD را عوض کن
docker compose up -d --build
```

بعد برو به http://localhost:8080

لاگ‌ها:

```bash
docker compose logs -f filebox
```

## اتصال به Cloudflare Tunnel

1. داشبورد Cloudflare → **Zero Trust → Networks → Tunnels → Create a tunnel** (نوع Cloudflared).
2. توکن تانل را کپی کن و در `.env` بگذار: `TUNNEL_TOKEN=eyJ...`
3. در تب **Public Hostname** تانل:
   - Subdomain: مثلاً `files` — Domain: دامنه خودت
   - Service: `HTTP` → آدرسش بستگی دارد cloudflared کجا اجرا شود:
     - اگر cloudflared را با `--profile tunnel` داخل همین compose بالا آوردی: `filebox:8080`
     - اگر cloudflared روی خود هاست سرویس systemd است: `localhost:8080`
4. بالا آوردن تانل کنار برنامه:

```bash
docker compose --profile tunnel up -d
```

حالا سایت روی `https://files.example.com` بالاست، بدون باز کردن هیچ پورتی روی مودم.

### نکته مهم: محدودیت حجم آپلود کلادفلر
روی پلن رایگان کلادفلر، سقف حجم هر درخواست **۱۰۰ مگابایت** است.
برای فایل‌های بزرگ‌تر یا از شبکه داخلی آپلود کن (`http://IP-کامپیوتر:8080`)
یا فایل را به قطعات کوچک‌تر تقسیم کن.

### امنیت بیشتر (اختیاری ولی توصیه‌شده)
در Zero Trust → **Access → Applications** یک اپلیکیشن روی همان هاست‌نیم بساز
و سیاست «فقط ایمیل خودم» بگذار. اینطوری قبل از رسیدن به برنامه، کلادفلر هم احراز هویت می‌کند.

## فایل‌ها کجا ذخیره می‌شوند؟

همه چیز در پوشه `data/` کنار پروژه:

```
data/
├── db.json                 ← فهرست فایل‌ها و پیام‌های چت
└── uploads/
    ├── image/2026-08/2026-08-26_a1b2c3_عکس.jpg
    ├── document/2026-08/2026-08-26_d4e5f6_قرارداد.pdf
    ├── video/2026-08/...
    └── archive/2026-08/...
```

مرتب‌سازی خودکار: **دسته‌بندی نوع فایل → سال-ماه → تاریخ_شناسه__نام اصلی**.
نام اصلی فایل حفظ می‌شود و موقع دانلود دقیقاً با همان نام تحویل داده می‌شود.

بکاپ گرفتن ساده است:

```bash
tar czf filebox-backup-$(date +%F).tar.gz data/
```

## متغیرهای محیطی

| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `PORT` | `8080` | پورت برنامه |
| `ADMIN_PASSWORD` | `change-me-123` | رمز پنل دانلود |
| `UPLOAD_PASSWORD` | خالی | اگر بگذاری، آپلود و چت هم رمز می‌خواهد |
| `MAX_FILE_MB` | `2048` | حداکثر حجم هر فایل |
| `STORAGE_QUOTA_GB` | `5` | سقف مجموع فضای اشغال‌شده |
| `MIN_FREE_DISK_GB` | `2` | کف فضای آزاد دیسک؛ مستقل از سهمیه |
| `SESSION_HOURS` | `12` | مدت اعتبار ورود به پنل |
| `DATA_DIR` | `/data` | مسیر ذخیره‌سازی |

## API

| متد | مسیر | رمز؟ | کار |
|---|---|---|---|
| POST | `/api/upload` | رمز آپلود | آپلود چندتایی (`files`) |
| GET | `/api/messages?since=N` | — | گرفتن پیام‌های جدید |
| POST | `/api/messages` | رمز آپلود | ارسال پیام + فایل اختیاری |
| POST | `/api/login` | — | ورود به پنل |
| GET | `/api/files` | ✅ | لیست فایل‌ها با فیلتر و جستجو |
| GET | `/api/download/:id` | ✅ | دانلود فایل |
| GET | `/api/view/:id` | ✅ | پیش‌نمایش در مرورگر |
| GET | `/api/zip?category=image` | ✅ | دانلود گروهی به صورت zip |
| DELETE | `/api/files/:id` | ✅ | حذف فایل |
| POST | `/api/files/bulk-delete` | ✅ | حذف گروهی با `ids[]` یا `category` |
| GET | `/healthz` | — | سلامت سرویس |

## سهمیه فضا

دو محافظ مستقل جلوی پر شدن دیسک را می‌گیرند:

**۱. سهمیه برنامه** (`STORAGE_QUOTA_GB`) — سقف مجموع بایت‌های ذخیره‌شده.
آپلودی که از آن رد شود، قبل از نوشتن روی دیسک و از روی `Content-Length`
رد می‌شود؛ اگر با این حال چیزی از سهمیه گذشت، فایل‌های همان درخواست
حذف و برگردانده می‌شوند.

**۲. کف دیسک** (`MIN_FREE_DISK_GB`) — به فضای آزاد **واقعی** دیسک نگاه
می‌کند، نه به سهمیه. اگر سرویس دیگری روی همان ماشین دیسک را پر کند،
آپلود بسته می‌شود حتی اگر سهمیه هنوز جا داشته باشد. روی سروری که
اپ‌های دیگر هم دارد این لایه از سهمیه مهم‌تر است.

هر دو وضعیت در پنل ادمین دیده می‌شود: درصد مصرف، تفکیک حجم هر دسته،
و فضای آزاد دیسک سرور.

## استقرار روی سرور ویندوزی (PM2 + nginx)

```powershell
npm install --omit=dev
copy ecosystem.config.js.example ecosystem.config.js
# ADMIN_PASSWORD و مسیرها را ویرایش کن
pm2 start ecosystem.config.js
pm2 save
```

`ecosystem.config.js` رمز دارد و در `.gitignore` است؛ فقط نسخه‌ی
`.example` نگهداری می‌شود.

کانفیگ nginx در `deploy/nginx-mainfile.emanstore.ir.conf` است. دو تنظیم
در آن عمدی است:

- `proxy_request_buffering off` — بدون آن nginx کل بدنه‌ی آپلود را اول
  روی دیسک بافر می‌کند، یعنی مصرف دیسک در لحظه‌ی آپلود دو برابر می‌شود.
- `client_max_body_size` باید با `MAX_FILE_MB` هم‌تراز بماند.

فایل کانفیگ **نباید BOM داشته باشد**؛ nginx با BOM بالا نمی‌آید.

### دامنه پشت پروکسی کلادفلر
اگر رکورد DNS ابر نارنجی باشد، کلادفلر با HTTPS به origin وصل می‌شود،
پس بلوک `443` با گواهی معتبر لازم است وگرنه درخواست روی vhost پیش‌فرض
سرور می‌افتد. ضمناً سقف ۱۰۰ مگابایتی پلن رایگان همان‌جا هم اعمال می‌شود؛
برای آپلود فایل بزرگ‌تر باید رکورد را DNS-only کرد.

## اجرا بدون داکر

```bash
npm install
ADMIN_PASSWORD=mypass npm start
```

## عیب‌یابی

### Docker Hub با خطای 403 رد می‌کند (ایران)

یک میرور داخلی در `/etc/docker/daemon.json` بگذار:

```bash
cat > /etc/docker/daemon.json <<JSON
{
  "registry-mirrors": [
    "https://docker.arvancloud.ir",
    "https://docker.mobinhost.com",
    "https://registry.docker.ir"
  ]
}
JSON
systemctl restart docker
```

### خطای EACCES روی /data/uploads

از نسخه‌های جدید حل شده — `docker-entrypoint.sh` مالکیت را خودکار اصلاح می‌کند.
اگر باز دیدی، ایمیج را از نو بیلد کن: `docker compose up -d --build`

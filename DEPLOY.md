# Развёртывание на CloudPanel

Проверено на Ubuntu 24.04 + CloudPanel v2. Домен `toolkin.app`, пользователь сайта
`toolkin`, порт приложения `3010`.

## 1. Сайт в CloudPanel

**Сайты → Добавить сайт → Node.js.**

| Поле | Значение |
|---|---|
| Имя домена | `toolkin.app` |
| Версия Node.js | **22 LTS** (панель принимает 12–22; Node 24 форма отвергнет) |
| Порт приложения | **3010** (3000 обычно уже занят другим сайтом) |
| Пользователь сайта | `toolkin` |

Порт наружу не выставляется — CloudPanel настраивает nginx как обратный прокси
на `127.0.0.1:3010`.

## 2. DNS — до выпуска сертификата

У регистратора две A-записи на IP сервера:

```
@     A    195.35.48.60
www   A    195.35.48.60
```

Проверка перед следующим шагом:

```bash
dig +short toolkin.app
dig +short www.toolkin.app
```

Обе должны вернуть IP сервера. Если домен за Cloudflare — на время выпуска
отключите проксирование (серое облачко): оранжевое ломает HTTP-01 проверку.

Симптом неверной записи — при выпуске сертификата Let's Encrypt пишет
`Invalid response from http://toolkin.app/.well-known/acme-challenge/...: 500`
и указывает IP, к которому обратился. Если этот IP не ваш — дело в DNS, а не в
сертификате.

## 3. SSL

**SSL/TLS → Новый сертификат Let's Encrypt → Создать и установить.**

Обязательно и сразу: зона `.app` целиком в HSTS-preload списке, браузеры
отказываются открывать её по HTTP. Без сертификата сайт не откроется вообще.

На саму ACME-проверку HSTS не влияет — она идёт по 80-му порту штатно.

## 4. PostgreSQL

Менеджер баз в CloudPanel рассчитан на MySQL (`clpctl` внутри вызывает
`mysqldump`), поэтому Postgres ставится вручную:

```bash
sudo apt update && sudo apt install -y postgresql
sudo systemctl enable --now postgresql

sudo -u postgres psql <<'SQL'
CREATE USER toolkin WITH PASSWORD 'ПАРОЛЬ';
CREATE DATABASE toolkin OWNER toolkin;
SQL
```

Production-пользователю `CREATEDB` не нужен: миграции уже лежат в репозитории и
применяются через `prisma migrate deploy`. Для локальной разработки с
`prisma migrate dev` используйте отдельную dev-базу/роль.

Postgres по умолчанию слушает только localhost — снаружи он недоступен, менять
это не нужно.

## 5. Код

По SSH под пользователем сайта:

```bash
cd /home/toolkin/htdocs/toolkin.app
# распаковать сюда содержимое архива
npm install
cp .env.example .env
nano .env
```

Если `echo $NODE_ENV` выводит `production`, ставьте `npm install --include=dev`:
иначе npm пропустит devDependencies, а Prisma CLI лежит именно там.

Версии Prisma закреплены жёстко (`6.14.0`, без `^`) сознательно. Prisma 7 убрала
поддержку `url` в блоке `datasource` и требует отдельный `prisma.config.ts` —
переезд на неё это отдельная задача, а не побочный эффект установки.

Проверьте, что CLI взялся локальный, а не скачался из реестра:

```bash
npx prisma --version   # должно быть 6.x
```

Минимум, без чего не стартует:

```env
DATABASE_URL=postgresql://toolkin:ПАРОЛЬ@localhost:5432/toolkin
TOOLKIN_GEMINI_API_KEY=...
TOOLKIN_PLAN_SECRET=...отдельный случайный секрет минимум 32 байта...
TOOLKIN_CLIENT_TOKEN=...длинная случайная строка...
TOOLKIN_REVENUECAT_WEBHOOK_SECRET=...ещё одна...
```

Спецсимволы в пароле (`@`, `:`, `/`, `#`) кодируйте процентами, иначе Prisma
разберёт строку подключения неправильно.

Секрет для подписи Product Plan сгенерируйте отдельно и не переиспользуйте как
client token:

```bash
openssl rand -hex 32
```

При ротации `TOOLKIN_PLAN_SECRET` незавершённые planToken, выданные до рестарта,
станут недействительны; клиент автоматически вернётся к повторному planning.

## 6. Проверки, сборка и миграция

Миграции входят в архив. На production **не создавайте их командой
`prisma migrate dev`**. Сначала убедитесь, что новый код собирается, и только
потом применяйте уже проверенную миграцию:

```bash
npm test
npm run typecheck
npm run build
npx prisma migrate deploy
```

`20260812090000_production_baseline` сделана idempotent: она подходит и для
чистой базы, и для серверов, которые раньше были инициализированы локальным
`migrate dev`. Следующая миграция `20260812143000_generation_jobs` добавляет
`GenerationJob` для асинхронной генерации. Она не меняет баланс, Ledger или
существующие спеки. При переходе со старой схемы существующие аккаунты не
получают welcome-кредиты повторно; новые аккаунты по-прежнему обслуживаются
текущей логикой `welcomeGranted`.

Перед первой миграцией существующей production-базы всё равно сделайте backup.
`npm run build` вызывает `prisma generate` перед Next.js build — Prisma Client
не разъедется со схемой.

## 7. PM2

CloudPanel сам приложение не запускает — он только проксирует на порт. Процессом
управляет PM2, ставим его под пользователем сайта, а не под root: приложению
незачем работать с правами суперпользователя, а установка под root с запуском
под `toolkin` даёт два независимых демона PM2 и путаницу с тем, чей процесс где.

```bash
npm install -g pm2
which pm2
```

**Не задавайте `npm config set prefix`.** CloudPanel использует nvm, и префикс с
ним несовместим — npm предупредит об этом, а `nvm use` начнёт ругаться. Глобальные
пакеты nvm и так кладёт в `~/.nvm/versions/node/<версия>/bin`, который уже в PATH.

```bash
cd ~/htdocs/toolkin.app
mkdir -p ~/logs
pm2 start ecosystem.config.js
pm2 save
pm2 status
```

### Автозапуск после перезагрузки

`pm2 save` сохраняет список процессов, `pm2 resurrect` его восстанавливает.
Порядок важен: без `save` восстанавливать нечего.

Без root — вкладка **Задачи Cron** у сайта:

```
@reboot bash -lc 'pm2 resurrect'
```

Именно через `bash -lc`, а не абсолютным путём к `pm2`: путь у nvm содержит номер
версии Node, и после её обновления задание молча перестанет работать. Login-шелл
подтягивает nvm сам и находит актуальный бинарник.

С root надёжнее systemd — он поднимет процесс не только после перезагрузки, но и
если тот упадёт сам:

```bash
pm2 startup systemd -u toolkin --hp /home/toolkin
# выполнить напечатанную sudo-команду от root
```

### Проверка

До всякого nginx:

```bash
pm2 logs toolkin --lines 30
curl -s "localhost:3010/api/app-version?platform=ios&version=1.0.0"
```

### Если правили PATH руками

Дописывать в `~/.bashrc` через `echo ... >>` опасно: если файл заканчивается без
перевода строки, новая команда приклеится к последней. У CloudPanel там `umask 007`,
и получается `umask 007export PATH=...`. Проверяйте `tail -3 ~/.bashrc`, а
добавляйте через `printf '\n%s\n' 'строка' >> ~/.bashrc`.


### Асинхронная генерация

Создание приложения больше не держит HTTPS-запрос открытым до окончания Gemini.
`POST /api/generate` возвращает `202 + jobId`, а мобильный клиент опрашивает
`GET /api/generate/status?jobId=…`. Состояние лежит в Postgres, поэтому обычный
mobile/nginx timeout не отменяет работу. Отдельный Redis/worker не нужен: при
одном PM2 instance job запускается внутри постоянного Node-процесса. Если PM2
перезапустился, stale job автоматически возвращается в очередь при следующем
status-poll.

Для диагностики очереди:

```bash
psql "$DATABASE_URL" -c 'select "status", "stage", count(*) from "GenerationJob" group by 1,2 order by 1,2;'
psql "$DATABASE_URL" -c 'select "id", "status", "stage", "attempts", "error", "updatedAt" from "GenerationJob" order by "createdAt" desc limit 10;'
```

Status polling исключён из обычного IP rate limit: это дешёвое чтение по
`jobId + X-App-User-Id`, иначе минутная генерация сама съедала бы часовой лимит.

## 8. Приложение

Один домен обслуживает и лендинг, и API — отдельный `api.` поддомен на своём
сервере только добавляет сертификат и vhost без пользы.

В `.env` Expo-проекта:

```env
EXPO_PUBLIC_API_BASE=https://toolkin.app/api
EXPO_PUBLIC_TOOLKIN_CLIENT_TOKEN=то же, что TOOLKIN_CLIENT_TOKEN на сервере
```

## 9. RevenueCat

**Integrations → Webhooks:**

- URL: `https://toolkin.app/api/webhooks/revenuecat`
- Authorization header: значение `TOOLKIN_REVENUECAT_WEBHOOK_SECRET`

Сравнение секрета идёт через `timingSafeEqual`, значение должно совпадать байт в
байт. Проверка живости:

```bash
curl -s https://toolkin.app/api/webhooks/revenuecat
# {"ok":true,"endpoint":"RevenueCat webhook"}
```

## Прогон качества генерации

```bash
cd ~/htdocs/toolkin.app
npm run eval
```

Двадцать запросов через настоящий конвейер, около пяти минут и десяти центов.
Показывает долю спек, прошедших валидатор с первой попытки, разбивку по типам
утилит и гистограмму причин починки — по ней видно, какое правило промпта
чинить следующим.

Кэш спек прогон не использует: цифры честные, но каждый запуск стоит денег.

## Обновления

Обновляйте так, чтобы старый PM2-процесс продолжал обслуживать трафик, пока
новый код проходит проверки. Миграция применяется только после успешной сборки:

```bash
npm install --include=dev
npm test
npm run typecheck
npm run build
npx prisma migrate deploy
pm2 restart toolkin --update-env
```

Если `.env` был создан из предыдущего архива, обновите latency-параметры вручную
(замена `.env.example` существующий `.env` не меняет):

```env
TOOLKIN_THINKING_GENERATE=medium
TOOLKIN_MAX_REPAIRS=1
TOOLKIN_ATTEMPTS_PER_MODEL=1
TOOLKIN_MAX_MODELS_PER_CALL=2
TOOLKIN_AI_REQUEST_TIMEOUT_MS=90000
```

На сервере именно `migrate deploy`, а не `migrate dev`: он применяет только
проверенные миграции из архива. Если build или тесты упали, до миграции и
рестарта не доходите — текущая production-версия продолжит работать.

## Разработка в Expo Go

В Expo Go нет нативного RevenueCat, поэтому приложение использует заглушку
биллинга: подписка и пакеты кредитов «покупаются» мгновенно и бесплатно.
Кредиты при этом начисляются на сервере по-настоящему — иначе баланс в
приложении разошёлся бы с базой.

Для этого нужен отладочный роут, выключенный по умолчанию:

```env
TOOLKIN_ALLOW_DEV_GRANT=true
```

```bash
pm2 restart toolkin
```

Без него покупка в Expo Go вернёт «Отладочное начисление выключено».
**На проде обязан быть `false`** — это открытая ручка «дай кредитов».

## Проверка конфигурации

```bash
curl -s -H "X-Client-Token: $TOOLKIN_CLIENT_TOKEN" https://toolkin.app/api/health | python3 -m json.tool
```

Роут получает список доступных моделей и делает **один** маленький настоящий
planner probe через тот же Gemini Interactions transport, который используется
для structured JSON. Он не генерирует тестовые приложения и не пингует каждую
модель отдельным платным запросом. Перед переключением трафика должны быть
`aiJsonTransport: "interactions"`, `generationTransport: "durable-job-polling"`,
`generationJobsReady: true`, `planWorking: true`, `plannerProbe.ok: true` и
`productionConfigOk: true`. `working`/`suggestions` показывают, какие модели
видит именно ваш ключ. `productionConfigOk` в production подтверждает наличие
`DATABASE_URL`, `TOOLKIN_CLIENT_TOKEN`, отдельного `TOOLKIN_PLAN_SECRET` и
`TOOLKIN_REVENUECAT_WEBHOOK_SECRET`.

Доступность и имена Gemini-моделей меняются, поэтому `/api/health` считается
источником истины именно для вашего production-ключа. Не привязывайте deploy к
историческим датам снятия моделей: обновляйте каскад через переменные окружения,
не меняя код приложения.

## Если не работает

**502 Bad Gateway** — процесс упал или слушает не тот порт.
`pm2 logs toolkin --lines 50`; почти всегда это отсутствующая переменная в `.env`.

**Правки `.env` не видны** — Next.js читает переменные при старте.
`pm2 restart toolkin` после каждой правки.

**Ошибка Prisma про клиент** — не выполнен `prisma generate`. Он внутри
`npm run build`, но при ручной сборке вызывайте отдельно.

**Сертификат не выпускается** — см. шаг 2, это DNS.

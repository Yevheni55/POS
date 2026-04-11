# Методичка для агента: проект POS и доступ к ПК кассы

Документ для другого ИИ-агента: как устроен репозиторий, где что лежит, как подключиться к боевому/тестовому ПК кассы и выкатывать изменения.

## 1. Что это за проект

- **Одно приложение**: backend на **Node.js (Express)** + статический фронт (POS терминал, админка) отдаётся с того же сервера из корня репозитория.
- **База**: **PostgreSQL**, схема через **Drizzle** (`server/db/`).
- **Прод на кассе**: обычно **Docker Compose** (`docker-compose.yml`): сервисы `db` (Postgres) и `app` (Node). Порты на хосте: **3080** (HTTP API + раздача HTML/JS), **3443** (HTTPS, если есть сертификаты в `server/certs/`), **5432** (Postgres, если не закрыт файрволом).
- **Фискализация (Словакия)**: интеграция с **Portos / eKasa** по HTTP. Код: `server/lib/portos.js`, оплата и фискальные документы: `server/routes/payments.js`. Реальный Portos слушает на хосте кассы обычно **порт 3010**; из контейнера `app` доступ задаётся **`PORTOS_BASE_URL`** (по умолчанию в compose: `http://host.docker.internal:3010`).

Важно: **юнит-/интеграционные тесты Portos не требуют живого Portos** — в тестах подменяется `global.fetch` (`server/test/routes/payments.portos.test.js`).

## 2. Структура репозитория (кратко)

| Путь | Назначение |
|------|------------|
| `server/` | Backend: `server.js`, `app.js`, `routes/`, `lib/`, `db/` |
| `server/.env` | Локальные секреты и настройки; **в git не коммитится** |
| `js/`, `admin/`, `*.html` | Фронт POS и админки |
| `docker-compose.yml` | Оркестрация `db` + `app` |
| `scripts/deploy-tailscale-pos.sh` | Выгрузка архива на кассу по SSH + `docker compose up` |
| `server/PORTOS_RUNBOOK.md` | Чеклист и нюансы Portos (язык команды — словацкий/английский) |

## 3. Подключение к ПК кассы (удалённо)

### 3.1 Сеть

- Типичный доступ: **Tailscale** (или LAN). В правилах репозитория по умолчанию указан хост вида **`surfs@100.95.64.38`** и путь на диске кассы **`C:\POS`** (Windows). IP и пользователь могут отличаться — смотреть `~/.ssh/config` и правило `autonomous-deploy.mdc` в `.cursor/rules/`.

### 3.2 SSH

- Ключ: часто отдельный файл, например **`~/.ssh/id_ed25519_pos`** (Windows: `%USERPROFILE%\.ssh\id_ed25519_pos`).
- В `~/.ssh/config` удобно завести `Host` (например `pos-kasa-tscale`) с `HostName`, `User`, `IdentityFile`.

Пример проверки с машины разработчика:

```bash
ssh -i ~/.ssh/id_ed25519_pos surfs@<TAILSCALE_OR_LAN_IP> "hostname"
```

### 3.3 Docker по SSH с Windows-кассы

На Windows при неинтерактивной SSH-сессии **WinCred** для Docker часто падает с ошибкой вида *«A specified logon session does not exist»*. На кассе уже используется обход: **`docker-credential-nop`** в `C:\Users\surfs\bin` и правка `PATH` перед `docker`, либо см. `scripts/docker-credential-nop.cmd` и `scripts/docker-config-nop-creds.json` в репозитории.

Перед `docker compose` в той же SSH-сессии (PowerShell на кассе):

```powershell
$env:Path = 'C:\Users\surfs\bin;' + $env:Path
Set-Location C:\POS
docker compose up -d --build app
```

### 3.4 Распаковка архива на кассе (Windows)

Использовать **`tar.exe -xf archive.tgz`**, а не `tar -xzf` с неверными флагами — иначе архив не распакуется. Рабочий каталог: **`C:\POS`**.

## 4. Деплой кода на кассу

- Скрипт из Git Bash (пути Unix): **`./scripts/deploy-tailscale-pos.sh`** — собирает `tar` без `.git` и `node_modules`, кладёт на `C:\POS`, распаковывает, поднимает контейнеры. При сбое Docker по SSH файлы на диске могут уже обновиться — тогда на кассе вручную выполнить `docker compose up -d --build app`.

- **`server/.env` на кассе скриптом не перезаписывается** — секреты и флаги остаются локальными.

- После изменений схемы БД на кассе (если требуется): внутри контейнера `app` выполнять **`npm run db:push`** / сид по вашему runbook.

## 5. Как «работает» оплата и чек (для отладки)

1. POS вызывает **`POST /api/payments`** с `orderId`, `method`, `amount`.
2. Если **`PORTOS_ENABLED=false`** в окружении контейнера — заказ закрывается **без** вызова Portos (в ответе `fiscal.status: disabled`). Чека в Portos не будет.
3. Если Portos включён: строится payload (`server/lib/fiscal-payment.js`), **`registerCashReceipt`** → Portos; успешные HTTP-коды учитываются в том числе **200 и 201**; при сбоях сети — retry и lookup по `externalId` (`order-<id>-payment`).
4. Печать чека на бумагу идёт через канал **`PORTOS_PRINTER_NAME`** (`pos` = CHDU, не имя принтера Windows).

Фискальный документ продажи в БД ищется по **`externalId` заказа**, чтобы не путать со строкой STORNO при нескольких записях на один `order_id`.

## 6. Тесты на кассе (в Docker)

Живой Portos **не нужен**. Нужна БД **`pos_test`**:

```text
docker compose exec -T db psql -U pos -d postgres -c "CREATE DATABASE pos_test;"
docker compose exec -T app sh -lc "cd /app/server && DATABASE_URL=postgresql://pos:pos@db:5432/pos_test npm test"
```

Полный прогон может занять несколько минут.

## 7. POS с телефона в той же Wi‑Fi

- Открыть в браузере: **`http://<IP_КАССЫ>:3080/...`**
- На сервере должно быть **`CORS_ALLOW_LAN=true`** в `server/.env` (см. `server/lib/cors-origin.js`), иначе браузер заблокирует запросы к `/api` с не-localhost Origin.

## 8. Правила репозитория для агента

- После осмысленных правок кода — **коммит в `main`** с понятным сообщением (см. `.cursor/rules/git-commit.mdc`).
- Деплой на кассу по возможности **выполнять самому** (tar/scp/ssh), а не ограничиваться инструкциями пользователю (см. `autonomous-deploy.mdc`).

## 9. Быстрый чеклист «всё живо на кассе»

1. `docker compose ps` — `pos-app-1` и `pos-db-1` в норме.
2. `GET http://<касса>:3080/api/health` — ответ JSON.
3. Логи: `docker compose logs app --tail 100` — при старте строка вида **`[Portos] Fiscal integration ENABLED|DISABLED`** и `PORTOS_BASE_URL`.
4. Portos на **том же ПК**, куда указывает `PORTOS_BASE_URL` из контейнера (часто `host.docker.internal:3010` = Portos на Windows-хосте кассы).

---

*Файл можно обновлять при смене IP, пользователя SSH или процедуры деплоя.*

# POS у браузері через Tailscale (`100.x.x.x`)

## Чому «timeout» / сторінка не відкривається

### 1. Браузер на пристрої **без** Tailscale

Адреси **`100.x.x.x`** існують **тільки всередині Tailscale**. Звичайний телефон або ПК без клієнта Tailscale **не зможе** відкрити `http://100.95.68.84:3000`.

**Що зробити:** установи **Tailscale** на той самий пристрій, з якого відкриваєш браузер (ПК / ноут / телефон — для Android/iOS є додаток Tailscale). Увійди в **той самий акаунт**, що й на касі. Потім знову `http://100.95.68.84:3000`.

### 2. Брандмауэр Windows на касі

На касі (від адміністратора):

```powershell
cd C:\POS
powershell -ExecutionPolicy Bypass -File .\scripts\open-bar-pc-firewall.ps1
```

### 3. Docker / POS не запущені

На касі:

```powershell
cd C:\POS
docker compose ps
```

Має бути `pos-app-1` у стані **Up**. Якщо ні — `docker compose up -d`.

### 4. Інший Tailscale IP

На касі: `tailscale ip -4` — якщо IP змінився, онови посилання в браузері та `REMOTE_HOST` у `deploy.sh`.

### 5. Перевірка з домашнього ПК (де встановлений Tailscale)

У PowerShell:

```powershell
Test-NetConnection -ComputerName 100.95.68.84 -Port 3000
```

`TcpTestSucceeded : True` — порт досяжний; якщо `False` — firewall на касі або POS не слухає порт.

Або повна діагностика (з каталогу репозиторію `scripts`):

```powershell
.\diagnose-tailscale-from-home.ps1 -BarIp 100.95.68.84
```

На **касі** (від адміна):

```powershell
cd C:\POS
powershell -ExecutionPolicy Bypass -File .\scripts\diagnose-pos-on-bar-pc.ps1
```

### 6. Обидва в одному tailnet

У [admin console](https://login.tailscale.com/admin/machines) мають бути **обидва** пристрої, статус **Connected**, один акаунт. Якщо каса **Expired** — натисни **Reauthenticate**.

### 7. ACL у Tailscale

Якщо в **Access controls** є кастомний `acl.hujson`, який **забороняє** трафік між нодами — дозволь хоча б `TCP 3000` між твоїм ПК і касою (або тимчасово спрости ACL до дефолту для перевірки).

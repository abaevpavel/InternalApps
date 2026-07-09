# Деплой — Portal (AWS EC2)

Как портал (`apps/portal`) собирается и публикуется на проде. Схема — **статика за nginx**:
код собирается локально, на сервер уезжают только готовые файлы. Node на сервере не нужен
(бэкенд у портала — Supabase, внешний сервис).

## Прод-адрес

- **https://internal-apps.basementremodeling.com** — HTTPS, редирект с http, сертификат Let's Encrypt.

## Инфраструктура

| Ресурс | Значение |
|---|---|
| EC2 инстанс | `i-06f1f638f483eae74` («InternalApps»), `t3.micro`, регион `us-east-1` |
| ОС | Ubuntu 26.04 LTS |
| Публичный IP | `3.237.65.194` (⚠️ **не** Elastic IP — см. ниже) |
| Веб-сервер | nginx (раздаёт статику из `/var/www/portal`) |
| DNS | Route 53, A-запись `internal-apps.basementremodeling.com` → IP инстанса |
| TLS | Let's Encrypt через `certbot --nginx`, автопродление включено |
| Security Group | `sg-0c4e618ed91db078d` (TODOR-WEBSITE-PROD), inbound 22/80/443 |

### SSH

Приватный ключ — `baserebuild_t3d.pem` в корне репо (**в `.gitignore`**, права `600`, в git НЕ коммитится).

```bash
ssh -i baserebuild_t3d.pem ubuntu@3.237.65.194
```

## Редеплой (обновить портал на проде)

Из корня репозитория:

```bash
# 1. Собрать статику локально
npm run build:portal

# 2. Залить на сервер (rsync по SSH, --delete чистит удалённые файлы)
rsync -az --delete -e "ssh -i baserebuild_t3d.pem" \
  apps/portal/dist/ ubuntu@3.237.65.194:/var/www/portal/
```

nginx перезапускать не нужно — он раздаёт файлы из папки как есть.

> ⚠️ Собирать **локально**, не на сервере: у `t3.micro` ~1 ГБ RAM, сборка Vite может упасть по OOM.

## Конфигурация nginx

Файл на сервере: `/etc/nginx/sites-available/portal` (симлинк в `sites-enabled/`).
Ключевое: SPA-fallback `try_files $uri $uri/ /index.html` (клиентский роутинг), gzip, кэш `/assets/`.
Блок HTTPS (443) и редирект http→https добавлены certbot'ом автоматически.

## TLS / сертификат

Выпущен командой:
```bash
sudo certbot --nginx -d internal-apps.basementremodeling.com \
  --non-interactive --agree-tos -m vladislavsmagin1@gmail.com --redirect
```
Продлевается автоматически (systemd-таймер certbot). Проверка: `sudo certbot certificates`.

## Авторизация (Supabase / Google OAuth)

Портал использует **общий** Supabase-проект с Lovable-версией (одна БД, одни пользователи/роли).
Код авторизации универсален: `redirectTo: window.location.origin + '/'` — менять не нужно.

Чтобы Google-логин работал на этом домене, в **Supabase → Authentication → URL Configuration →
Redirect URLs** должен быть добавлен (не заменён):
```
https://internal-apps.basementremodeling.com/**
```
**Site URL не менять** (заденет Lovable). Google Cloud Console не трогать — callback идёт на адрес
самого Supabase-проекта, общий для всех приложений.

Доступ в портал разрешён только аккаунтам с внутренним доменом `@basementremodeling.com`
(проверено: внешние Google-аккаунты получают отказ).

## Известные ограничения / TODO

- **Нет Elastic IP.** Публичный IP временный: при stop/start инстанса он сменится, и A-запись
  в Route 53 придётся править вручную. Лимит EIP в аккаунте сейчас исчерпан (9 шт) — заказать
  расширение и закрепить постоянный IP за инстансом.
- Деплой ручной (build + rsync). При желании — вынести в CI (GitHub Actions).

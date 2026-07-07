# PetZone Queue Management System

Standalone API for PetZone clinic queue tokens. Deploy at **queue-management.petzone.pk**.

## What it does (current)

- Issue plain number tokens: **28, 29, 30…** (resets daily per branch)
- POS frontend (`petzone-pos-frontend`) calls this API and prints thermal slip
- Slip shows: **PetZone logo + number only**
- TV display / counter screen → **coming later**

## Root file

```
server.js   ← entry point (npm start)
```

## Deploy on cPanel (queue-management.petzone.pk)

1. Upload `queue-management-system-` folder
2. cPanel → **Setup Node.js App** → startup file: `server.js`
3. Copy `.env.example` → `.env` and set DB + CORS:

```env
DB_HOST=h40.eu.core.hostnext.net
DB_NAME=petzonep_queue-management
DB_USER=...
DB_PASSWORD=...
CORS_ORIGIN=https://petzone-pos-frontend.vercel.app,https://pos.petzone.pk
```

4. `npm install` → Start app
5. Point subdomain `queue-management.petzone.pk` to this app

## API endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/queue/resolve?posBranchId=1` | Map POS branch → queue branch |
| POST | `/api/queue/public/petzone/main/token` | Issue next token (28, 29…) |

## POS frontend connection

In `petzone-pos-frontend/.env`:

```env
NEXT_PUBLIC_QMS_API_URL=https://queue-management.petzone.pk/api
```

Staff opens **Sales → Queue Token** in POS, connects thermal printer, taps **Print Token**.

## Database

Import once: `database/schema.sql` into `petzonep_queue-management`

Default admin (standalone admin panel): `admin@petzone.com` / `Petzone@123`


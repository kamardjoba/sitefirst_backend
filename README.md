# Theatre Backend (Node.js + Express + PostgreSQL)

## Railway env
- `DATABASE_URL` — строка подключения к PostgreSQL (Railway → Variables)
- `CORS_ORIGIN` — `http://localhost:5173` (локально) / адрес фронта на проде
- `ADMIN_USER`, `ADMIN_PASS` — доступ к `/admin` (read-only)

## Quick start local (with Docker Postgres)
```bash
docker run --name theatredb -e POSTGRES_PASSWORD=pass -e POSTGRES_DB=theatre -p 5432:5432 -d postgres:16
export DATABASE_URL=postgres://postgres:pass@localhost:5432/theatre
npm i
npm run seed
npm run start    # http://localhost:4000
```

## Endpoints (base: /api)
- GET `/actors`
- GET `/venues`
- GET `/shows`
- GET `/shows/:id`
- GET `/sessions/:id/occupied`
- POST `/promo/apply`
- POST `/orders`
- GET `/orders/:id`

## Admin (read-only)
- GET `/admin` — список таблиц + количество строк
- GET `/admin/:table` — первые 200 строк
- GET `/admin/sql?q=SELECT ...` — произвольный SELECT

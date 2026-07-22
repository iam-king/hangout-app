# HANGOUT App

A runnable, dependency-free MVP for communities and events.

## Requirements

- Node.js 20 or later

## Run

```bash
npm start
```

Open http://localhost:3000

## Test

```bash
npm test
```

## Included

- Registration and login
- Communities and membership
- Event creation and publishing
- Attendance
- Search
- Notifications
- Responsive PWA shell
- JSON-file persistence in `data/db.json`

## Production note

This package is an executable MVP. Replace JSON persistence and in-memory sessions with PostgreSQL, Redis, secure cookies, migrations, and production identity before a public launch.

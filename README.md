# PetZone Queue Management System

A SaaS-based queue/ticketing system for PetZone pet clinics. Issue number slips, manage live queues, and display "Now Serving" on TV screens — with multi-branch support for admins.

## Features

- **Ticket Kiosk** — Pet owners select a service and get a printed number slip (C001, V002, etc.)
- **Live Display Screen** — TV-friendly view showing now serving and waiting queues
- **Staff Counter Panel** — Call next, serve, complete, skip, or recall tickets
- **SaaS Admin Panel** — Super admin can create organizations and unlimited branches
- **MySQL Database** — Direct SQL import via cPanel phpMyAdmin (no migrations)
- **PetZone Branding** — Logo and clinic-themed UI

## Screens

| Screen | URL | Purpose |
|--------|-----|---------|
| Home | `/` | Landing page with quick links |
| Kiosk | `/kiosk/{org}/{branch}` | Take a ticket |
| Display | `/display/{org}/{branch}` | TV queue display |
| Counter | `/counter/{org}/{branch}` | Staff queue control |
| Admin | `/admin` | Manage orgs, branches, users |

**Demo URLs** (after importing schema):
- Kiosk: `/kiosk/petzone/main`
- Display: `/display/petzone/main`
- Counter: `/counter/petzone/main`

## Setup on cPanel

### 1. Create MySQL Database

1. Log in to **cPanel → MySQL Databases**
2. Create a new database (e.g. `petzone_qms`)
3. Create a database user and assign **ALL PRIVILEGES**
4. Note down: host, database name, username, password

### 2. Import Database Schema

1. Open **cPanel → phpMyAdmin**
2. Select your database
3. Go to **Import** tab
4. Upload `database/schema.sql`
5. Click **Go** — all tables and demo data will be created

**Default admin login:**
- Email: `admin@petzone.com`
- Password: `Petzone@123`

### 3. Deploy Application

#### Option A: Node.js App (cPanel Node.js Selector)

1. Upload the entire `queue-management-system-` folder to your hosting
2. In cPanel → **Setup Node.js App**:
   - Node version: 18+
   - Application root: path to this folder
   - Application URL: your subdomain (e.g. `queue.petzone.com`)
   - Application startup file: `server.js`
3. Set environment variables (from `.env.example`):
   ```
   DB_HOST=localhost
   DB_USER=your_user
   DB_PASSWORD=your_password
   DB_NAME=your_database
   JWT_SECRET=your-random-secret
   PORT=4050
   ```
4. Run **npm install** via terminal or cPanel
5. Start the application

#### Option B: Local Development

```bash
cd queue-management-system-
cp .env.example .env
# Edit .env with your MySQL credentials
npm install
npm start
```

Open http://localhost:4050

## Adding New Branches (SaaS)

1. Log in to `/admin` as super admin
2. Go to **Organizations** → Add Organization (if new client)
3. Go to **Branches** → Add Branch
4. Default services (Consultation, Vaccination, Grooming, Emergency) are auto-created
5. Share the kiosk/display/counter URLs from the **Quick Links** tab

Each branch gets unique URLs:
```
/kiosk/{org-slug}/{branch-slug}
/display/{org-slug}/{branch-slug}
/counter/{org-slug}/{branch-slug}
```

## Ticket Number Format

Tickets reset daily per service type:
- **C001, C002...** — General Consultation
- **V001, V002...** — Vaccination
- **G001, G002...** — Grooming
- **E001, E002...** — Emergency

Prefixes are configurable per service in the database.

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/login` | No | Admin login |
| GET | `/api/admin/organizations` | Yes | List organizations |
| POST | `/api/admin/branches` | Yes | Create branch |
| GET | `/api/queue/public/:org/:branch` | No | Branch info + services |
| POST | `/api/queue/public/:org/:branch/tickets` | No | Issue ticket |
| GET | `/api/queue/public/:org/:branch/status` | No | Live queue status |
| POST | `/api/queue/staff/:branchId/call-next` | Yes | Call next ticket |

## Project Structure

```
queue-management-system-/
├── database/
│   └── schema.sql          ← Import in phpMyAdmin
├── config/
│   └── database.js
├── middleware/
│   └── auth.js
├── routes/
│   ├── auth.js
│   ├── admin.js
│   └── queue.js
├── public/
│   ├── assets/petzonelogo.svg
│   ├── css/styles.css
│   ├── js/app.js
│   ├── index.html
│   ├── kiosk.html
│   ├── display.html
│   ├── counter.html
│   └── admin.html
├── server.js
├── .env.example
└── package.json
```

## License

MIT — PetZone Development Team

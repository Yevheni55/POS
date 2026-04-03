# POS Project Notes

## High-Level Structure

- Root folder contains the static POS frontend, shared client code, PWA files, and global assets.
- `server/` contains the Node.js + Express backend, database access, API routes, middleware, and tests.
- `admin/` contains a separate hash-based SPA for administration and back-office workflows.

## Frontend

- `pos-enterprise.html` is the main cashier UI.
- `login.html` handles staff login.
- `kitchen.html` is the kitchen/KDS interface.
- `api.js` is the shared browser API client.
  It handles auth token storage, offline queueing, request helpers, and fullscreen persistence.
- `js/` contains the main POS logic split into:
  - state management
  - rendering
  - order flows
  - payment flows
  - init/bootstrap
  - mobile behavior
  - general UI helpers
- `css/` contains styling for POS and kitchen views.
- `components/` contains small reusable browser helpers such as toast/loading/confirm.

## Admin

- `admin/index.html` is the admin shell.
- `admin/router.js` implements hash-based navigation with lazy-loaded page modules.
- `admin/pages/` contains operational modules:
  - dashboard
  - menu
  - tables
  - staff
  - reports
  - settings
  - recipes
  - inventory dashboard
  - ingredients
  - suppliers
  - purchase orders
  - supplies
  - stock movements
  - inventory audit
  - write-offs
  - assets
- `admin/admin.css` is a large shared stylesheet for most of the admin UI.

## Backend

- `server/app.js` builds the Express app.
  It mounts middleware, serves static frontend files, and registers API routes.
- `server/server.js` starts HTTP, optional HTTPS, and Socket.IO.
- Backend domains in `server/routes/` include:
  - auth
  - health
  - menu
  - tables
  - orders
  - payments
  - reports
  - shifts
  - discounts
  - print
  - printers
  - events
  - inventory
  - invoice scan
  - ttlock
- Shared backend logic is in:
  - `server/lib/` for audit/events/order queries/stock logic
  - `server/middleware/` for idempotency, validation, and role checks
  - `server/schemas/` for request validation schemas

## Data Model

- `server/db/schema.js` defines the main entities:
  - staff
  - tables
  - menu categories and items
  - shifts
  - discounts
  - orders and order items
  - printers and print queue
  - events and idempotency keys
  - payments
  - ingredients and recipes
  - stock movements
  - suppliers
  - purchase orders and purchase order items
  - inventory audits and items
  - write-offs and items
  - assets and depreciation entries
- `server/db/index.js` is the DB entrypoint.
- `server/db/seed.js` contains seed data/bootstrap data.

## Tests And Infra

- `server/test/` contains backend tests for middleware, schemas, lib modules, routes, and some e2e scenarios.
- `docker-compose.yml` starts Postgres and the app.
- `Dockerfile` builds the server runtime container.

## Key Architectural Characteristics

- POS frontend is mostly static HTML + browser JS without a heavy build step.
- State is partly held in globals, `sessionStorage`, and `localStorage`.
- Shared browser behavior such as auth and offline sync is centralized in `api.js`.
- Backend serves both API and frontend assets from the same application.
- Realtime behavior uses Socket.IO, with some fallback polling in frontend flows.
- Admin is feature-rich and acts like a second large product surface, not a small settings panel.
- Inventory/accounting workflows are a major subsystem, not a minor extension.

## Known Risk Areas To Remember

- Order lifecycle, payments, and stock updates form the most critical business path.
- Inventory workflows are complex: receiving, audits, write-offs, recipes, and asset tracking.
- Admin modules are functionally rich but appear highly coupled at the page-module level.
- Frontend and admin have little visible automated test coverage compared with backend routes/libs.
- Printing, offline queue sync, websocket consistency, and encoding issues deserve extra caution.

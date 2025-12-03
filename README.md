
# Prestige Circle

Monorepo for the CSC309 course project. It includes:
- `course-project/frontend`: React app (Create React App) with routes for events, promotions, transactions, and management interfaces.
- `course-project/backend`: Express/Prisma API server with JWT auth, event/promotions/transactions routes, and AI assistant endpoints.

## Getting Started
1. Clone and install dependencies:
   - Frontend: `cd course-project/frontend && npm install`
   - Backend: `cd course-project/backend && npm install`
2. Environment variables:
   - Backend `.env` (sample keys): `JWT_SECRET`, `DATABASE_URL`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`.
   - Frontend `.env`: `REACT_APP_API_URL` (e.g., `http://localhost:3000`), `REACT_APP_MAPTILER_KEY`.
3. Run:
   - Backend: `cd course-project/backend && npm start`
   - Frontend: `cd course-project/frontend && npm start`

## Features / Notes

1. Role-based interfaces:
  - Regular users: events, promotions, personal transactions (history, transfer, redemption).
  - Cashiers: create purchases for students, process redemptions.
  - Managers / Superusers: view all transactions with filters, create adjustments, view users.

2. AI Assistant:
  - Uses Gemini via GEMINI_API_KEY for chat.
  - Can optionally use ElevenLabs for text-to-speech if keys are provided.

3. Maps:
  - Uses MapTiler via REACT_APP_MAPTILER_KEY for map tiles in event-related views.

4. Security:
  - JWT-based auth, bearer tokens sent via Authorization: Bearer <token>.
  - Role checks in backend endpoints for cashier/manager/superuser-only routes.

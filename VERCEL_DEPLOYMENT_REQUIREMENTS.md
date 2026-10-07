# Vercel deployment requirements for Taskflow

This project is an Expo React Native app with a separate Express API. It is not a standard Vercel-ready Next.js app, so a few requirements must be met before deployment.

## 1) Project type and runtime

- Vercel project should be configured as a web app, not a native mobile app.
- Use Node.js 20.x or newer.
- Expo web must be built with the web target (`expo export --platform web`).

## 2) Install and build requirements

Root project dependencies are defined in `package.json` and include Expo + React Native Web.

Required install command:

```bash
npm install
```

Required build command:

```bash
npx expo export --platform web
```

Required output directory:

```text
dist
```

This app is designed for web export, not a native mobile build on Vercel.

## 3) Environment variables

Frontend web app:

```env
EXPO_PUBLIC_API_URL=https://your-api-domain.com
```

If the backend is deployed separately, this must point to the live API URL.

Backend API (`server/`):

```env
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/<database>
MONGODB_DB=todo
PORT=4000
```

Important: these variables are required by the Express API in `server/index.js`.

## 4) Backend hosting requirement

The current backend is a standalone Express server in `server/index.js`.

Vercel can host a web frontend, but the existing `server/` app will not run directly on Vercel without being adapted to:

- a Vercel Serverless API route, or
- a separate backend host such as Render, Railway, Fly.io, or another Node service.

For production, either:

1. keep the frontend on Vercel and host the API elsewhere, or
2. move the API into a Vercel-compatible serverless structure (`api/` directory or equivalent), then update CORS and environment configuration.

## 5) CORS requirements

The API must allow requests from the Vercel frontend domain.

The backend currently uses:

```js
app.use(cors());
```

This should be restricted to the production frontend origin before launch.

Example:

```js
app.use(cors({ origin: ['https://your-vercel-app.vercel.app', 'https://your-custom-domain.com'] }));
```

## 6) MongoDB requirement

The app depends on a MongoDB Atlas connection string.

Required:

- valid `MONGODB_URI`
- database name provided via `MONGODB_DB` (defaults to `todo`)
- database user with read/write permissions to the target collection

## 7) Example Vercel config

This is a safe starting configuration for the frontend build:

```json
{
  "framework": "expo",
  "buildCommand": "npx expo export --platform web",
  "outputDirectory": "dist"
}
```

If the API is also moved to Vercel, add serverless routing and set API environment variables in the Vercel dashboard.

## 8) Minimum checklist before launch

- [ ] Node 20+ is selected in Vercel
- [ ] `npm install` succeeds
- [ ] `npx expo export --platform web` succeeds
- [ ] `dist/` is used as the deploy output
- [ ] `EXPO_PUBLIC_API_URL` is set to the deployed API URL
- [ ] `MONGODB_URI` is set in the backend environment
- [ ] API CORS allows the Vercel frontend origin
- [ ] Production API is reachable from the deployed web app

## 9) Important warning

This project is not a plain static site. It is a web build of a React Native app plus a backend service. The app will only be deployable on Vercel after the backend is either hosted separately or migrated into a Vercel-compatible form.

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

## 4) Deploying the backend on Vercel

The Express backend is configured for Vercel's zero-configuration Express support. Its entry point is `server/index.js`, and it exports the Express app for Vercel while retaining the normal `npm start` listener for local development.

Create a **separate Vercel project** for the backend and configure:

- **Root Directory:** `server`
- **Framework Preset:** Express (or Other if Express is not detected)
- **Build Command:** leave the Vercel default, or use `npm run build`
- **Install Command:** `npm install`
- **Output Directory:** leave unset

Do not use the Expo web build command or the root project directory for this backend deployment. No custom `vercel.json` routing is required for the Express backend.

Set these environment variables in the backend Vercel project's Production (and Preview, if used) environments:

```env
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/<database>
MONGODB_DB=todo
```

`PORT` is only used for local development; Vercel supplies the HTTP runtime. After deployment, check `https://<your-backend-domain>/health`, then set the frontend project's `EXPO_PUBLIC_API_URL` to `https://<your-backend-domain>` (no trailing slash).

## 5) CORS requirements

The backend currently allows cross-origin requests. For production, optionally set `CORS_ORIGINS` in the backend project to a comma-separated list of allowed frontend origins:

```env
CORS_ORIGINS=https://your-vercel-app.vercel.app,https://your-custom-domain.com
```

## 6) MongoDB requirement

The app depends on a MongoDB Atlas connection string.

Required:

- valid `MONGODB_URI`
- database name provided via `MONGODB_DB` (defaults to `todo`)
- database user with read/write permissions to the target collection

## 7) Frontend deployment is separate

The Expo web app and Express API should be deployed as separate Vercel projects. Configure the frontend project to build the Expo web export into `dist`; configure the backend project as described above with `server` as its root directory. Set `EXPO_PUBLIC_API_URL` on the frontend project to the deployed backend origin.

## 8) Minimum checklist before launch

- [ ] Node 20+ is selected in Vercel
- [ ] `npm install` succeeds
- [ ] `npx expo export --platform web` succeeds
- [ ] `dist/` is used as the deploy output
- [ ] `EXPO_PUBLIC_API_URL` is set to the deployed API URL
- [ ] The backend Vercel project uses `server` as its root directory
- [ ] `MONGODB_URI` is set in the backend project's environment
- [ ] The backend `/health` endpoint responds successfully
- [ ] Production API is reachable from the deployed web app

## 9) Important warning

This repository contains two separately deployed projects: an Expo web frontend and an Express API. Deploy each from its own Vercel project with the appropriate root directory and environment variables.

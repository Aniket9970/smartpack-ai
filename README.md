# SmartPack AI

SmartPack AI is a Vite + React single-page app that recommends packaging dimensions, filler, and board thickness, then visualizes product vs. box geometry in 3D. The model runs fully in-browser; no separate model hosting is needed.

## What is it
SmartPack AI guides a user from product inputs to a packaging recommendation, shows the fit in 3D, estimates material + filler cost, and lets them save or delete reports.

## How it works
- Users enter product dimensions, weight, fragility, and branding; sustainability and optimization preferences adjust messaging.
- `predictPackaging` in `src/model/smartModel.js` applies pre-trained weights to estimate box dimensions, thickness level, utilization, and void percent.
- Costing uses GSM-based board weight plus filler weight: surface area × GSM × scrap factor → ₹/kg rates by material tier, plus lightweight filler.
- `src/App.jsx` renders the 3D scene, results, cost breakdown, and report save/delete flows.
- Auth is via Clerk (publishable key). Reports persist to Supabase when env vars are set; otherwise the app runs client-only.

## Key files
- `src/App.jsx`: routes, UI flow, 3D visualization, costing, Supabase report save/delete
- `src/model/smartModel.js`: ML weights, predictions, local feedback storage
- `src/index.css`: styling
- `src/supabaseClient.js`: optional Supabase client from env
- `vite.config.js`, `eslint.config.js`: build and lint config

## Development
- Install: `npm install`
- Dev server: `npm run dev`
- Lint: `npm run lint`
- Production build: `npm run build`

## Environment
Set these in `.env` (local) or hosting dashboard:
- `VITE_CLERK_PUBLISHABLE_KEY`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## Deployment (Vercel, free tier)
- From the project root, run `vercel link` and create a new project when prompted.
- Add env vars: `vercel env add VITE_CLERK_PUBLISHABLE_KEY`, `vercel env add VITE_SUPABASE_URL`, `vercel env add VITE_SUPABASE_ANON_KEY` (choose Production, optionally Preview).
- Deploy: `vercel --prod` (auto-detects Vite; build `npm run build`, output `dist`).
- For redeploys, rerun `vercel --prod`.

## Notes
- The model and visualization are client-side; no backend is required unless you enable Supabase reports.
- Keep `.env` local and out of version control; `node_modules/` should remain gitignored.

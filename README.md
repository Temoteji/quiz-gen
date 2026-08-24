# Notes → Quiz

Paste study notes in — or upload a photo of your notes or a PDF — and get a
5-question quiz out. First 3 quizzes are free per visitor; after that, a
Stripe paywall unlocks unlimited access for $4.99 (one-time payment). The AI
key and Stripe key both live on the server only.

## How the file upload works

Claude's API can read images and PDFs directly — no separate OCR step
needed. When you upload a file:
1. The browser sends it to `/api/generate-quiz-file` as `multipart/form-data`
   (handled server-side by `multer`, which keeps the file in memory rather
   than writing it to disk).
2. The server checks the file type (JPG/PNG/WEBP/GIF/PDF only) and size
   (10MB max) before doing anything else.
3. The file is base64-encoded and sent to Claude as an `image` or `document`
   content block, alongside the same instruction used for pasted text.
4. Claude reads the image or PDF directly and returns the same JSON quiz
   format as the text flow — so everything downstream (paywall, scoring,
   UI) is unchanged.

## How access control works

- Each visitor gets a signed, httpOnly cookie tracking how many free quizzes
  they've used. Signed means the browser can't just edit the cookie value to
  cheat — the server would detect the tampering.
- After 3 free quizzes, the frontend shows an upgrade screen instead of the
  quiz form.
- Clicking "Upgrade" creates a Stripe Checkout session and redirects to
  Stripe's hosted payment page (your server never touches card numbers).
- After payment, Stripe redirects back to your app's `/success` route with a
  session ID. The server verifies that session directly with Stripe's API
  (never trusting the redirect alone) before setting a `pro=true` cookie
  that unlocks unlimited quizzes.

## Part 1 — Get your API keys

**Anthropic API key** (if you don't already have one):
[console.anthropic.com](https://console.anthropic.com) → Settings → API
Keys. You'll need billing set up on the Console — this is separate from a
Claude.ai subscription.

**Stripe secret key:**
1. Create a free account at [stripe.com](https://stripe.com).
2. In the Dashboard, make sure you're in **Test mode** (toggle top-right) —
   this lets you test payments with fake cards before going live.
3. Go to Developers → API keys → copy the **Secret key** (starts with `sk_test_`).
4. When you're ready to accept real payments, switch to Live mode and repeat
   to get your live secret key (starts with `sk_live_`).

**Cookie secret:** just make up any long random string yourself — it's used
to sign cookies so they can't be forged. Example: mash your keyboard for 30
characters.

## Part 2 — Run it locally first

1. Install [Node.js](https://nodejs.org) v18+.
2. In this folder:
   ```
   npm install
   cp .env.example .env
   ```
3. Fill in `.env` with your real keys.
4. Start it:
   ```
   npm start
   ```
5. Open `http://localhost:3000`. Generate 3 quizzes to trigger the paywall,
   click Upgrade, and pay with a Stripe **test card**: `4242 4242 4242 4242`,
   any future expiry date, any CVC, any ZIP. You should land back on the app
   with unlimited access.

## Part 3 — Push to GitHub

1. Go to [github.com](https://github.com) → New repository → name it
   (e.g. `notes-to-quiz`) → Create repository. Leave it empty (no README,
   no .gitignore — you already have those).
2. In this project folder, run:
   ```
   git init
   git add .
   git commit -m "Notes to Quiz with Stripe paywall"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/notes-to-quiz.git
   git push -u origin main
   ```
   (GitHub shows you this exact set of commands on the empty repo page —
   use those if they differ slightly.)
3. Your `.env` file will NOT be pushed — `.gitignore` excludes it on
   purpose, since it holds your real secret keys.

## Part 4 — Deploy on Render

1. Go to [render.com](https://render.com) and sign up (you can sign in
   with GitHub directly).
2. Dashboard → New → Web Service.
3. Connect your GitHub account if prompted, then select your
   `notes-to-quiz` repository.
4. Fill in:
   - **Name:** anything, e.g. `notes-to-quiz`
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free is fine to start
5. Scroll to **Environment Variables** and add each one:
   | Key | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your real Anthropic key |
   | `STRIPE_SECRET_KEY` | your Stripe secret key (test or live) |
   | `COOKIE_SECRET` | your made-up random string |
6. Click **Create Web Service**. Render will install dependencies, start
   the server, and give you a live URL like `notes-to-quiz.onrender.com`.
7. Visit it. Test the same free-quiz-then-upgrade flow as before. If you
   used a `sk_test_` Stripe key, keep using the `4242...` test card — real
   cards won't work in test mode (and that's exactly what you want while
   you're still checking everything works).

**Note on Render's free tier:** free web services spin down after periods
of inactivity and take ~30-50 seconds to wake up on the next visit. Fine
for testing and early sharing; worth upgrading to a paid instance once you
have real users who'd be annoyed by the wait.

## Part 5 — Go live for real money

1. In Stripe, switch to **Live mode** and grab your live secret key
   (`sk_live_...`).
2. In Render, update the `STRIPE_SECRET_KEY` environment variable to the
   live key, and redeploy (Render does this automatically when you change
   an env var).
3. Stripe will also want some basic business details (bank account, etc.)
   before it pays out real charges to you — it'll prompt you for this in
   the Dashboard.
4. From here on, real cards will be charged real money. Test once more
   yourself with a real card for $4.99 before sharing the link widely.

## Cost awareness

Every quiz generated costs a small amount against your Anthropic balance,
regardless of whether the visitor is on the free tier or has paid. The free
tier is capped at 3 per visitor specifically to keep this bounded. Keep an
eye on usage in the Anthropic Console, especially in the first weeks after
sharing the link publicly.

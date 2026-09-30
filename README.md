# ML4T Study

A study tool for the CS 7646 (ML4T) exam question pool. It's a static site with no build step. Hosted with Supabase, it adds accounts and cross-device sync, and the question pool is served only to signed-in users. Without Supabase, it runs locally from `index.html`.

## Features

- **Practice exams**: Exam 1 (ML1 + QF1) and Exam 2 (ML2 + QF2). Each has 40 questions (2 per domain × 20 domains), 90 minutes, and 200 points graded per statement. Optional settings:
  - **Strict timing**: the clock keeps running when you leave the page.
  - **No going back**: forward-only navigation.
  - Warnings at 10 and 5 minutes left.
- **Confidence marking**: tap `?` (or press `G`) next to any answer to mark it as a guess. Guessed statements go into review even when they're right. A confident wrong answer is flagged as a *misconception*.
- **Statement flashcards**: review one statement at a time. Choose due statements, everything you've missed or guessed, or only your misconceptions.
- **Spaced review**: missed or guessed questions and statements come back after 1, 3 and 7 days until you answer them confidently and correctly.
- **Daily 5**, **domain drill** (with a *reversed-only* filter), and **browse & search** across every question, statement and explanation, with answer keys.
- **Notes** on any question. They reappear whenever the question comes back.
- **Stats**:
  - projected exam score with a 90% range;
  - accuracy per domain and per topic group;
  - calibration (confident vs. guessed accuracy);
  - accuracy on reversed vs. normal questions;
  - exam history with full answer review.

Keyboard shortcuts: `T`/`F` answer, `G` guess, `↑`/`↓` move between statements, `←`/`→` change question, `Enter` check/next, `P` pin, `/` search (on the Browse page).

## How progress is stored

Every answered question or flashcard is saved as one entry in an append-only attempt log. All stats and review schedules are recalculated from that log. With sync enabled, two devices merge by combining their logs, so studying offline on both devices loses nothing. Pins, notes and settings keep whichever version changed most recently. In-progress exams and practice sessions stay on the device where you started them.

Without sync, progress lives in the browser's localStorage. **Stats → Export progress** saves a backup file, and **Import** merges one back in.

## Setup: accounts, sync and the protected question pool (Supabase)

The question pool is never part of the website. It lives in your Supabase database, and only signed-in users can read it. Visitors see a sign-in screen. After sign-in the pool downloads once and is cached on the device, and it's removed from the device on sign-out.

1. Create a free project at <https://supabase.com>.
2. Open **SQL Editor** in the dashboard, paste in `supabase/schema.sql`, and run it. This creates two tables, both protected by row-level security:
   - `progress`: each user can read and write only their own row.
   - `question_pool`: signed-in users can read it, and nobody can write to it except with the service key.
3. Generate and upload the pool from your computer. The service-role key is secret: never put it in `js/config.js` or commit it.
   ```sh
   pip install pymupdf
   python tools/parse_pool.py "path/to/ML4T Exam Question Pool.pdf"   # writes private/questions.json
   export SUPABASE_URL="https://<project>.supabase.co"
   export SUPABASE_SERVICE_ROLE_KEY="<Project Settings → API → service_role key>"
   python tools/upload_pool.py
   ```
   Re-run the upload after regenerating the pool. Devices re-download only when the content has changed.
4. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key into `js/config.js`. The anon key is meant to be public; row-level security is what protects the data.
5. Go to **Authentication → URL Configuration** and set **Site URL** to wherever you host the app, e.g. `https://yourname.github.io/ml4t-study/`. Add the same URL under **Redirect URLs**. Confirmation and password-reset emails link back there.

**Who can sign up:** by default anyone can create an account and read the pool. To limit access, either:
- turn off **Allow new users to sign up** (Authentication → Sign In / Providers) and invite people from **Authentication → Users**, or
- use the email-domain policy in `schema.sql` (e.g. `@gatech.edu` only).

Supabase's built-in email service is rate-limited to a few emails per hour. For more users, add your own SMTP server under **Authentication → Emails → SMTP settings**.

### Hosting

Deploy from git so that `private/`, which is git-ignored, is never uploaded:

- **GitHub Pages**: push this folder to a repo, then go to **Settings → Pages → Deploy from branch**.
- **Netlify / Cloudflare Pages / Vercel**: connect the repo. There's no build command, and the output directory is `/`.

Don't drag and drop the folder onto a host. That would upload `private/questions.js` with it.

### Running locally without Supabase

Leave `js/config.js` empty and open `index.html`. The app loads the pool from `private/questions.js`, and progress stays in that browser. There's no sign-in in this mode.

## Rebuilding the question data

`tools/parse_pool.py` writes `private/questions.json`, which gets uploaded, and `private/questions.js`, which local mode uses. `tools/overrides.json` holds hand fixes for equations that the PDF's text layer garbles. Each fix was checked against the rendered page. The parser reports any fix that no longer matches, so check its output when a new revision of the pool comes out.

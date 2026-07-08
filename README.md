```markdown
# Site tracker fetch bot

Runs on a schedule (free, via GitHub Actions), pulls growth and physical-risk signals from
several UK data sources, and writes them straight into a Google Sheet as five columns:
**Business | Category | Location | Region | Source link.** Region is North/South, using the
same broad-area keyword matching as the tracker artifact, so a location classifies the same
way whether it's typed into the tracker or fetched by this bot.

## The category taxonomy

Every row gets classified into exactly one of these (edit `classifyCategory()` in
`fetch-signals.mjs` to tune the keyword matching):

**Growth:**
- New site opening
- Relocation
- Revamp/refurbishment
- Physical premises change

**Risk:**
- Burglary
- Robbery/attack
- Physical security risk

- Uncategorised (fallback — nothing matched)

## The data sources, and what each one is actually good and bad at

- **Google News RSS (growth queries)** — free, catches announcements and press coverage of
  openings, relocations, and refurbishments. Unofficial endpoint, could change without notice.
- **Google News RSS (risk queries)** — free, catches news coverage of burglaries, robberies, and
  vandalism at named businesses. This is the primary source for the risk side of the sheet,
  specifically *because* news articles name the business and link to a source — see the
  data.police.uk note below for why that data doesn't work here despite being more "official."
- **Adzuna job postings** — free (1,000 calls/month), catches "pre-opening team," "launch team,"
  "grand opening manager" listings. **The `JOB_TITLES` array near the top of `fetch-signals.mjs`
  is meant for you to edit** — add or remove job titles freely. This is the one part of the
  pipeline built for your ongoing input, since generic titles won't match every industry.
- **Companies House SIC-code sweep** — free (needs an API key), fully automatic, no manual input.
  Noisier than the other sources: most new incorporations are single-site startups, and the
  registered office address is often an accountant's office, not the trading site.
- **Food Standards Agency (FSA) new registrations** — free, no key needed, food/hospitality only.
  **Real limitation, not a corner case**: the FSA API has no "sort by newest" option at all —
  the only sort keys it supports are relevance, rating, and alphabetical. This pulls a same-shaped
  sample of "awaiting inspection" businesses each run (a reasonable proxy for "recently
  registered," since inspections follow registration) and relies on de-duplication against
  `seen.json` to slowly surface genuinely new ones over time. It is a sample, not an exhaustive
  feed of every new UK food business.

## What's deliberately NOT included, and why

**data.police.uk (official UK crime API)** was seriously considered for the risk side, and it's
genuinely the most authoritative free UK crime data source — burglary, robbery, criminal damage,
by category, official police data. It is **not used here** because its records don't include a
business name or an article link at all — just an anonymised street-level point, a crime
category, and a month. It literally cannot populate two of your four required columns. If you
want a secondary, non-name-linked crime-density layer later (e.g. "here's how much burglary
happens generally in this postcode area"), that's a separate feature to build, not a drop-in
addition to this sheet.

## Setup (roughly 25–35 minutes — Google Sheets adds real setup time vs. the email-only version)

### 1. Create the Google Sheet and a Google Cloud service account

This is the part that takes the most time. You're creating a "robot" Google account that's
allowed to write to your Sheet, without giving the bot your actual Google login.

1. Create a new Google Sheet (or use an existing one). Note its **Sheet ID** — it's the long
   string in the URL between `/d/` and `/edit`, e.g.
   `https://docs.google.com/spreadsheets/d/`**`1AbC-dEfGhIjKlMnOpQrStUvWxYz`**`/edit`
2. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project
   (top-left project dropdown → New Project). Name doesn't matter.
3. In the project, go to **APIs & Services → Library**, search for "Google Sheets API", and
   click **Enable**.
4. Go to **APIs & Services → Credentials → Create Credentials → Service Account**. Give it any
   name (e.g. "site-tracker-bot"). Skip the optional role-granting step, click Done.
5. Click into the service account you just created → **Keys** tab → **Add Key → Create new key →
   JSON**. This downloads a `.json` file — this is the credential. Keep it safe, don't commit it
   to the repo directly (it goes into a GitHub secret instead, see below).
6. Open that downloaded JSON file, copy the `"client_email"` value (looks like
   `something@your-project.iam.gserviceaccount.com`).
7. Go back to your Google Sheet, click **Share**, and share it with that email address as an
   **Editor**. This is the step that actually grants the bot write access.

### 2. Create the repo
Create a new **private** GitHub repository. Upload these files, preserving structure:
```
your-repo/
├── fetch-signals.mjs
├── package.json
├── seen.json
└── .github/
    └── workflows/
        └── fetch-signals.yml
```

### 3. Add GitHub Secrets
**Settings → Secrets and variables → Actions → New repository secret**:

| Secret name | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The **entire contents** of the JSON file from step 1.5, pasted as one secret |
| `GOOGLE_SHEET_ID` | The Sheet ID from step 1.1 |
| `COMPANIES_HOUSE_API_KEY` | Free key at https://developer.company-information.service.gov.uk/ |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | Free registration at https://developer.adzuna.com/ |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` / `DIGEST_TO_EMAIL` | Optional — only for a short "N rows added" notification email. See below for the App Password steps if you want this. |

The email notification is now just a short ping, not the main output — the Sheet is where the
actual data lives. Skip the Gmail secrets entirely if you don't want the notification at all;
the script checks for them and just skips sending if they're not set.

### 4. Enable Actions and test manually
**Actions** tab → find "Fetch site tracker signals" → **Run workflow**. Check the logs, then
check your Google Sheet for new rows.

### 5. Adjust the schedule
Default is 07:00 UTC daily in `.github/workflows/fetch-signals.yml` — edit the cron line to
change timing.

## Job titles for the Adzuna search

The `JOB_TITLES` array near the top of `fetch-signals.mjs` is maintained on your behalf —
send the full list of titles you want tracked, and they get added to this array in the code.
You don't need to touch the file yourself for this.

## Fixes made after the first live run

The first real run surfaced three problems, now fixed:

1. **Old articles.** Google News RSS was returning items up to a year old. Fixed two ways:
   `when:90d` is added to every query (an unofficial but well-documented Google News operator
   restricting results to the last 90 days), plus an independent check on each article's
   published date that drops anything older than 90 days regardless — this second check exists
   because `when:` isn't officially documented and could silently stop working; the date check
   doesn't depend on Google honouring anything.
2. **Single-shop noise** (e.g. a lone corner-shop robbery with no chain behind it). Added a
   multi-site relevance filter: a growth/risk article only makes it into the sheet if either its
   company name resolved via a strong chain-suffix pattern (Ltd/Group/plc — sole traders rarely
   register this way) or the article text itself contains explicit multi-site language ("chain,"
   "branches," "nationwide," "third store," etc.). **This is a heuristic, not a real site-count
   lookup** — there's no data source here that actually knows how many locations a business has.
   It will still occasionally let a single-site story through, and it will drop some genuine
   multi-site stories that happen to be phrased without any of these cues (a single-word brand
   name like "Chipotle" or "Amazon" with no chain-language nearby won't pass unless the article
   happens to mention "chain" or a store count) — this trades recall for less noise, on purpose.
3. **Business names not resolving.** Broadened the extraction patterns to catch company names
   that aren't the first word of a headline, and to catch single-word brand names (previously the
   pattern required at least two capitalized words). Still not perfect — headlines are genuinely
   inconsistent in structure — but meaningfully fewer "(unresolved — check manually)" rows than
   before.

## Known limitations, stated plainly

- **No live testing was done against the actual Google Sheets, Companies House, Adzuna, or FSA
  endpoints before handing this over** — this was built in a sandboxed environment that couldn't
  reach any of these. Every function was checked for correct syntax, correct method calls against
  the actual installed libraries, and correct response-parsing logic against realistic sample
  data pulled from each service's own documentation — but watch the first several runs' logs and
  Sheet output closely rather than trusting it blindly.
- Google News RSS is unofficial and could change format without notice.
- The FSA source is a sample of "awaiting inspection" businesses, not a complete new-registration
  feed — see the data sources section above.
- No LinkedIn coverage — no cheap, ToS-safe way to automate that.
```

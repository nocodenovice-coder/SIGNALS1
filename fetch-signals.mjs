import { XMLParser } from 'fast-xml-parser';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

const SEEN_PATH = path.join(process.cwd(), 'seen.json');
// This run's newly-seen GUIDs are written here rather than merged into seen.json directly.
// seen.json is committed once per day by many runs over time, and two runs' local edits to
// the same JSON array used to produce real git merge conflicts on `git pull --rebase`. The
// merge-seen.mjs script (invoked by the workflow, not this script) is the sole writer of
// seen.json: it re-fetches the latest seen.json from origin and unions it with this file's
// contents at JSON level, so git itself never has to reconcile diverging edits to the file.
const NEW_GUIDS_PATH = path.join(process.cwd(), 'new-guids.json');

// =========================================================================
// CATEGORY TAXONOMY — every item gets classified into exactly one of these.
// Edit the keyword regexes below (in classifyCategory) to tune matching.
// =========================================================================
const CATEGORIES = {
  NEW_SITE: 'New site opening',
  RELOCATION: 'Relocation',
  REVAMP: 'Revamp/refurbishment',
  PHYSICAL_CHANGE: 'Physical premises change',
  BURGLARY: 'Burglary',
  ROBBERY_ATTACK: 'Robbery/attack',
  SECURITY_RISK: 'Physical security risk',
  UNCATEGORISED: 'Uncategorised',
};

function classifyCategory(text) {
  const lower = text.toLowerCase();

  if (/\bburglar(y|ised|ized)?\b|\bbreak(- |-)?in\b|broke into|ram raid/.test(lower)) return CATEGORIES.BURGLARY;
  if (/\brobb(ery|ed)\b|held up at|armed raid|\battack(ed)?\b.{0,20}(staff|shop|store|premises|customer)/.test(lower)) return CATEGORIES.ROBBERY_ATTACK;
  if (/vandal(ism|ised|ized)?|arson|smash and grab|security breach/.test(lower)) return CATEGORIES.SECURITY_RISK;

  if (/relocat(ing|ed|ion)|has moved to|moving to (a )?new (site|premises|location)/.test(lower)) return CATEGORIES.RELOCATION;
  if (/revamp|refurbish(ment|ed)?|renovat(ion|ed)|redevelop(ment|ed)?|reconstruct(ion|ed)?/.test(lower)) return CATEGORIES.REVAMP;
  if (/extension|expansion of (the )?(building|premises)|structural change|redesign(ed)? (the )?(store|site|premises)|refit/.test(lower)) return CATEGORIES.PHYSICAL_CHANGE;
  if (/\bopen(ed|ing|s)?\b(?:\s+\w+){0,4}\s+(site|store|branch|location|nursery|clinic|gym)\b/.test(lower)) return CATEGORIES.NEW_SITE;
  if (/pre-opening|launch team|grand opening/.test(lower)) return CATEGORIES.NEW_SITE;

  return CATEGORIES.UNCATEGORISED;
}

// Google News RSS titles are formatted "Headline - Publisher Name". Strip the trailing
// " - Publisher" segment before any classification/extraction runs on the title — otherwise
// a publisher name that happens to end in "plc"/"Group" (e.g. "... - Reach plc") can be
// mistaken for the business itself by the chain-suffix pattern below.
function stripSource(title) {
  const m = title.match(/^(.*)\s+-\s+([^-]+)$/);
  if (m && m[2].length <= 40) return m[1].trim();
  return title;
}

const NAME_WORD = `[A-Z][A-Za-z0-9&'.]*`;
const NAME_CONNECTOR = `(?:&|and|of|A)`;
// A run of capitalized "words" allowing short connectors through, so multi-word brand names
// like "Pret A Manger" or "Marks & Spencer" aren't truncated at the connector.
const COMPANY_NAME = `${NAME_WORD}(?:\\s+(?:${NAME_WORD}|${NAME_CONNECTOR})){0,4}`;

const TRIGGER_VERBS = 'is|has|opens?|opened|opening|expands?|expanding|announces?|announced|hiring|relocat\\w*|to open|confirms?|confirmed|plans?|planned|reveals?|revealed|unveils?|unveiled|moves?|moved|moving';
const PREMISES_NOUNS = 'store|shop|branch|site|outlet|restaurant|café|cafe|depot|centre|center|facility|warehouse|premises|unit|clinic|gym|nursery|supermarket|superstore|showroom';

const NON_COMPANY_WORDS = /^(The|New|UK|This|That|Local|Police|Officers?|Detectives?|Council|First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|A|An|In|On|At|Man|Woman|Following|After|Before|During|Nationwide|One|Two|Three)\b/;

function isPlausibleCompanyName(candidate) {
  return !!candidate && !NON_COMPANY_WORDS.test(candidate);
}

// Layered fallback: each pattern is lower-confidence than the last. Supports single-word
// brand names (Amazon, Chipotle) as well as multi-word company names — a pattern doesn't
// need a Ltd/Group/plc suffix to match, it just needs to sit next to a recognisable trigger.
function extractCompany(rawText) {
  const text = stripSource(rawText);

  // 1. Strong chain-suffix pattern (Ltd/Limited/Group/plc/LLP) — highest confidence, matches
  // anywhere in the text.
  let m = text.match(new RegExp(`(${COMPANY_NAME})\\s+(Ltd|Limited|Group|plc|PLC|LLP)\\b`));
  if (m) return `${m[1]} ${m[2]}`.trim();

  // 2. Company name at the very start of the headline, directly followed by a trigger verb.
  m = text.match(new RegExp(`^(${COMPANY_NAME})\\s+(?:${TRIGGER_VERBS})\\b`));
  if (m && isPlausibleCompanyName(m[1])) return m[1].trim();

  // 3. Company name at the start, followed by a premises noun, then a trigger verb —
  // e.g. "Costa Coffee store opens in Brighton", "Tesco Express store to open in Leeds".
  m = text.match(new RegExp(`^(${COMPANY_NAME})\\s+(?:${PREMISES_NOUNS})\\s+(?:${TRIGGER_VERBS})\\b`));
  if (m && isPlausibleCompanyName(m[1])) return m[1].trim();

  // 4. "New <Company> [premises noun] <trigger>" — company preceded by a leading filler word.
  m = text.match(new RegExp(`^(?:New|A new|The new)\\s+(${COMPANY_NAME})\\s+(?:(?:${PREMISES_NOUNS})\\s+)?(?:${TRIGGER_VERBS})\\b`));
  if (m && isPlausibleCompanyName(m[1])) return m[1].trim();

  // 5. Company name anywhere, directly followed by a trigger verb (mid-headline, e.g.
  // "Third UK store for Acme Retail opens in Leeds").
  m = text.match(new RegExp(`\\b(${COMPANY_NAME})\\s+(?:${TRIGGER_VERBS})\\b`));
  if (m && isPlausibleCompanyName(m[1])) return m[1].trim();

  // 6. "at <Company> branch/store" — common phrasing in burglary/robbery headlines where the
  // business isn't the grammatical subject. Lower confidence: risks false positives on
  // capitalized place names ("at Oxford Street store"), but resolves a real class of risk
  // headlines that would otherwise always be unresolved.
  m = text.match(new RegExp(`\\bat\\s+(${COMPANY_NAME})\\s+(?:${PREMISES_NOUNS})\\b`));
  if (m && isPlausibleCompanyName(m[1])) return m[1].trim();

  return '(unresolved — check manually)';
}

// ---- Multi-site relevance filter ----
// Applied to news-derived items only (growth + risk RSS). Purpose: exclude one-off stories
// about single independent premises (a lone corner shop robbery, a single café opening) that
// aren't useful signals for a business whose target is established or scaling multi-site
// operators. This is a heuristic, not a lookup against real site-count data — it passes an
// item through if EITHER the company name resolved via a strong chain-suffix pattern
// (Ltd/Group/plc — companies structured this way are far more often multi-site than sole
// traders) OR the text itself contains explicit multi-site language. It will still let some
// single-site stories through and may drop a few genuine multi-site items that happen to be
// phrased without any of these cues — it trades recall for less noise, on purpose, per what
// was asked for.
function isLikelyMultiSite(text) {
  const hasStrongCompanySuffix = /\b(Ltd|Limited|Group|plc|PLC|LLP)\b/.test(text);
  const lower = text.toLowerCase();
  const hasMultiSiteLanguage = /\bchain\b|\bfranchise\b|\bnationwide\b|\bacross the uk\b|\bbranches\b|\boutlets\b|\bstores? (nationwide|across)|\bthe retailer\b|\bsupermarket chain\b|\bmulti-?site\b|\b(1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:\w+\s+){0,2}(site|store|branch|location|shop|outlet)\b/.test(lower);
  return hasStrongCompanySuffix || hasMultiSiteLanguage;
}

const UK_AREAS = [
  'scotland','glasgow','edinburgh','aberdeen','dundee','belfast','northern ireland',
  'newcastle','sunderland','durham','middlesbrough','manchester','liverpool','preston',
  'blackpool','leeds','sheffield','bradford','hull','york','birmingham','nottingham',
  'leicester','derby','coventry','wolverhampton','stoke','london','brighton','reading',
  'oxford','southampton','portsmouth','bristol','bath','exeter','plymouth','bournemouth',
  'norwich','ipswich','cambridge','peterborough','cardiff','swansea','wrexham','watford',
  'milton keynes','northampton','luton','swindon','kent','sussex','surrey','essex',
  'hertfordshire','yorkshire','lancashire','merseyside','cumbria','wales','midlands',
];

function extractLocation(text) {
  const lower = text.toLowerCase();
  for (const area of UK_AREAS) {
    if (new RegExp(`\\b${area}\\b`, 'i').test(lower)) {
      return area.replace(/\b\w/g, c => c.toUpperCase());
    }
  }
  return '(unresolved — check manually)';
}

// ---- North/South region — same broad-area approach as the tracker artifact, kept ----
// consistent between the two pieces on purpose so a location classifies the same way
// whether it's typed into the tracker or fetched by this bot.
const REGION_NORTH = [
  'scotland','glasgow','edinburgh','aberdeen','dundee','inverness','stirling','perth','ayr','paisley','kirkcaldy',
  'northern ireland','belfast',
  'north east','newcastle','sunderland','durham','gateshead','middlesbrough','darlington','teesside','tyneside','hartlepool',
  'north west','manchester','liverpool','preston','blackpool','bolton','stockport','warrington','wigan','salford',
  'oldham','rochdale','burnley','blackburn','lancaster','carlisle','cumbria','merseyside','greater manchester','lancashire',
  'yorkshire','leeds','sheffield','bradford','hull','york','wakefield','doncaster','rotherham','barnsley','halifax','huddersfield',
  'north wales','wrexham','bangor',
  'birmingham','west midlands','east midlands','nottingham','leicester','derby','coventry','wolverhampton','stoke','stafford','telford','shrewsbury','worcester','lincoln','grimsby','scunthorpe',
];
const REGION_SOUTH = [
  'london','greater london',
  'south east','brighton','reading','oxford','guildford','southampton','portsmouth','canterbury','maidstone','basingstoke','slough','luton',
  'south west','bristol','bath','exeter','plymouth','gloucester','bournemouth','swindon',
  'east of england','east anglia','norwich','ipswich','cambridge','peterborough','colchester','chelmsford','southend','milton keynes','northampton',
  'south wales','cardiff','swansea',
  'home counties','kent','sussex','surrey','essex','hertfordshire','watford',
];

function extractRegion(text) {
  const lower = text.toLowerCase();
  for (const kw of REGION_SOUTH) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(lower)) return 'South';
  }
  for (const kw of REGION_NORTH) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(lower)) return 'North';
  }
  return 'Unclassified';
}

const GROWTH_QUERIES = [
  '"new site" opening UK',
  '"opens its" site OR store OR branch UK',
  '"flagship store" opening UK',
  '"relocating to" OR "has relocated" business UK',
  '"moving to new premises" UK',
  '"refurbishment" OR "revamp" store OR site UK',
  '"reopens after renovation" UK',
  '"new location" UK opening',
  '"sixth site" OR "seventh site" OR "eighth site" UK',
  '"new nursery" OR "new clinic" OR "new gym" opening UK',
];

const RISK_QUERIES = [
  '"ram raid" shop OR store UK',
  '"commercial burglary" UK',
  'shop OR store "broken into" UK',
  '"armed robbery" shop OR store UK',
  '"smash and grab" UK shop',
  'vandalism OR arson shop OR store UK',
];

function loadSeen() {
  try {
    const raw = fs.readFileSync(SEEN_PATH, 'utf8');
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

const MAX_AGE_DAYS = 90;

function isWithinMaxAge(pubDateStr) {
  if (!pubDateStr) return true; // if no date given, don't drop it on this basis alone
  const parsed = new Date(pubDateStr);
  if (isNaN(parsed.getTime())) return true; // unparseable date — don't drop on this basis
  const ageDays = (Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays <= MAX_AGE_DAYS;
}

async function fetchGoogleNewsRSS(query) {
  // "when:90d" is an unofficial but well-documented Google News search operator that
  // restricts results to the last 90 days. Since it's unofficial, the pubDate check below
  // acts as a second, independent filter in case Google silently stops honouring it.
  const dateRestrictedQuery = `${query} when:${MAX_AGE_DAYS}d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(dateRestrictedQuery)}&hl=en-GB&gl=GB&ceid=GB:en`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; site-tracker-bot/1.0)' },
  });
  if (!res.ok) {
    console.error(`RSS fetch failed for query "${query}": ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (e) {
    console.error(`XML parse failed for query "${query}":`, e.message);
    return [];
  }
  const items = parsed?.rss?.channel?.item;
  if (!items) return [];
  const list = Array.isArray(items) ? items : [items];
  const results = [];
  for (const item of list) {
    const title = stripSource(String(item.title || '').trim());
    const pubDate = String(item.pubDate || '').trim();

    if (!isWithinMaxAge(pubDate)) continue; // too old — drop regardless of when: having worked
    if (!isLikelyMultiSite(title)) continue; // no multi-site indicator — likely a one-off single premises

    results.push({
      business: extractCompany(title),
      category: classifyCategory(title),
      location: extractLocation(title),
      region: extractRegion(title),
      sourceLink: String(item.link || '').trim(),
      guid: String(item.guid?.['#text'] || item.guid || item.link || title),
    });
  }
  return results;
}

async function fetchAllRSS(queries) {
  const results = [];
  for (const q of queries) {
    try {
      const items = await fetchGoogleNewsRSS(q);
      results.push(...items);
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.error(`Query failed: ${q}`, e.message);
    }
  }
  return results;
}

const JOB_TITLES = [
  'pre-opening team',
  'opening team new store',
  'launch team new site',
  'grand opening manager',
  'new store opening manager',
  // Add your own titles here, one per line, e.g.:
  // 'store launch coordinator',
  // 'new branch supervisor',
];

async function fetchAdzunaSignals() {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) {
    console.log('Adzuna credentials not set — skipping job-posting signals.');
    return [];
  }

  const results = [];
  for (const title of JOB_TITLES) {
    try {
      const url = `https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=${appId}&app_key=${appKey}&results_per_page=20&what=${encodeURIComponent(title)}&max_days_old=14&content-type=application/json`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`Adzuna fetch failed for "${title}": ${res.status}`);
        continue;
      }
      const data = await res.json();
      for (const job of data.results || []) {
        const rawText = `${job.title} at ${job.company?.display_name || ''}`;
        const locationName = job.location?.display_name || extractLocation(rawText);
        results.push({
          business: job.company?.display_name || '(unresolved — check manually)',
          category: classifyCategory(job.title || '') || CATEGORIES.NEW_SITE,
          location: locationName,
          region: extractRegion(locationName),
          sourceLink: job.redirect_url || '',
          guid: `adzuna-${job.id}`,
        });
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error(`Adzuna error for "${title}":`, e.message);
    }
  }
  return results;
}

const MULTISITE_SIC_CODES = [
  '47110', '47190', '56101', '56102', '56302', '96020',
  '93110', '93130', '88910', '86210', '86220', '45200', '96010',
];

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function fetchCompaniesHouseIncorporationSweep() {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) {
    console.log('Companies House API key not set — skipping incorporation sweep.');
    return [];
  }

  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  const fromDate = isoDateDaysAgo(3);
  const toDate = isoDateDaysAgo(0);
  const results = [];

  for (const sic of MULTISITE_SIC_CODES) {
    try {
      const url = `https://api.company-information.service.gov.uk/advanced-search/companies?incorporated_from=${fromDate}&incorporated_to=${toDate}&sic_codes=${sic}&size=50`;
      const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      if (!res.ok) {
        console.error(`Companies House sweep failed for SIC ${sic}: ${res.status}`);
        continue;
      }
      const data = await res.json();
      for (const company of data.items || []) {
        const locality = company.registered_office_address?.locality || '';
        const address = company.registered_office_address
          ? [locality, company.registered_office_address.postal_code].filter(Boolean).join(', ')
          : '(unresolved — check manually)';
        results.push({
          business: company.company_name,
          category: CATEGORIES.NEW_SITE,
          location: address,
          region: extractRegion(locality),
          sourceLink: `https://find-and-update.company-information.service.gov.uk/company/${company.company_number}`,
          guid: `ch-sweep-${company.company_number}`,
        });
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error(`Companies House sweep error for SIC ${sic}:`, e.message);
    }
  }
  return results;
}

// =========================================================================
// SOURCE 5: Food Standards Agency — new food business registrations
// Free, no API key, updated daily. Food/hospitality sector only.
//
// IMPORTANT LIMITATION, stated plainly: the FSA API has no "sort by newest"
// or "registered in the last N days" option — the only sort keys it supports
// are Relevance, rating, desc_rating, alpha, desc_alpha, distance. So this
// can't ask for "what's new since yesterday" directly. Instead it filters on
// ratingKey=AwatingInspection (that's FSA's own spelling, not a typo introduced
// here — check their docs if this ever needs updating) — a business awaiting
// its first inspection is a strong proxy for "recently registered," since
// inspections happen soon after registration. This is a sample of several
// hundred UK-wide "awaiting inspection" records each run, not an exhaustive
// feed, and dedup against seen.json is what actually surfaces new ones over
// time rather than any date filter on the source itself.
// =========================================================================
async function fetchFSANewRegistrations() {
  const results = [];
  const PAGES_TO_FETCH = 5; // ~250 records per run — a sample, not exhaustive
  for (let page = 1; page <= PAGES_TO_FETCH; page++) {
    try {
      const url = `https://api.ratings.food.gov.uk/Establishments?ratingKey=AwatingInspection&pageSize=50&pageNumber=${page}`;
      const res = await fetch(url, { headers: { 'x-api-version': '2', accept: 'application/json' } });
      if (!res.ok) {
        console.error(`FSA fetch failed on page ${page}: ${res.status}`);
        break;
      }
      const data = await res.json();
      const establishments = data.establishments || [];
      if (establishments.length === 0) break; // ran out of pages

      for (const est of establishments) {
        const locationText = est.AddressLine3 || est.AddressLine4 || est.PostCode || '(unresolved — check manually)';
        results.push({
          business: est.BusinessName || '(unresolved — check manually)',
          category: CATEGORIES.NEW_SITE,
          location: locationText,
          region: extractRegion(locationText),
          sourceLink: `https://ratings.food.gov.uk/business/en-GB/${est.FHRSID}`,
          guid: `fsa-${est.FHRSID}`,
        });
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error(`FSA fetch error on page ${page}:`, e.message);
      break;
    }
  }
  return results;
}

const SHEET_HEADER = ['Business', 'Category', 'Location', 'Region', 'Source link'];

function todayTabName() {
  return new Date().toISOString().slice(0, 10); // e.g. "2026-07-08"
}

// Sheet names containing characters other than letters/digits/underscore must be single-quoted
// in A1 notation; date-formatted tab names ("2026-07-08") require this.
function quoteSheetName(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

// Creates today's dated tab (with header row) if it doesn't already exist yet. If the
// workflow runs twice in one day, the existing tab is reused as-is — no duplicate header.
async function ensureDatedSheetTab(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });
  const existingTitles = (meta.data.sheets || []).map(s => s.properties.title);
  if (existingTitles.includes(tabName)) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(tabName)}!A1:E1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [SHEET_HEADER] },
  });
}

async function appendToGoogleSheet(rows) {
  const { GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SHEET_ID } = process.env;
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !GOOGLE_SHEET_ID) {
    console.error('Google Sheets credentials not set — skipping sheet write. See README for setup.');
    return false;
  }

  try {
    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const tabName = todayTabName();
    await ensureDatedSheetTab(sheets, GOOGLE_SHEET_ID, tabName);

    const values = rows.map(r => [r.business, r.category, r.location, r.region || 'Unclassified', r.sourceLink]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${quoteSheetName(tabName)}!A:E`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });

    console.log(`Appended ${rows.length} row(s) to Google Sheet tab "${tabName}".`);
    return true;
  } catch (e) {
    console.error('Google Sheets write failed:', e.message);
    return false;
  }
}

async function sendRunNotification(newCount, sheetWriteOk) {
  const { GMAIL_USER, GMAIL_APP_PASSWORD, DIGEST_TO_EMAIL } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !DIGEST_TO_EMAIL) return;

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from: GMAIL_USER,
      to: DIGEST_TO_EMAIL,
      subject: `Site tracker run — ${newCount} new row(s) — ${new Date().toISOString().slice(0, 10)}`,
      text: sheetWriteOk
        ? `${newCount} new row(s) were added to your Google Sheet.`
        : `${newCount} new row(s) were found, but the Google Sheet write failed — check the Actions logs.`,
    });
  } catch (e) {
    console.error('Notification email failed:', e.message);
  }
}

async function main() {
  console.log('Fetching growth signals (Google News)...');
  const growthItems = await fetchAllRSS(GROWTH_QUERIES);

  console.log('Fetching physical risk signals (Google News)...');
  const riskItems = await fetchAllRSS(RISK_QUERIES);

  console.log('Fetching Adzuna pre-opening/launch job signals...');
  const adzunaItems = await fetchAdzunaSignals();

  console.log('Running Companies House SIC-code sweep...');
  const chSweepItems = await fetchCompaniesHouseIncorporationSweep();

  console.log('Fetching FSA new food business registrations...');
  const fsaItems = await fetchFSANewRegistrations();

  const allItems = [...growthItems, ...riskItems, ...adzunaItems, ...chSweepItems, ...fsaItems];
  console.log(`Fetched ${allItems.length} total items before dedupe.`);

  const seen = loadSeen();
  const newItems = allItems.filter(item => !seen.has(item.guid));
  console.log(`${newItems.length} new item(s) after dedupe.`);

  if (newItems.length === 0) {
    console.log('Nothing new this run.');
    fs.writeFileSync(NEW_GUIDS_PATH, JSON.stringify([], null, 2));
    return;
  }

  const sheetOk = await appendToGoogleSheet(newItems);
  await sendRunNotification(newItems.length, sheetOk);

  fs.writeFileSync(NEW_GUIDS_PATH, JSON.stringify(newItems.map(item => item.guid), null, 2));
  console.log(`Wrote ${newItems.length} new GUID(s) to new-guids.json for the merge step.`);
}

main().catch(err => {
  console.error('Fatal error in fetch-signals script:', err);
  process.exit(1);
});

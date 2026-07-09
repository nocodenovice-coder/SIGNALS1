import { XMLParser } from 'fast-xml-parser';
import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
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

// Diagnostic-only audit trail: every item this run that came out unresolved/unclassified in
// any field, together with the raw headline that produced it. Never written to the Sheet and
// never committed (see .gitignore) — it exists purely so failures can be inspected after a
// run instead of having to open every source link by hand. The workflow uploads this as a
// build artifact since the GitHub Actions runner is torn down at the end of the job.
const FAILURES_PATH = path.join(process.cwd(), 'failures.json');
const UNRESOLVED_MARKER = '(unresolved — check manually)';

function logFailures(items) {
  const failures = items
    .filter(item => item.rawTitle && (
      item.business === UNRESOLVED_MARKER ||
      item.region === 'Unclassified' ||
      item.category === CATEGORIES.UNCATEGORISED
    ))
    .map(item => ({
      rawTitle: item.rawTitle,
      business: item.business,
      category: item.category,
      location: item.location,
      region: item.region,
      sourceLink: item.sourceLink,
    }));
  fs.writeFileSync(FAILURES_PATH, JSON.stringify(failures, null, 2));
  console.log(`Wrote ${failures.length} unresolved/unclassified item(s) to failures.json for review.`);
}

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

// Google News RSS titles are formatted "Headline - Publisher Name". Strip the trailing
// " - Publisher" segment before any classification/extraction runs on the title — otherwise
// a publisher name that happens to end in "plc"/"Group" (e.g. "... - Reach plc") can be
// mistaken for the business itself by the chain-suffix pattern below. Uses the LAST
// " - " (space-hyphen-space) occurrence rather than a regex charclass exclusion, because a
// naive "publisher segment has no hyphens" rule breaks on real publisher names that
// themselves contain a hyphen without surrounding spaces (e.g. "... - Co-operative Group").
function stripSource(title) {
  const sep = ' - ';
  const idx = title.lastIndexOf(sep);
  if (idx === -1) return title;
  const head = title.slice(0, idx).trim();
  const tail = title.slice(idx + sep.length).trim();
  return tail.length > 0 && tail.length <= 40 ? head : title;
}

// Real Google News headlines routinely use typographic "smart quotes" (’ ‘) instead of
// straight ASCII ones — e.g. "Sainsbury’s confirms...". Normalizing them up front means the
// name/verb regexes below only ever need to know about the ASCII apostrophe.
function normalizeQuotes(text) {
  return text.replace(/[‘’]/g, "'");
}

// Makes just the first letter of a literal word case-insensitive, leaving the rest of the
// pattern (including any regex metacharacters already present, e.g. "opens?") untouched.
// This lets trigger-verb/premises-noun matching work on Title Case headlines ("Issey Miyake
// Opens Its First Store...") without loosening the company-name capture itself, which still
// requires a literal capital letter as its primary signal that a token is a proper noun.
function ciFirst(word) {
  return word.replace(/^([a-zA-Z])/, c => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}
function ciAlt(words) {
  return words.map(ciFirst).join('|');
}

const PREMISES_NOUN_WORDS = [
  'stores?', 'shops?', 'branch(?:es)?', 'sites?', 'outlets?', 'restaurants?', 'cafés?', 'cafes?',
  'depots?', 'centres?', 'centers?', 'facilit(?:y|ies)', 'warehouses?', 'premises', 'units?',
  'clinics?', 'gyms?', 'nurser(?:y|ies)', 'supermarkets?', 'superstores?', 'showrooms?', 'venues?',
];
const PREMISES_NOUNS = ciAlt(PREMISES_NOUN_WORDS);

function classifyCategory(rawText) {
  const text = normalizeQuotes(rawText);
  const lower = text.toLowerCase();

  if (/\bburglar(y|ised|ized)?\b|\bbreak(- |-)?in\b|broke into|ram raid/.test(lower)) return CATEGORIES.BURGLARY;
  if (/\brobb(ery|ed)\b|held up at|armed raid|\battack(ed)?\b.{0,20}(staff|shop|store|premises|customer)/.test(lower)) return CATEGORIES.ROBBERY_ATTACK;
  if (/vandal(ism|ised|ized)?|arson|smash and grab|security breach/.test(lower)) return CATEGORIES.SECURITY_RISK;

  if (/relocat(ing|ed|ion)|has moved to|moving to (a )?new (site|premises|location)/.test(lower)) return CATEGORIES.RELOCATION;
  if (/revamp|refurbish(ment|ed)?|renovat(ion|ed)|redevelop(ment|ed)?|reconstruct(ion|ed)?/.test(lower)) return CATEGORIES.REVAMP;
  if (/extension|expansion of (the )?(building|premises)|structural change|redesign(ed)? (the )?(store|site|premises)|refit/.test(lower)) return CATEGORIES.PHYSICAL_CHANGE;

  // "New site opening" — deliberately checks BOTH word orders, because real headlines split
  // roughly evenly between "opens new store" (verb before noun) and "store opens" /
  // "store opens its doors" (noun before verb, premises noun as the grammatical subject).
  // The original version only checked verb-before-noun and silently missed the latter class
  // (confirmed against live headlines: "Glasgow's first Go Local store opens its doors").
  const openingVerbAlt = ciAlt(['opens?', 'opened', 'opening', 're-?opens?', 're-?opened', 're-?opening',
    'launches?', 'launched', 'launching',
    'unveils?', 'unveiled', 'debuts?', 'debuted', 'welcomes?', 'welcomed', 'confirms?', 'confirmed',
    'reveals?', 'revealed', 'announces?', 'announced', 'chooses?', 'chose', 'plots?', 'plotted']);
  const verbThenNoun = new RegExp(`\\b(?:${openingVerbAlt})\\b(?:\\s+\\w+){0,4}\\s+(?:${PREMISES_NOUNS})\\b`);
  const nounThenVerb = new RegExp(`\\b(?:${PREMISES_NOUNS})\\b(?:\\s+\\w+){0,3}\\s+(?:${openingVerbAlt})\\b`);
  if (verbThenNoun.test(text) || nounThenVerb.test(text)) return CATEGORIES.NEW_SITE;
  if (/pre-opening|launch team|grand opening/.test(lower)) return CATEGORIES.NEW_SITE;

  return CATEGORIES.UNCATEGORISED;
}

const NAME_WORD = `[A-Z][A-Za-z0-9&'.-]*`;
const NAME_CONNECTOR = `(?:&|and|of|A)`;
// A run of capitalized "words" allowing short connectors through, so multi-word brand names
// like "Pret A Manger" or "Marks & Spencer" aren't truncated at the connector. NAME_WORD
// includes a hyphen so hyphenated names ("Co-op") match as one token, not two.
const COMPANY_NAME = `${NAME_WORD}(?:\\s+(?:${NAME_WORD}|${NAME_CONNECTOR})){0,4}`;

const TRIGGER_VERB_WORDS = ['is', 'has', 'opens?', 'opened', 'opening', 're-?opens?', 're-?opened', 're-?opening',
  'expands?', 'expanding',
  'announces?', 'announced', 'hiring', 'relocat\\w*', 'to open', 'confirms?', 'confirmed',
  'plans?', 'planned', 'reveals?', 'revealed', 'unveils?', 'unveiled', 'moves?', 'moved', 'moving',
  'chooses?', 'chose', 'plots?', 'plotted', 'submits?', 'submitted', 'enters?', 'entering',
  'launches?', 'launched', 'launching', 'debuts?', 'debuted', 'welcomes?', 'welcomed'];
const TRIGGER_VERBS = ciAlt(TRIGGER_VERB_WORDS);

// A handful of common adverbs that real headlines insert between the subject and the verb
// ("Scotmid officially opens...") — allowed as an optional single filler word so the
// trigger-verb patterns below don't require literal adjacency.
const ADVERB_FILLER = `(?:\\s+(?:officially|recently|now|finally|quietly|formally|reportedly))?`;

// Words that are only capitalized because they happen to sit at the very start of a sentence
// (English sentence case), not because they're a proper noun — regex has no way to tell "Coffee
// shop to open..." from "Costa Coffee shop to open..." except by maintaining a blocklist like
// this one. Confirmed false positives from live data: "Revamp plans for fast-food chain site"
// resolved to business="Revamp", "Coffee shop to open seventh site" resolved to
// business="Coffee". This list can never be complete — it's whack-a-mole by construction, and
// is one of the concrete reasons regex has a real ceiling on this task (see PR notes).
const NON_COMPANY_WORDS = /^(New|UK|This|That|Local|Police|Officers?|Detectives?|Council|First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth|An|In|On|At|Man|Woman|Following|After|Before|During|Nationwide|One|Two|Three|Major|Popular|Viral|Huge|Beloved|Nostalgic|Revamp|Coffee|Region|Second)\b/;

function isPlausibleCompanyName(candidate) {
  if (!candidate) return false;
  // "The" alone is a near-certain false positive ("The company revealed..."), but real UK
  // brands legitimately start with "The" (The Ivy, The Range, The Body Shop) — only reject
  // it when it's not followed by another capitalized word.
  if (/^The$/.test(candidate)) return false;
  if (/^The\s+[a-z]/.test(candidate)) return false;
  return !NON_COMPANY_WORDS.test(candidate);
}

// Layered fallback: each pattern is lower-confidence than the last. Supports single-word
// brand names (Amazon, Chipotle) as well as multi-word company names — a pattern doesn't
// need a Ltd/Group/plc suffix to match, it just needs to sit next to a recognisable trigger.
function extractCompany(rawText) {
  const text = normalizeQuotes(stripSource(rawText));

  // 1. Strong chain-suffix pattern (Ltd/Limited/Group/plc/LLP) — highest confidence, matches
  // anywhere in the text.
  let m = text.match(new RegExp(`(${COMPANY_NAME})\\s+(Ltd|Limited|Group|plc|PLC|LLP)\\b`));
  if (m) return `${m[1]} ${m[2]}`.trim();

  // 2. Company name at the very start of the headline, followed (optionally through one
  // adverb) by a trigger verb.
  m = text.match(new RegExp(`^(${COMPANY_NAME})${ADVERB_FILLER}\\s+(?:${TRIGGER_VERBS})\\b`));
  if (m && isPlausibleCompanyName(m[1])) return m[1].trim();

  // 3. Company name at the start, followed by a premises noun, then (allowing a short gap for
  // an inserted location phrase — "Co-op store in Derbyshire town opens its doors") a trigger
  // verb. e.g. "Costa Coffee store opens in Brighton", "Tesco Express store to open in Leeds".
  m = text.match(new RegExp(`^(${COMPANY_NAME})\\s+(?:${PREMISES_NOUNS})\\b(?:\\s+\\w+){0,3}\\s+(?:${TRIGGER_VERBS})\\b`));
  if (m && isPlausibleCompanyName(m[1])) return m[1].trim();

  // 4. "New <Company> [premises noun] <trigger>" — company preceded by a leading filler word.
  m = text.match(new RegExp(`^(?:New|A new|The new)\\s+(${COMPANY_NAME})\\s+(?:(?:${PREMISES_NOUNS})\\s+)?(?:${TRIGGER_VERBS})\\b`));
  if (m && isPlausibleCompanyName(m[1])) return m[1].trim();

  // 5. "<Place>'s first [ever] <Company> [premises noun] <trigger>" — e.g. "Glasgow's first
  // Go Local store opens its doors", "Oxford's first ever Lego store opens...". The company
  // name sits after a possessive place name and an ordinal, not at the very start.
  m = text.match(new RegExp(`^${NAME_WORD}'s\\s+(?:${ciAlt(['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'])})\\s+(?:ever\\s+)?(${COMPANY_NAME})\\s+(?:${PREMISES_NOUNS})\\s+(?:${TRIGGER_VERBS})\\b`));
  if (m && isPlausibleCompanyName(m[1])) return m[1].trim();

  // 6. Company name anywhere, directly followed by a trigger verb (mid-headline, e.g.
  // "Third UK store for Acme Retail opens in Leeds", "Fried chicken chain Popeyes submits
  // plans for Belfast City Centre location").
  m = text.match(new RegExp(`\\b(${COMPANY_NAME})\\s+(?:${TRIGGER_VERBS})\\b`));
  if (m && isPlausibleCompanyName(m[1])) return m[1].trim();

  // 7. "at <Company> branch/store" — common phrasing in burglary/robbery headlines where the
  // business isn't the grammatical subject. Lower confidence: risks false positives on
  // capitalized place names ("at Oxford Street store"), but resolves a real class of risk
  // headlines that would otherwise always be unresolved.
  m = text.match(new RegExp(`\\bat\\s+(${COMPANY_NAME})\\s+(?:${PREMISES_NOUNS})\\b`));
  if (m && isPlausibleCompanyName(m[1])) return m[1].trim();

  // 8. Last resort: a known major chain named anywhere, in any grammatical position. Confirmed
  // against live data as a real, common gap in risk headlines specifically — the business is
  // often just the object of a preposition with no premises noun nearby at all ("Cash machine
  // ripped from Co-op in latest ram-raid", "Burglar smashes Tesco window in Southsea"), which
  // none of the structural patterns above are shaped to catch. Safe to check by plain presence
  // (rather than position/grammar) specifically because it's restricted to the curated allowlist.
  const knownChain = matchKnownChain(text);
  if (knownChain) return knownChain;

  return UNRESOLVED_MARKER;
}

// A curated list of well-known UK/international multi-site chains, mapped to how each one
// should actually be displayed (so we're not relying on a generic auto-capitalizer to get
// "Sainsbury's" / "KFC" / "McDonald's" right). Pure pattern-matching (chain suffix, or
// explicit "chain"/"nationwide"/ordinal-site language) misses well-known single-word brands
// that real headlines just name directly without any of those cues — confirmed against live
// data, where "Amazon opens site and shares plans for a second" etc. were being silently
// dropped by the multi-site filter despite Amazon obviously operating dozens of UK sites, and
// where risk headlines like "Cash machine ripped from Co-op in latest ram-raid" were left
// unresolved despite naming the business plainly. This list is deliberately short and only
// ADDS coverage on top of the pattern-based checks — it will never be exhaustive (that's a
// knowledge-list ceiling, not a bug to keep chasing). Deliberately excludes brand names that
// collide with common English words (e.g. "Next", "Subway" — matching those as bare words
// would produce false positives on nearly every headline that uses the ordinary word).
const KNOWN_MAJOR_CHAINS = [
  ['amazon', 'Amazon'], ['tesco', 'Tesco'], ["sainsbury's", "Sainsbury's"], ['sainsburys', "Sainsbury's"],
  ['asda', 'Asda'], ['morrisons', 'Morrisons'], ['aldi', 'Aldi'], ['lidl', 'Lidl'], ['waitrose', 'Waitrose'],
  ['co-op', 'Co-op'], ['greggs', 'Greggs'], ['costa', 'Costa'], ['starbucks', 'Starbucks'],
  ['caffè nero', 'Caffè Nero'], ['caffe nero', 'Caffè Nero'], ['pret a manger', 'Pret A Manger'],
  ["mcdonald's", "McDonald's"], ['mcdonalds', "McDonald's"], ['kfc', 'KFC'], ["nando's", "Nando's"],
  ['nandos', "Nando's"], ['wingstop', 'Wingstop'], ['popeyes', 'Popeyes'], ['burger king', 'Burger King'],
  ["domino's", "Domino's"], ['dominos', "Domino's"], ['pizza hut', 'Pizza Hut'],
  ['zara', 'Zara'], ['h&m', 'H&M'], ['primark', 'Primark'], ['river island', 'River Island'],
  ['tk maxx', 'TK Maxx'], ['home bargains', 'Home Bargains'], ['b&m', 'B&M'], ['wilko', 'Wilko'],
  ['boots', 'Boots'], ['superdrug', 'Superdrug'], ['currys', 'Currys'], ['argos', 'Argos'],
  ['jd sports', 'JD Sports'], ['footasylum', 'Footasylum'], ['sports direct', 'Sports Direct'],
  ['ikea', 'IKEA'], ['dunelm', 'Dunelm'], ['the range', 'The Range'], ['wickes', 'Wickes'],
  ['screwfix', 'Screwfix'], ['b&q', 'B&Q'], ['halfords', 'Halfords'], ['puregym', 'PureGym'],
  ['the gym group', 'The Gym Group'], ['anytime fitness', 'Anytime Fitness'], ['david lloyd', 'David Lloyd'],
  ['nuffield health', 'Nuffield Health'], ['premier inn', 'Premier Inn'], ['travelodge', 'Travelodge'],
  ['lego', 'LEGO'], ['marks & spencer', 'Marks & Spencer'], ['m&s', 'M&S'],
];

function matchKnownChain(text) {
  const lower = text.toLowerCase();
  for (const [needle, display] of KNOWN_MAJOR_CHAINS) {
    if (new RegExp(`\\b${needle.replace(/[&]/g, '\\&')}\\b`, 'i').test(lower)) return display;
  }
  return null;
}

// ---- Multi-site relevance filter ----
// Applied to news-derived items only (growth + risk RSS). Purpose: exclude one-off stories
// about single independent premises (a lone corner shop robbery, a single café opening) that
// aren't useful signals for a business whose target is established or scaling multi-site
// operators. This is a heuristic, not a lookup against real site-count data — it passes an
// item through if the company name resolved via a strong chain-suffix pattern (Ltd/Group/plc
// — companies structured this way are far more often multi-site than sole traders), OR the
// text itself contains explicit multi-site language, OR a known major chain is named. It
// will still let some single-site stories through and may drop a few genuine multi-site
// items that happen to be phrased without any of these cues — it trades recall for less
// noise, on purpose, per what was asked for.
function isLikelyMultiSite(rawText) {
  const text = normalizeQuotes(rawText);
  const hasStrongCompanySuffix = /\b(Ltd|Limited|Group|plc|PLC|LLP)\b/.test(text);
  const lower = text.toLowerCase();
  const hasMultiSiteLanguage = /\bchain\b|\bfranchise\b|\bnationwide\b|\bacross the uk\b|\bbranches\b|\boutlets\b|\bstores? (nationwide|across)|\bthe retailer\b|\bsupermarket chain\b|\bmulti-?site\b|\b(1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:\w+\s+){0,2}(site|store|branch|location|shop|outlet)\b/.test(lower);
  const hasKnownChain = !!matchKnownChain(text);
  return hasStrongCompanySuffix || hasMultiSiteLanguage || hasKnownChain;
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
  // Counties added after auditing real headlines — "North Devon", "Suffolk town", "Norfolk"
  // etc. were all going unresolved because only city names, not county names, were listed.
  'devon','cornwall','dorset','somerset','hampshire','norfolk','suffolk','cheshire',
  'nottinghamshire','warwickshire','berkshire','buckinghamshire','bedfordshire',
  'gloucestershire','oxfordshire','cambridgeshire','staffordshire','shropshire','northumberland',
  'northamptonshire',
];

// A UK area name can collide with a non-UK place that contains it as a substring/whole word
// ("York" inside "New York City"). Confirmed against real data: "Issey Miyake Opens Its First
// Store In New York City" was resolving to the UK region North because "York" matched inside
// "New York". Keeping this as a small, targeted exclusion list rather than a general geo-NER
// system — it only guards the specific collisions actually observed.
const AREA_FALSE_POSITIVE_GUARDS = {
  york: /\bnew york\b/i,
};

function extractLocation(text) {
  const lower = text.toLowerCase();
  for (const area of UK_AREAS) {
    const guard = AREA_FALSE_POSITIVE_GUARDS[area];
    if (guard && guard.test(lower)) continue;
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
  'north east','newcastle','sunderland','durham','gateshead','middlesbrough','darlington','teesside','tyneside','hartlepool','northumberland',
  'north west','manchester','liverpool','preston','blackpool','bolton','stockport','warrington','wigan','salford',
  'oldham','rochdale','burnley','blackburn','lancaster','carlisle','cumbria','merseyside','greater manchester','lancashire','cheshire',
  'yorkshire','leeds','sheffield','bradford','hull','york','wakefield','doncaster','rotherham','barnsley','halifax','huddersfield',
  'north wales','wrexham','bangor',
  'birmingham','west midlands','east midlands','nottingham','nottinghamshire','leicester','derby','coventry','warwickshire','wolverhampton','stoke','staffordshire','shropshire','stafford','telford','shrewsbury','worcester','lincoln','grimsby','scunthorpe',
];
const REGION_SOUTH = [
  'london','greater london',
  'south east','brighton','reading','oxford','oxfordshire','guildford','southampton','hampshire','portsmouth','canterbury','maidstone','basingstoke','slough','luton','berkshire','buckinghamshire','bedfordshire',
  'south west','bristol','bath','exeter','plymouth','gloucester','gloucestershire','bournemouth','swindon','devon','cornwall','dorset','somerset',
  'east of england','east anglia','norwich','norfolk','ipswich','suffolk','cambridge','cambridgeshire','peterborough','colchester','chelmsford','southend','milton keynes','northampton','northamptonshire',
  'south wales','cardiff','swansea',
  'home counties','kent','sussex','surrey','essex','hertfordshire','watford',
];

function extractRegion(text) {
  const lower = text.toLowerCase();
  for (const kw of REGION_SOUTH) {
    const guard = AREA_FALSE_POSITIVE_GUARDS[kw];
    if (guard && guard.test(lower)) continue;
    if (new RegExp(`\\b${kw}\\b`, 'i').test(lower)) return 'South';
  }
  for (const kw of REGION_NORTH) {
    const guard = AREA_FALSE_POSITIVE_GUARDS[kw];
    if (guard && guard.test(lower)) continue;
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

// Ongoing weekly cadence: 7-day gap between runs + a few days of safety margin, same
// reasoning already used for the Companies House sweep window. This used to be 90 — that
// was fine when the workflow ran daily, but on a weekly cadence it means a run can surface
// an article for the first time that's up to ~85 days old: correctly dated, but it makes a
// tab's Date column look "random" next to genuinely fresh finds from the same week (verified
// against live data — see the fetch-signals PR notes / commit message). The one-time Sheet1
// backfill (backfillSheet1(), below) explicitly overrides this back to 90 days, since that's
// meant to be a wide historical snapshot, not an ongoing-cadence window.
const MAX_AGE_DAYS = 10;

function isWithinMaxAge(pubDateStr, maxAgeDays = MAX_AGE_DAYS) {
  if (!pubDateStr) return true; // if no date given, don't drop it on this basis alone
  const parsed = new Date(pubDateStr);
  if (isNaN(parsed.getTime())) return true; // unparseable date — don't drop on this basis
  const ageDays = (Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays <= maxAgeDays;
}

async function fetchGoogleNewsRSS(query, maxAgeDays = MAX_AGE_DAYS) {
  // "when:Nd" is an unofficial but well-documented Google News search operator that
  // restricts results to the last N days. Since it's unofficial, the pubDate check below
  // acts as a second, independent filter in case Google silently stops honouring it.
  const dateRestrictedQuery = `${query} when:${maxAgeDays}d`;
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
    const originalTitle = String(item.title || '').trim();
    const title = stripSource(originalTitle);
    const pubDate = String(item.pubDate || '').trim();

    if (!isWithinMaxAge(pubDate, maxAgeDays)) continue; // too old — drop regardless of when: having worked
    if (!isLikelyMultiSite(title)) continue; // no multi-site indicator — likely a one-off single premises

    results.push({
      business: extractCompany(title),
      category: classifyCategory(title),
      location: extractLocation(title),
      region: extractRegion(title),
      date: formatSourceDate(pubDate), // the article's own publish date
      sourceLink: String(item.link || '').trim(),
      guid: String(item.guid?.['#text'] || item.guid || item.link || title),
      rawTitle: originalTitle, // kept off the sheet write; used only for the failures audit log
    });
  }
  return results;
}

async function fetchAllRSS(queries, maxAgeDays = MAX_AGE_DAYS) {
  const results = [];
  for (const q of queries) {
    try {
      const items = await fetchGoogleNewsRSS(q, maxAgeDays);
      results.push(...items);
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.error(`Query failed: ${q}`, e.message);
    }
  }
  return results;
}

// =========================================================================
// LLM FALLBACK — Claude Haiku, for headlines the regex layer left unresolved.
//
// Real-data testing (837 live Google News headlines) showed regex/heuristic extraction
// resolves ~81% of business names on its own after tuning. Of what's left, the large
// majority is genuinely absent from the headline text — publishers withhold the name
// deliberately ("Popular chicken chain could open new site in town centre") to drive
// clicks, and the name only appears in the article body. A headline-only LLM call can't
// recover information that isn't in its input either, so this is not a silver bullet —
// it's aimed specifically at the smaller remaining slice where the name IS present but
// phrased in a way the regex patterns don't cover (unusual verbs, foreign characters,
// uncommon sentence structure). Optional: only runs if ANTHROPIC_API_KEY is set.
// =========================================================================
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const LLM_FALLBACK_CONCURRENCY = 5;

async function resolveBusinessNameViaLLM(anthropic, headline) {
  try {
    const response = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 20,
      messages: [{
        role: 'user',
        content: `You are extracting a business/company name from a UK local-news headline for a business-signals tracker.

Headline: "${headline}"

If the headline clearly and confidently names a specific business or company, respond with ONLY that name, exactly as it appears (no extra words, no punctuation, no explanation).

If the headline does NOT name a specific business (e.g. it only says "a chain", "a local shop", "a supermarket" without naming which one), respond with exactly: UNRESOLVED

Your entire response must be just the name or the word UNRESOLVED — nothing else.`,
      }],
    });
    const block = response.content?.find(b => b.type === 'text');
    const text = block?.text?.trim() ?? '';
    if (!text || /^UNRESOLVED$/i.test(text)) return null;
    return text;
  } catch (e) {
    console.error(`Haiku fallback request failed for headline "${headline}":`, e.message);
    return null;
  }
}

// Runs `fn` over `items` with at most `limit` in flight at once — keeps a batch of ~30-90
// unresolved headlines from firing 30-90 fully-parallel requests, without serializing them
// one at a time either.
async function runWithConcurrency(items, limit, fn) {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Mutates `items` in place: any item with an unresolved business name and a raw headline
// (i.e. RSS-derived — Adzuna/Companies House items already have a structured business field
// and never need this) gets one Haiku call asking it to name the business, or say so if it
// can't. Sets item.business only when the model returns a confident name.
async function applyLLMBusinessNameFallback(items) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('ANTHROPIC_API_KEY not set — skipping Haiku business-name fallback.');
    return;
  }

  const candidates = items.filter(item => item.rawTitle && item.business === UNRESOLVED_MARKER);
  if (candidates.length === 0) {
    console.log('No unresolved business names to send to the Haiku fallback.');
    return;
  }

  console.log(`Running Haiku fallback for ${candidates.length} unresolved business name(s)...`);
  const anthropic = new Anthropic({ apiKey });
  let resolvedCount = 0;

  await runWithConcurrency(candidates, LLM_FALLBACK_CONCURRENCY, async item => {
    const name = await resolveBusinessNameViaLLM(anthropic, item.rawTitle);
    if (name) {
      item.business = name;
      resolvedCount++;
    }
  });

  console.log(`Haiku fallback resolved ${resolvedCount}/${candidates.length} business name(s).`);
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
          date: formatSourceDate(job.created), // the job posting's own creation date
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
  // The workflow runs weekly (see .github/workflows/fetch-signals.yml), so this needs to
  // cover at least 7 days back to avoid a gap between runs, plus a few days of safety
  // margin. seen.json dedup already prevents duplicate rows from the overlap, so there's no
  // downside to the extra buffer — 10 days covers a weekly cadence with 3 days to spare.
  const fromDate = isoDateDaysAgo(10);
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
          date: formatSourceDate(company.date_of_creation), // the company's actual incorporation date
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

const SHEET_HEADER = ['Business', 'Category', 'Location', 'Region', 'Source link', 'Date'];

// Formats a source's own date field (article pubDate, job posting date, incorporation date)
// into a plain YYYY-MM-DD for the sheet. Returns '' if missing/unparseable — a blank cell is
// honest; a fabricated date isn't. This is the date the underlying thing happened, not the
// date this workflow run fetched it (that's already the tab name, e.g. "2026-07-08").
function formatSourceDate(dateStr) {
  if (!dateStr) return '';
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function todayTabName() {
  return new Date().toISOString().slice(0, 10); // e.g. "2026-07-08"
}

// Sheet names containing characters other than letters/digits/underscore must be single-quoted
// in A1 notation; date-formatted tab names ("2026-07-08") require this.
function quoteSheetName(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

// Creates today's dated tab (with header row + a filter on it) if it doesn't already exist
// yet. If the workflow runs twice in one day, the existing tab is reused as-is — no
// duplicate header, and no re-applied filter that would clobber any manual filter/sort
// state the user set on the tab earlier that day.
async function ensureDatedSheetTab(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });
  const existingTitles = (meta.data.sheets || []).map(s => s.properties.title);
  if (existingTitles.includes(tabName)) return;

  const addSheetResponse = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });
  const sheetId = addSheetResponse.data.replies[0].addSheet.properties.sheetId;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(tabName)}!A1:F1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [SHEET_HEADER] },
  });

  // Basic filter on the header + data range, so the tab is immediately filterable/sortable
  // without a manual "Data > Create a filter" step each week. endRowIndex is left unset
  // (unbounded) so the filter keeps covering rows appended later the same day by subsequent
  // runs; endColumnIndex matches SHEET_HEADER's width so it stays correct if columns change.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        setBasicFilter: {
          filter: {
            range: {
              sheetId,
              startRowIndex: 0,
              startColumnIndex: 0,
              endColumnIndex: SHEET_HEADER.length,
            },
          },
        },
      }],
    },
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

    const values = rows.map(r => [r.business, r.category, r.location, r.region || 'Unclassified', r.sourceLink, r.date || '']);

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${quoteSheetName(tabName)}!A:F`,
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

// =========================================================================
// ONE-TIME BACKFILL MODE — separate from the ongoing weekly mechanism above.
// Run via `node fetch-signals.mjs --backfill`. Wipes Sheet1 and repopulates it with a wide
// 90-day historical snapshot across all four sources, regardless of the ongoing
// MAX_AGE_DAYS window set above. Standalone: never touches ensureDatedSheetTab or creates
// a dated tab, and appendToGoogleSheet (the ongoing writer) is left completely alone.
// =========================================================================
const BACKFILL_MAX_AGE_DAYS = 90;

// Clears Sheet1 entirely (all rows, not just data below the header), writes the header
// fresh, appends every row, then applies the same basic filter new dated tabs get. Sheet1's
// sheetId isn't assumed to be 0 — looked up the same way ensureDatedSheetTab looks up a
// dated tab's sheetId, so this still works if Sheet1 was ever renamed or reordered.
async function overwriteSheet1(rows) {
  const { GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SHEET_ID } = process.env;
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !GOOGLE_SHEET_ID) {
    console.error('Google Sheets credentials not set — skipping Sheet1 backfill write. See README for setup.');
    return false;
  }

  try {
    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    await sheets.spreadsheets.values.clear({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1',
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1!A1:F1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [SHEET_HEADER] },
    });

    const values = rows.map(r => [r.business, r.category, r.location, r.region || 'Unclassified', r.sourceLink, r.date || '']);
    if (values.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: 'Sheet1!A:F',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      });
    }

    const meta = await sheets.spreadsheets.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      fields: 'sheets.properties',
    });
    const sheet1 = (meta.data.sheets || []).find(s => s.properties.title === 'Sheet1');
    if (sheet1) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: GOOGLE_SHEET_ID,
        requestBody: {
          requests: [{
            setBasicFilter: {
              filter: {
                range: {
                  sheetId: sheet1.properties.sheetId,
                  startRowIndex: 0,
                  startColumnIndex: 0,
                  endColumnIndex: SHEET_HEADER.length,
                },
              },
            },
          }],
        },
      });
    } else {
      console.error('Sheet1 not found in the spreadsheet — filter not applied.');
    }

    console.log(`Backfilled Sheet1 with ${rows.length} row(s) and applied a filter.`);
    return true;
  } catch (e) {
    console.error('Sheet1 backfill write failed:', e.message);
    return false;
  }
}

// One-time historical dump: last 90 days across all four sources, written into Sheet1.
//
// seen.json decision, explained: this DOES mark every backfilled item's guid as seen (via
// the same new-guids.json -> merge-seen.mjs path the ongoing mechanism uses). The instinctive
// answer might be "a one-off backfill shouldn't touch ongoing dedup state at all" — but
// that's wrong here: without it, a story backfilled into Sheet1 that's still within the
// ongoing mechanism's much narrower windows (10 days for RSS, 14 for Adzuna, 10 for
// Companies House) would immediately reappear as "new" in next week's dated tab, producing a
// duplicate row for the same story within days of the backfill. Marking it seen prevents
// that. For anything older than the ongoing windows (the bulk of a 90-day pull), marking it
// seen is simply inert — it would never have been re-fetched anyway, since it's already
// outside every ongoing source's own window regardless of seen.json.
async function backfillSheet1() {
  console.log('=== BACKFILL MODE: one-time Sheet1 historical dump (last 90 days), separate from the ongoing weekly mechanism ===');

  console.log('Fetching growth signals (Google News, 90-day window)...');
  const growthItems = await fetchAllRSS(GROWTH_QUERIES, BACKFILL_MAX_AGE_DAYS);

  console.log('Fetching physical risk signals (Google News, 90-day window)...');
  const riskItems = await fetchAllRSS(RISK_QUERIES, BACKFILL_MAX_AGE_DAYS);

  console.log('Fetching Adzuna pre-opening/launch job signals...');
  const adzunaItems = await fetchAdzunaSignals();

  console.log('Running Companies House SIC-code sweep...');
  const chSweepItems = await fetchCompaniesHouseIncorporationSweep();

  const allItems = [...growthItems, ...riskItems, ...adzunaItems, ...chSweepItems];
  console.log(`Backfill fetched ${allItems.length} total item(s) before within-batch dedupe.`);

  // De-dupe within this batch only (e.g. two RSS queries matching the same article) — NOT
  // against seen.json. This is a fresh historical snapshot, not constrained by whatever
  // ongoing runs have already surfaced elsewhere.
  const seenInBatch = new Set();
  const uniqueItems = [];
  for (const item of allItems) {
    if (seenInBatch.has(item.guid)) continue;
    seenInBatch.add(item.guid);
    uniqueItems.push(item);
  }
  console.log(`${uniqueItems.length} unique item(s) after within-batch dedupe.`);

  await applyLLMBusinessNameFallback(uniqueItems);

  const sheetOk = await overwriteSheet1(uniqueItems);
  if (!sheetOk) {
    console.error('Backfill Sheet1 write failed — not updating seen.json.');
    process.exit(1);
  }

  fs.writeFileSync(NEW_GUIDS_PATH, JSON.stringify(uniqueItems.map(item => item.guid), null, 2));
  console.log(`Wrote ${uniqueItems.length} GUID(s) to new-guids.json — the workflow's merge-seen.mjs step commits these to seen.json, same as an ongoing run.`);

  logFailures(uniqueItems);
  console.log('=== BACKFILL COMPLETE ===');
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

  const allItems = [...growthItems, ...riskItems, ...adzunaItems, ...chSweepItems];
  console.log(`Fetched ${allItems.length} total items before dedupe.`);

  const seen = loadSeen();
  const newItems = allItems.filter(item => !seen.has(item.guid));
  console.log(`${newItems.length} new item(s) after dedupe.`);

  if (newItems.length === 0) {
    console.log('Nothing new this run.');
    fs.writeFileSync(NEW_GUIDS_PATH, JSON.stringify([], null, 2));
    logFailures([]);
    return;
  }

  await applyLLMBusinessNameFallback(newItems);

  const sheetOk = await appendToGoogleSheet(newItems);
  await sendRunNotification(newItems.length, sheetOk);

  fs.writeFileSync(NEW_GUIDS_PATH, JSON.stringify(newItems.map(item => item.guid), null, 2));
  console.log(`Wrote ${newItems.length} new GUID(s) to new-guids.json for the merge step.`);

  logFailures(newItems);
}

// Only run when this file is executed directly (`node fetch-signals.mjs`), not when
// imported as a module — otherwise every import would trigger live API calls and a real
// Sheet write. `--backfill` switches to the one-time Sheet1 historical dump; anything else
// runs the normal ongoing weekly flow.
if (import.meta.url === `file://${process.argv[1]}`) {
  const run = process.argv.includes('--backfill') ? backfillSheet1() : main();
  run.catch(err => {
    console.error('Fatal error in fetch-signals script:', err);
    process.exit(1);
  });
}

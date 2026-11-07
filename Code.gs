/*******************************************************************************
 * AI JOB SEARCH ASSISTANT  —  100% free, no coding agent, no server
 *
 * Runs inside Google Apps Script attached to a Google Sheet.
 *   • Job sources : Adzuna, Jooble, JSearch (Google for Jobs → LinkedIn/Indeed/
 *                   Glassdoor listings), Remotive, Greenhouse/Lever/Ashby boards
 *   • AI          : Google Gemini free tier (Groq free tier as backup)
 *   • Resumes     : every tailored resume is a COPY of your uploaded resume
 *                   (same layout and format); only existing summary, bullet and
 *                   skills lines are reworded. Nothing is ever added.
 *   • Output      : Google Docs resumes in Drive + "AI Job Search Tracker" sheet
 *   • Schedule    : daily time-driven trigger at 9 AM (your sheet's timezone)
 *
 * Setup: see SETUP.md. You never need to edit this file — everything is
 * configured from the sheet's "🤖 AI Job Search" menu and the Profile tab.
 ******************************************************************************/

const APP = {
  SPREADSHEET_NAME: 'AI Job Search Tracker',
  FOLDER_NAME: 'AI Job Search - Customized Resumes',
  SHEETS: {
    TRACKER: 'Tracker',
    PROFILE: 'Profile',
    REPORTS: 'Daily Reports',
    RESUME: 'Resume (parsed)',
    QUEUE: '_queue',
    SEEN: '_seen',
    CACHE: '_resume_cache',
    LOG: '_log',
  },
  MIN_SCORE: 70,                 // only jobs >= this get a resume
  MAX_RUNTIME_MS: 4 * 60 * 1000, // Apps Script hard limit is 6 min; we stop at 4 and continue
  DEDUP_WINDOW_DAYS: 60,         // same company + title within this window = duplicate
  MAX_JOB_AGE_DAYS: 7,           // ignore postings older than this (when date is known)
  MANDATORY_GAP_PENALTY: 5,      // points removed per missing mandatory requirement (max 3)
  MAX_DESC_CHARS: 9000,
  DEFAULT_GEMINI_MODEL: 'gemini-2.5-flash',
  DEFAULT_GROQ_MODEL: 'llama-3.3-70b-versatile',
  GEMINI_MIN_GAP_MS: 6500,       // stay under free-tier requests-per-minute
  GROQ_MIN_GAP_MS: 2500,
};

const WEIGHTS = {
  technical_skills: 0.30,
  experience: 0.25,
  responsibilities: 0.20,
  industry: 0.10,
  location_arrangement: 0.10,
  education: 0.05,
};

const TRACKER_HEADERS = [
  'Date Found', 'Job Title', 'Company Name', 'Location', 'Work Arrangement',
  'Experience Required', 'Salary', 'Job Match Score', 'Match Category',
  'Key Matching Skills', 'Missing Skills', 'Job Description Summary',
  'Job Posting URL', 'Company Career URL', 'Customized Resume Google Docs URL',
  'Resume Creation Status', 'Application Status', 'Notes',
];
const T = { // 1-based tracker columns
  DATE: 1, TITLE: 2, COMPANY: 3, URL: 13, CAREER: 14, DOC: 15, DOC_STATUS: 16, APP_STATUS: 17, NOTES: 18,
};

const QUEUE_HEADERS = ['Queued At', 'Run ID', 'Status', 'Dedup Key', 'Job JSON', 'Processed In Run',
  'Score', 'Category', 'Resume Doc URL', 'Error / Reason', 'Title', 'Company'];
const Q = { // 0-based queue columns
  QUEUED: 0, RUN: 1, STATUS: 2, KEY: 3, JSON: 4, PROC_RUN: 5, SCORE: 6, CAT: 7, DOC: 8, ERR: 9, TITLE: 10, COMPANY: 11,
};

const SEEN_HEADERS = ['First Seen', 'Dedup Key', 'Normalized URL', 'Content Hash', 'Title', 'Company', 'Source'];

const REPORT_HEADERS = ['Run', 'Trigger', 'Jobs discovered', 'Unique jobs', 'Already seen (skipped)',
  'Excellent (85+)', 'Good (70-84)', 'Moderate (55-69)', 'Low (<55)', 'Rejected total',
  'Resumes created', 'Failed operations', 'Still queued', 'New resume links', 'Notes'];

const PROFILE_FIELDS = [
  ['current_title', 'Current job title', 'e.g. Data Analyst'],
  ['target_titles', 'Target job titles (comma-separated)', 'e.g. Data Analyst, BI Analyst, Analytics Engineer'],
  ['experience_years', 'Total experience (years)', 'e.g. 4'],
  ['skills', 'Technical skills (comma-separated)', 'e.g. SQL, Python, Power BI, Excel, Tableau'],
  ['industries', 'Industry experience', 'e.g. E-commerce, Fintech'],
  ['locations', 'Preferred locations (comma-separated)', 'e.g. Bengaluru, Hyderabad, Remote'],
  ['country', 'Country code for job APIs', 'Two letters: in, us, gb, ca, au, de, sg, ae, nl ...'],
  ['arrangement', 'Preferred work arrangement', 'Remote / Hybrid / On-site (you may list several)'],
  ['min_salary', 'Minimum expected salary (annual, number only)', 'e.g. 1200000 — blank = no salary filter'],
  ['employment_type', 'Preferred employment type', 'Full-time / Contract / Part-time'],
  ['notice_period', 'Notice period', 'e.g. 30 days'],
  ['education', 'Education', 'e.g. B.Tech, Computer Science'],
  ['other', 'Other preferences', 'e.g. Product companies preferred, no night shifts'],
  ['resume_url', 'Original resume = base template (Google Doc URL)', 'Filled automatically by menu → Upload my resume, or paste a Google Doc link'],
  ['career_boards', 'Company career boards to watch (optional)', 'e.g. greenhouse:stripe, lever:plaid, ashby:notion'],
  ['exclude_keywords', 'Skip jobs whose title contains (comma-separated)', 'e.g. Intern, Director, Principal'],
  ['max_ai_jobs', 'Max jobs to AI-evaluate per day', '25 (keeps you inside free AI limits)'],
  ['report_email', 'Daily report email (optional)', 'Blank = your Google account email'],
];

const API_KEYS = [
  ['GEMINI_API_KEY', 'Google Gemini API key (REQUIRED)\nGet it free at aistudio.google.com/apikey'],
  ['GROQ_API_KEY', 'Groq API key (optional backup AI)\nFree at console.groq.com/keys'],
  ['ADZUNA_APP_ID', 'Adzuna App ID (recommended job source)\nFree at developer.adzuna.com'],
  ['ADZUNA_APP_KEY', 'Adzuna App Key'],
  ['JOOBLE_API_KEY', 'Jooble API key (optional job source)\nFree at jooble.org/api/about'],
  ['RAPIDAPI_KEY', 'RapidAPI key for JSearch (optional — LinkedIn / Indeed / Glassdoor listings via Google for Jobs)\nFree plan at rapidapi.com → search "JSearch"'],
  ['GEMINI_MODEL', 'Gemini model name (optional)\nLeave blank for ' + 'gemini-2.5-flash' + '. Change only if Google retires it.'],
];

const ADZUNA_COUNTRIES = ['gb', 'us', 'at', 'au', 'be', 'br', 'ca', 'ch', 'de', 'es', 'fr', 'in', 'it', 'mx', 'nl', 'nz', 'pl', 'sg', 'za'];

/* ============================================================================
 * MENU
 * ==========================================================================*/

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🤖 AI Job Search')
    .addItem('1. Initial setup', 'setup')
    .addItem('2. Set API keys', 'setApiKeys')
    .addItem('3. Upload my resume (base template)', 'uploadResumeDialog')
    .addItem('4. Test connections', 'testConnections')
    .addSeparator()
    .addItem('▶ Run job search now', 'runNow')
    .addItem('⏰ Enable daily run (9 AM)', 'enableDailyRun')
    .addItem('⏹ Disable daily run', 'disableDailyRun')
    .addSeparator()
    .addItem('📄 Re-read my resume', 'refreshResumeMenu')
    .addItem('🔁 Retry failed jobs', 'retryFailed')
    .addToUi();
}

function setup() {
  const ss = ss_();
  if (ss.getName() !== APP.SPREADSHEET_NAME) ss.rename(APP.SPREADSHEET_NAME);

  const tr = ensureSheet_(APP.SHEETS.TRACKER, TRACKER_HEADERS);
  tr.setFrozenRows(1);
  tr.getRange(1, 1, 1, TRACKER_HEADERS.length).setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff').setWrap(true);
  tr.getRange(2, T.APP_STATUS, tr.getMaxRows() - 1, 1).setDataValidation(statusRule_());
  tr.getRange(2, T.DATE, tr.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
  [110, 220, 160, 140, 110, 110, 130, 80, 100, 220, 220, 320, 110, 110, 120, 140, 120, 260]
    .forEach((w, i) => tr.setColumnWidth(i + 1, w));

  let pr = ss.getSheetByName(APP.SHEETS.PROFILE);
  if (!pr) {
    pr = ss.insertSheet(APP.SHEETS.PROFILE);
    pr.getRange(1, 1, 1, 4).setValues([['Key (do not edit)', 'Field', 'Your value', 'Example / help']]).setFontWeight('bold');
  }
  const existing = pr.getRange(1, 1, Math.max(pr.getLastRow(), 1), 1).getValues().map(r => String(r[0]));
  PROFILE_FIELDS.forEach(f => {
    if (existing.indexOf(f[0]) === -1) pr.appendRow([f[0], f[1], f[0] === 'max_ai_jobs' ? 25 : '', f[2]]);
  });
  pr.setFrozenRows(1);
  pr.setColumnWidth(1, 120); pr.setColumnWidth(2, 300); pr.setColumnWidth(3, 380); pr.setColumnWidth(4, 380);
  pr.getRange(2, 1, pr.getLastRow() - 1, 1).setFontColor('#999999');
  pr.getRange(2, 3, pr.getLastRow() - 1, 1).setBackground('#fff8e1');

  ensureSheet_(APP.SHEETS.REPORTS, REPORT_HEADERS).setFrozenRows(1);
  ensureSheet_(APP.SHEETS.RESUME, ['Line', 'Type', 'Group', 'AI may edit?', 'Text (from your template)']);
  [APP.SHEETS.QUEUE, APP.SHEETS.SEEN, APP.SHEETS.CACHE, APP.SHEETS.LOG].forEach(n => {
    const headers = { _queue: QUEUE_HEADERS, _seen: SEEN_HEADERS, _resume_cache: ['Hash', 'JSON', 'Updated'], _log: ['Time', 'Level', 'Message'] }[n];
    ensureSheet_(n, headers).hideSheet();
  });
  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  const folder = getFolder_();
  ss.setActiveSheet(pr);
  ui_().alert('Setup complete ✅',
    '1. Fill in the yellow "Your value" column on the Profile tab.\n2. Menu → Set API keys.\n' +
    '3. Menu → Upload my resume (or paste a Google Doc link in the Profile tab).\n4. Menu → Test connections.\n' +
    '5. Menu → Run job search now.\n6. Menu → Enable daily run.\n\n' +
    'Resumes will be saved in Drive folder: ' + folder.getName(), ui_().ButtonSet.OK);
}

function setApiKeys() {
  const ui = ui_();
  const props = PropertiesService.getScriptProperties();
  for (const [key, label] of API_KEYS) {
    const cur = props.getProperty(key);
    const res = ui.prompt('Set API keys', label + '\n\nCurrently: ' + (cur ? 'SET (' + mask_(cur) + ')' : 'not set') +
      '\nLeave blank to keep current value. Type - to clear.', ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) break;
    const v = res.getResponseText().trim();
    if (v === '-') props.deleteProperty(key);
    else if (v) props.setProperty(key, v);
  }
  ui.alert('Saved. Run "Test connections" next.');
}

function testConnections() {
  const out = [];
  const k = keys_();
  try { callAI_('Reply with JSON only.', 'Return {"ok": true}', { maxTokens: 50, provider: 'gemini' }); out.push('✅ Gemini AI'); }
  catch (e) { out.push((k.gemini ? '❌ Gemini: ' + short_(e.message) : '❌ Gemini: key not set (required)')); }
  if (k.groq) {
    try { callAI_('Reply with JSON only.', 'Return {"ok": true}', { maxTokens: 50, provider: 'groq' }); out.push('✅ Groq AI (backup)'); }
    catch (e) { out.push('❌ Groq: ' + short_(e.message)); }
  } else out.push('➖ Groq backup: not set (optional)');

  let profile = null;
  try { profile = getProfile_(); out.push('✅ Profile tab readable (' + profile.targetTitles.length + ' target titles)'); }
  catch (e) { out.push('❌ Profile: ' + e.message); }

  if (profile) {
    try {
      const id = extractDocId_(profile.resumeUrl);
      const text = DocumentApp.openById(id).getBody().getText();
      out.push('✅ Resume readable (' + text.length + ' characters)');
    } catch (e) { out.push('❌ Resume: ' + resumeAccessMessage_()); }
    const t = profile.targetTitles[0] || 'analyst';
    const country = profile.country || 'us';
    if (k.adzunaId && k.adzunaKey) {
      if (ADZUNA_COUNTRIES.indexOf(country) === -1) out.push('⚠ Adzuna does not cover country "' + country + '"');
      else out.push(testFetch_('Adzuna', adzunaUrl_(k, country, t, '', 1)));
    } else out.push('➖ Adzuna: not set (recommended)');
    if (k.jooble) out.push(testFetch_('Jooble', joobleRequest_(k, t, '')));
    else out.push('➖ Jooble: not set (optional)');
    if (k.rapid) out.push(testFetch_('JSearch', jsearchRequest_(k, t, '', country, false)));
    else out.push('➖ JSearch: not set (optional)');
    out.push(testFetch_('Remotive (no key needed)', { url: 'https://remotive.com/api/remote-jobs?limit=1' }));
  }
  ui_().alert('Connection test', out.join('\n'), ui_().ButtonSet.OK);
}

function runNow() {
  toast_('Job search started. This can take several minutes; it continues in the background if needed.');
  startRun_('manual');
  toast_('Run finished or continuing in background — check the Daily Reports tab.');
}

function dailyRun() { startRun_('scheduled'); }

function continueRun() {
  deleteTriggers_('continueRun');
  processQueue_();
}

function enableDailyRun() {
  deleteTriggers_('dailyRun');
  const tz = ss_().getSpreadsheetTimeZone();
  ScriptApp.newTrigger('dailyRun').timeBased().everyDays(1).atHour(9).nearMinute(0).inTimezone(tz).create();
  ui_().alert('Daily run enabled ⏰', 'The job search will run every day around 9:00 AM (' + tz + ').\n' +
    'Google runs triggers within ~15 minutes of the set time.\nTimezone comes from File → Settings of this spreadsheet.', ui_().ButtonSet.OK);
}

function disableDailyRun() {
  deleteTriggers_('dailyRun');
  deleteTriggers_('continueRun');
  ui_().alert('Daily run disabled.');
}

function refreshResumeMenu() {
  try {
    const r = getResume_(getProfile_(), true);
    const n = t => r.paras.filter(p => p.type === t).length;
    ui_().alert('Resume re-read ✅', 'Your template has ' + r.paras.length + ' lines: ' + n('summary') + ' summary, ' + n('bullet') +
      ' bullets, ' + n('skills') + ' skills lines.\n' + r.paras.filter(p => p.editable).length +
      ' line(s) may be reworded per job; everything else (names, employers, titles, dates, education, contact) is locked.\n\n' +
      'Check the "Resume (parsed)" tab: set "AI may edit?" to No on any line you want kept exactly as is.', ui_().ButtonSet.OK);
  } catch (e) { ui_().alert('Could not read resume', e.message, ui_().ButtonSet.OK); }
}

function retryFailed() {
  const sh = sheet_(APP.SHEETS.QUEUE);
  const data = sh.getDataRange().getValues();
  let n = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i][Q.STATUS] === 'failed') { sh.getRange(i + 1, Q.STATUS + 1).setValue('pending'); n++; }
  }
  if (!n) { toast_('No failed jobs to retry.'); return; }
  if (!getRunState_()) setRunState_(newRunState_('retry'));
  toast_('Retrying ' + n + ' job(s)…');
  processQueue_();
}

/* ============================================================================
 * RUN PHASE 1 — DISCOVER, DEDUPLICATE, SHORTLIST
 * ==========================================================================*/

function startRun_(trigger) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { log_('WARN', 'Another run is in progress; skipped.'); return; }
  let stats;
  try {
    trimHousekeeping_();
    const profile = getProfile_();
    getResume_(profile, false); // stop early if the resume is not accessible

    stats = newRunState_(trigger);
    const prev = getRunState_();
    if (prev) stats.notes.push('Previous run ' + prev.runId + ' was still unfinished; its queued jobs are processed in this run.');

    const found = collectJobs_(profile);
    stats.discovered = found.jobs.length;
    stats.sourceErrors = found.errors;

    const unique = dedupeInRun_(found.jobs);
    stats.unique = unique.length;

    const seen = loadSeen_();
    const fresh = [];
    unique.forEach(j => {
      const c = classifyAgainstSeen_(j, seen);
      if (c.dup) stats.duplicatesSkipped++;
      else { if (c.changedFrom) j.changedFrom = c.changedFrom; fresh.push(j); }
    });

    const pf = prefilter_(fresh, profile);
    stats.prefilterRejected = pf.rejected.length;
    const pending = countQueue_('pending');
    const room = Math.max(0, profile.maxAiJobs - pending);
    const selected = pf.keep.slice(0, room);
    stats.queued = selected.length;
    stats.deferred = pf.keep.length - selected.length;
    if (stats.deferred) stats.notes.push(stats.deferred + ' relevant job(s) deferred to keep within the daily AI limit (they will be reconsidered next run).');

    enqueue_(selected, stats.runId);
    appendSeen_(selected);
    setRunState_(stats);
    log_('INFO', 'Run ' + stats.runId + ': discovered ' + stats.discovered + ', unique ' + stats.unique + ', queued ' + stats.queued);
  } catch (e) {
    log_('ERROR', 'Run aborted: ' + e.message);
    sendFailureEmail_(e.message);
    return;
  } finally {
    lock.releaseLock();
  }
  processQueue_();
}

function newRunState_(trigger) {
  return {
    runId: 'Run ' + Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm'), trigger: trigger,
    discovered: 0, unique: 0, duplicatesSkipped: 0, prefilterRejected: 0, queued: 0, deferred: 0,
    sourceErrors: [], notes: [],
  };
}

/* ---------------------------- job sources ---------------------------------*/

function collectJobs_(profile) {
  const k = keys_();
  const reqs = [];
  const titles = profile.targetTitles.slice(0, 5);
  const locs = profile.locations.filter(l => !/^remote$/i.test(l)).slice(0, 3);
  const locList = locs.length ? locs : [''];
  const country = profile.country || 'us';

  if (k.adzunaId && k.adzunaKey) {
    if (ADZUNA_COUNTRIES.indexOf(country) === -1) log_('WARN', 'Adzuna does not support country "' + country + '"; skipped.');
    else titles.forEach(t => locList.forEach(l => reqs.push({ source: 'Adzuna', request: adzunaUrl_(k, country, t, l, 50), parse: parseAdzuna_ })));
  }
  if (k.jooble) titles.forEach(t => locList.forEach(l => reqs.push({ source: 'Jooble', request: joobleRequest_(k, t, l), parse: parseJooble_ })));
  if (k.rapid) {
    // free plan ≈ 200 requests/month → at most 3 per day
    titles.slice(0, 3).forEach(t => reqs.push({
      source: 'JSearch', request: jsearchRequest_(k, t, locs[0] || '', country, profile.wantsRemote && !locs.length), parse: parseJSearch_,
    }));
  }
  if (profile.wantsRemote) {
    titles.slice(0, 3).forEach(t => reqs.push({
      source: 'Remotive', request: { url: 'https://remotive.com/api/remote-jobs?limit=50&search=' + enc_(t) }, parse: parseRemotive_,
    }));
  }
  profile.careerBoards.forEach(b => {
    const m = String(b).match(/^\s*(greenhouse|lever|ashby)\s*:\s*([A-Za-z0-9._-]+)\s*$/i);
    if (!m) { log_('WARN', 'Ignored career board "' + b + '" (use greenhouse:slug, lever:slug or ashby:slug)'); return; }
    const type = m[1].toLowerCase(), slug = m[2];
    const ctx = { slug: slug, profile: profile };
    if (type === 'greenhouse') reqs.push({ source: 'Greenhouse:' + slug, ctx: ctx, request: { url: 'https://boards-api.greenhouse.io/v1/boards/' + slug + '/jobs?content=true' }, parse: parseGreenhouse_ });
    if (type === 'lever') reqs.push({ source: 'Lever:' + slug, ctx: ctx, request: { url: 'https://api.lever.co/v0/postings/' + slug + '?mode=json' }, parse: parseLever_ });
    if (type === 'ashby') reqs.push({ source: 'Ashby:' + slug, ctx: ctx, request: { url: 'https://api.ashbyhq.com/posting-api/job-board/' + slug + '?includeCompensation=true' }, parse: parseAshby_ });
  });

  if (!reqs.length) throw new Error('No job sources configured. Add at least an Adzuna key (or JSearch/Jooble key, or a career board, or "Remote" as arrangement).');

  const jobs = [], errors = [];
  for (let i = 0; i < reqs.length; i += 15) {
    const chunk = reqs.slice(i, i + 15);
    const requests = chunk.map(r => Object.assign({ muteHttpExceptions: true }, r.request));
    let resps;
    try { resps = UrlFetchApp.fetchAll(requests); }
    catch (e) { // one bad host breaks fetchAll; fall back to one-by-one
      resps = requests.map(rq => { try { return UrlFetchApp.fetch(rq.url, rq); } catch (err) { return { error: err.message }; } });
    }
    resps.forEach((resp, idx) => {
      const r = chunk[idx];
      if (resp.error) { errors.push(r.source + ': ' + short_(resp.error)); return; }
      const code = resp.getResponseCode();
      if (code < 200 || code >= 300) { errors.push(r.source + ': HTTP ' + code + ' ' + short_(resp.getContentText())); return; }
      try {
        const parsed = r.parse(JSON.parse(resp.getContentText()), r.ctx || {}) || [];
        parsed.forEach(j => { if (j.title && j.company && j.url) jobs.push(clean_(j)); });
      } catch (e) { errors.push(r.source + ': could not read response (' + short_(e.message) + ')'); }
    });
  }
  errors.forEach(e => log_('WARN', 'Source error — ' + e));
  return { jobs: jobs, errors: errors };
}

function adzunaUrl_(k, country, title, loc, n) {
  return {
    url: 'https://api.adzuna.com/v1/api/jobs/' + country + '/search/1?app_id=' + enc_(k.adzunaId) + '&app_key=' + enc_(k.adzunaKey) +
      '&results_per_page=' + n + '&what=' + enc_(title) + (loc ? '&where=' + enc_(loc) : '') +
      '&max_days_old=' + APP.MAX_JOB_AGE_DAYS + '&sort_by=date&content-type=application/json',
  };
}

function parseAdzuna_(d) {
  return (d.results || []).map(j => {
    const predicted = String(j.salary_is_predicted) === '1';
    return {
      source: 'Adzuna', title: j.title, company: j.company && j.company.display_name,
      location: j.location && j.location.display_name, description: j.description, descriptionComplete: false,
      salary: (j.salary_min || j.salary_max) ? range_(j.salary_min, j.salary_max) + (predicted ? ' (estimated by Adzuna)' : '') : '',
      salaryMaxAnnual: predicted ? 0 : Number(j.salary_max || j.salary_min || 0),
      datePosted: j.created, url: j.redirect_url,
      employmentType: [j.contract_time, j.contract_type].filter(Boolean).join(', '),
    };
  });
}

function joobleRequest_(k, title, loc) {
  return {
    url: 'https://jooble.org/api/' + k.jooble, method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ keywords: title, location: loc || '', page: '1' }),
  };
}

function parseJooble_(d) {
  return (d.jobs || []).map(j => ({
    source: 'Jooble' + (j.source ? ' (' + j.source + ')' : ''), title: j.title, company: j.company, location: j.location,
    description: j.snippet, descriptionComplete: false, salary: j.salary || '', datePosted: j.updated,
    url: j.link, employmentType: j.type || '',
  }));
}

function jsearchRequest_(k, title, loc, country, remoteOnly) {
  const query = title + (loc ? ' in ' + loc : '');
  return {
    url: 'https://jsearch.p.rapidapi.com/search?query=' + enc_(query) + '&page=1&num_pages=1&date_posted=week&country=' + enc_(country) +
      (remoteOnly ? '&remote_jobs_only=true' : ''),
    headers: { 'X-RapidAPI-Key': k.rapid, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' },
  };
}

function parseJSearch_(d) {
  const mult = { HOUR: 2080, DAY: 260, WEEK: 52, MONTH: 12, YEAR: 1 };
  return (d.data || []).map(j => {
    const hl = j.job_highlights || {};
    const extra = Object.keys(hl).map(h => h + ':\n- ' + (hl[h] || []).join('\n- ')).join('\n\n');
    const months = j.job_required_experience && j.job_required_experience.required_experience_in_months;
    const max = Number(j.job_max_salary || j.job_min_salary || 0);
    return {
      source: 'JSearch (' + (j.job_publisher || 'Google for Jobs') + ')', title: j.job_title, company: j.employer_name,
      location: [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ') || j.job_location || '',
      arrangement: j.job_is_remote ? 'Remote' : '',
      description: (j.job_description || '') + (extra ? '\n\n' + extra : ''), descriptionComplete: true,
      salary: (j.job_min_salary || j.job_max_salary) ? (j.job_salary_currency || '') + ' ' + range_(j.job_min_salary, j.job_max_salary) + (j.job_salary_period ? ' / ' + j.job_salary_period.toLowerCase() : '') : '',
      salaryMaxAnnual: max * (mult[j.job_salary_period] || 1),
      experience: months ? (Math.round(months / 12 * 10) / 10) + '+ years' : '',
      datePosted: j.job_posted_at_datetime_utc || '', deadline: j.job_offer_expiration_datetime_utc || '',
      url: j.job_apply_link || j.job_google_link, careerUrl: j.employer_website || '',
      employmentType: j.job_employment_type || '',
    };
  });
}

function parseRemotive_(d) {
  return (d.jobs || []).map(j => ({
    source: 'Remotive', title: j.title, company: j.company_name, location: j.candidate_required_location || 'Remote',
    arrangement: 'Remote', description: htmlToText_(j.description), descriptionComplete: true, salary: j.salary || '',
    datePosted: j.publication_date, url: j.url, employmentType: j.job_type || '',
  }));
}

function parseGreenhouse_(d, ctx) {
  const company = titleCase_(ctx.slug);
  return (d.jobs || []).filter(j => boardJobRelevant_(j.title, j.location && j.location.name, ctx.profile)).map(j => ({
    source: 'Greenhouse', title: j.title, company: company, location: j.location && j.location.name,
    description: htmlToText_(decodeEntities_(j.content || '')), descriptionComplete: true,
    datePosted: j.first_published || j.updated_at, url: j.absolute_url,
    careerUrl: 'https://boards.greenhouse.io/' + ctx.slug,
  }));
}

function parseLever_(d, ctx) {
  const company = titleCase_(ctx.slug);
  return (Array.isArray(d) ? d : []).filter(j => boardJobRelevant_(j.text, j.categories && j.categories.location, ctx.profile)).map(j => {
    const lists = (j.lists || []).map(l => l.text + ':\n' + htmlToText_(l.content)).join('\n\n');
    const sr = j.salaryRange;
    return {
      source: 'Lever', title: j.text, company: company, location: j.categories && j.categories.location,
      arrangement: { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' }[j.workplaceType] || '',
      description: [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join('\n\n'), descriptionComplete: true,
      salary: sr ? (sr.currency || '') + ' ' + range_(sr.min, sr.max) + (sr.interval ? ' ' + sr.interval : '') : '',
      datePosted: j.createdAt ? new Date(j.createdAt).toISOString() : '', url: j.hostedUrl,
      careerUrl: 'https://jobs.lever.co/' + ctx.slug, employmentType: j.categories && j.categories.commitment,
    };
  });
}

function parseAshby_(d, ctx) {
  const company = titleCase_(ctx.slug);
  return (d.jobs || []).filter(j => boardJobRelevant_(j.title, (j.isRemote ? 'Remote ' : '') + (j.location || ''), ctx.profile)).map(j => ({
    source: 'Ashby', title: j.title, company: company, location: j.location || '',
    arrangement: j.isRemote ? 'Remote' : ({ Hybrid: 'Hybrid', OnSite: 'On-site', Remote: 'Remote' }[j.workplaceType] || ''),
    description: j.descriptionPlain || htmlToText_(j.descriptionHtml || ''), descriptionComplete: true,
    salary: j.compensation && j.compensation.compensationTierSummary || '',
    datePosted: j.publishedAt || '', url: j.jobUrl, careerUrl: 'https://jobs.ashbyhq.com/' + ctx.slug,
    employmentType: j.employmentType || '',
  }));
}

function boardJobRelevant_(title, location, profile) {
  if (titleOverlap_(title, profile.targetTitles) < 1) return false;
  const locs = profile.locations.filter(l => !/^remote$/i.test(l));
  const loc = String(location || '').toLowerCase();
  if (profile.wantsRemote && /remote|anywhere/.test(loc)) return true;
  if (!locs.length) return true;
  return locs.some(l => loc.indexOf(l.toLowerCase()) !== -1);
}

/* ------------------------- dedupe & prefilter ------------------------------*/

function dedupeInRun_(jobs) {
  const groups = [], byKey = {}, byUrl = {};
  jobs.forEach(j => {
    j.key = dedupKey_(j);
    j.nurl = normUrl_(j.url);
    j.hash = hash_(j.description);
    let gi = byKey[j.key];
    if (gi === undefined && j.nurl) gi = byUrl[j.nurl];
    if (gi === undefined) { gi = groups.length; groups.push(j); }
    else {
      const prev = groups[gi];
      const better = quality_(j) > quality_(prev) ? j : prev;
      const other = better === j ? prev : j;
      better.alsoOn = uniq_((better.alsoOn || []).concat([other.source], other.alsoOn || []));
      ['careerUrl', 'salary', 'experience', 'deadline', 'datePosted', 'arrangement'].forEach(f => { if (!better[f] && other[f]) better[f] = other[f]; });
      if (!better.salaryMaxAnnual && other.salaryMaxAnnual) better.salaryMaxAnnual = other.salaryMaxAnnual;
      groups[gi] = better;
    }
    byKey[j.key] = gi;
    if (j.nurl) byUrl[j.nurl] = gi;
  });
  return groups;
}

function quality_(j) {
  return (j.descriptionComplete ? 2 : 0) + (/Greenhouse|Lever|Ashby/.test(j.source) ? 1 : 0) + Math.min((j.description || '').length, 5000) / 5000;
}

function loadSeen_() {
  const data = sheet_(APP.SHEETS.SEEN).getDataRange().getValues().slice(1);
  const byKey = {}, byUrl = {};
  data.forEach(r => {
    const e = { date: new Date(r[0]).getTime() || 0, key: r[1], url: r[2], hash: r[3] };
    (byKey[e.key] = byKey[e.key] || []).push(e);
    if (e.url) (byUrl[e.url] = byUrl[e.url] || []).push(e);
  });
  return { byKey: byKey, byUrl: byUrl };
}

function classifyAgainstSeen_(j, seen) {
  const urlHits = j.nurl ? (seen.byUrl[j.nurl] || []) : [];
  if (urlHits.length) {
    const last = urlHits.reduce((a, b) => (b.date > a.date ? b : a));
    if (last.hash === j.hash) return { dup: true };
    // same posting URL, different content → the posting changed → new row
    return { dup: false, changedFrom: Utilities.formatDate(new Date(last.date), tz_(), 'yyyy-MM-dd') };
  }
  const cutoff = Date.now() - APP.DEDUP_WINDOW_DAYS * 86400000;
  if ((seen.byKey[j.key] || []).some(e => e.date >= cutoff)) return { dup: true }; // same job seen on another site
  return { dup: false };
}

function prefilter_(jobs, profile) {
  const keep = [], rejected = [];
  const now = Date.now();
  const skillRes = profile.skills.map(s => wordRe_(s));
  jobs.forEach(j => {
    const tl = j.title.toLowerCase();
    if (profile.exclude.some(x => tl.indexOf(x) !== -1)) { rejected.push([j, 'excluded keyword']); return; }
    const age = j.datePosted ? (now - new Date(j.datePosted).getTime()) / 86400000 : NaN;
    if (!isNaN(age) && age > APP.MAX_JOB_AGE_DAYS) { rejected.push([j, 'too old']); return; }
    if (profile.minSalary && j.salaryMaxAnnual && j.salaryMaxAnnual < profile.minSalary) { rejected.push([j, 'salary below minimum']); return; }
    const overlap = titleOverlap_(j.title, profile.targetTitles);
    if (overlap < 0.5) { rejected.push([j, 'title not relevant']); return; }
    const desc = j.description || '';
    const hits = skillRes.filter(re => re.test(desc)).length;
    j._rank = overlap * 2 + (skillRes.length ? hits / skillRes.length : 0) +
      (!isNaN(age) ? Math.max(0, 1 - age / APP.MAX_JOB_AGE_DAYS) * 0.5 : 0) + (j.descriptionComplete ? 0.3 : 0);
    keep.push(j);
  });
  keep.sort((a, b) => b._rank - a._rank);
  return { keep: keep, rejected: rejected };
}

const TITLE_STOP = ['and', 'of', 'the', 'for', 'in', 'a', 'an', 'senior', 'sr', 'junior', 'jr', 'lead', 'i', 'ii', 'iii', 'iv', 'staff', 'principal', 'associate', 'remote', 'hybrid', '-', '/'];

function titleOverlap_(title, targets) {
  const tTokens = norm_(title).split(' ').filter(Boolean);
  let best = 0;
  targets.forEach(t => {
    const words = norm_(t).split(' ').filter(w => w.length > 1 && TITLE_STOP.indexOf(w) === -1);
    if (!words.length) return;
    const hit = words.filter(w => tTokens.some(x => x === w || x.indexOf(w) === 0)).length;
    best = Math.max(best, hit / words.length);
  });
  return best;
}

function enqueue_(jobs, runId) {
  if (!jobs.length) return;
  const sh = sheet_(APP.SHEETS.QUEUE);
  const now = new Date();
  const rows = jobs.map(j => {
    const copy = Object.assign({}, j);
    delete copy._rank;
    copy.description = String(copy.description || '').slice(0, APP.MAX_DESC_CHARS);
    return [now, runId, 'pending', j.key, JSON.stringify(copy), '', '', '', '', '', j.title, j.company].map(safeCell_);
  });
  ensureRows_(sh, sh.getLastRow() + rows.length);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, QUEUE_HEADERS.length).setValues(rows);
}

function appendSeen_(jobs) {
  if (!jobs.length) return;
  const sh = sheet_(APP.SHEETS.SEEN);
  const now = new Date().toISOString();
  const rows = jobs.map(j => [now, j.key, j.nurl || '', j.hash, j.title, j.company, j.source]);
  ensureRows_(sh, sh.getLastRow() + rows.length);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, SEEN_HEADERS.length).setValues(rows.map(r => r.map(safeCell_)));
}

function countQueue_(status) {
  return sheet_(APP.SHEETS.QUEUE).getDataRange().getValues().slice(1).filter(r => r[Q.STATUS] === status).length;
}

/* ============================================================================
 * RUN PHASE 2 — SCORE, TAILOR, CREATE DOCS, UPDATE TRACKER
 * ==========================================================================*/

function processQueue_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { log_('WARN', 'Queue already being processed; skipped.'); return; }
  const start = Date.now();
  try {
    const stats = getRunState_();
    if (!stats) return;
    let profile, resume;
    try { profile = getProfile_(); resume = getResume_(profile, false); }
    catch (e) {
      stats.notes.push('Resume generation stopped: ' + e.message);
      setRunState_(stats); finishRun_(stats); return;
    }
    const sh = sheet_(APP.SHEETS.QUEUE);
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[Q.STATUS] !== 'pending') continue;
      if (Date.now() - start > APP.MAX_RUNTIME_MS) {
        scheduleContinue_();
        log_('INFO', 'Time budget reached; continuing in 1 minute.');
        return;
      }
      let job;
      try { job = JSON.parse(row[Q.JSON]); } catch (e) { writeQueueResult_(sh, i, row, stats.runId, { status: 'failed', error: 'Corrupt queue entry' }); continue; }
      let res;
      try { res = processJob_(job, profile, resume, row); }
      catch (e) {
        if (e.quota) {
          stats.notes.push('Free AI quota reached — ' + countQueue_('pending') + ' job(s) stay queued and will be processed on the next run.');
          log_('WARN', 'AI quota exhausted: ' + e.message);
          break;
        }
        log_('ERROR', 'Job "' + job.title + '" @ ' + job.company + ' failed: ' + e.message);
        res = { status: 'failed', error: short_(e.message) };
      }
      writeQueueResult_(sh, i, row, stats.runId, res);
    }
    setRunState_(stats);
    finishRun_(stats);
  } finally {
    lock.releaseLock();
  }
}

function writeQueueResult_(sh, i, row, runId, res) {
  sh.getRange(i + 1, Q.STATUS + 1, 1, 8).setValues([[
    res.status, row[Q.KEY], row[Q.JSON], runId, res.score == null ? '' : res.score, res.category || '', res.docUrl || '', res.error || '',
  ]]);
  SpreadsheetApp.flush();
}

function processJob_(job, profile, resume, row) {
  // 1. Verify the posting link
  const link = verifyUrl_(job.url);
  if (link.status === 'broken') return { status: 'rejected', category: 'Link broken', error: link.note };

  // 2. Score (AI gives per-dimension evidence scores; weighting is done here, deterministically)
  const ev = scoreJob_(job, profile, resume);
  if (ev.score < APP.MIN_SCORE) return { status: 'rejected', score: ev.score, category: ev.category };

  // 3. Tailored resume → Google Doc (reuse doc on retry)
  let docUrl = row[Q.DOC] || '', docStatus = '', docError = '';
  if (!docUrl) {
    try {
      const plan = tailorResume_(job, ev, profile, resume);
      const name = docName_(job.company, job.title);
      const doc = createTailoredDoc_(name, resume, plan.finalText);
      docUrl = doc.url;
      docStatus = doc.reused ? 'Created (existing doc reused)' :
        'Created: ' + plan.changed + ' line(s) reworded' + (plan.reordered ? ', bullets reordered' : '');
      if (plan.reverted) docStatus += '; ' + plan.reverted + ' AI edit(s) rejected by integrity check (original wording kept)';
    } catch (e) {
      if (e.quota) throw e;
      docError = short_(e.message);
      docStatus = 'Failed: ' + docError;
      log_('ERROR', 'Resume creation failed for ' + job.company + ': ' + e.message);
    }
  } else docStatus = 'Created';

  // 4. Tracker row
  const notes = [
    'Source: ' + job.source + (job.alsoOn && job.alsoOn.length ? ' (also on: ' + job.alsoOn.join(', ') + ')' : ''),
    job.datePosted ? 'Posted: ' + fmtDate_(job.datePosted) : '',
    job.deadline ? 'Deadline: ' + fmtDate_(job.deadline) : '',
    link.note,
    job.descriptionComplete ? '' : 'Job description was partial/unverified (source gives a snippet only) — read the full posting before applying.',
    ev.missing_mandatory.length ? 'Missing mandatory: ' + ev.missing_mandatory.join(', ') : '',
    job.changedFrom ? 'Posting changed since first seen on ' + job.changedFrom + ' (new row).' : '',
    'Score breakdown: ' + ev.breakdown,
  ].filter(Boolean).join('\n');

  const values = [
    Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'), job.title, job.company, job.location || '',
    ev.work_arrangement || job.arrangement || 'Not specified', ev.experience_required || job.experience || 'Not specified',
    job.salary || 'Not disclosed', ev.score, ev.category, ev.matching_skills.join(', '),
    ev.missing_skills.join(', ') + (ev.missing_mandatory.length ? (ev.missing_skills.length ? ' | ' : '') + 'MANDATORY: ' + ev.missing_mandatory.join(', ') : ''),
    ev.summary, job.url, job.careerUrl || '', docUrl, docStatus, 'Not Applied', notes,
  ];
  upsertTrackerRow_(values, job.url, docUrl, docStatus, !!job.changedFrom);
  return {
    status: docUrl ? 'done' : 'failed', score: ev.score, category: ev.category, docUrl: docUrl,
    error: docError,
  };
}

/* ---------------------------- scoring --------------------------------------*/

function scoreJob_(job, profile, resume) {
  const system = 'You are a strict, honest senior technical recruiter. You evaluate fit using only evidence written in the candidate resume. You never inflate scores. Output JSON only.';
  const user = [
    'CANDIDATE PREFERENCES:',
    profileText_(profile),
    '',
    'CANDIDATE RESUME (the only source of truth about the candidate):',
    '<<<', resume.text.slice(0, 12000), '>>>',
    '',
    'JOB POSTING:',
    'Title: ' + job.title, 'Company: ' + job.company, 'Location: ' + (job.location || 'n/a'),
    'Work arrangement: ' + (job.arrangement || 'not stated'), 'Employment type: ' + (job.employmentType || 'not stated'),
    'Salary: ' + (job.salary || 'not stated'),
    'Description is ' + (job.descriptionComplete ? 'complete' : 'PARTIAL (only a snippet) — be conservative'),
    '<<<', String(job.description || '').slice(0, APP.MAX_DESC_CHARS), '>>>',
    '',
    'Score each dimension from 0 to 100:',
    '- technical_skills: required/preferred skills of the job that the resume explicitly demonstrates',
    '- experience: years and seniority required vs the resume',
    '- responsibilities: how closely past duties in the resume match the job duties',
    '- industry: industry/domain alignment',
    '- location_arrangement: job location & work arrangement vs the candidate preferences above',
    '- education: degree/certification requirements vs the resume',
    'Rules: a similar job title alone is NOT evidence. If information is missing, do not assume the candidate has it. ',
    'matching_skills: only skills that literally appear in the resume AND are relevant to the job. ',
    'missing_skills: important job skills not in the resume. missing_mandatory: explicitly required (must-have) qualifications the resume does not show.',
    '',
    'Return JSON exactly in this shape:',
    '{"technical_skills":0,"experience":0,"responsibilities":0,"industry":0,"location_arrangement":0,"education":0,' +
    '"matching_skills":[],"missing_skills":[],"missing_mandatory":[],"experience_required":"e.g. 3-5 years or Not specified",' +
    '"work_arrangement":"Remote|Hybrid|On-site|Not specified","summary":"2-3 sentence factual summary of the job","keywords":["top 10 ATS keywords from the job"]}',
  ].join('\n');

  const r = callAI_(system, user, { maxTokens: 2048 });
  let total = 0;
  const parts = [];
  Object.keys(WEIGHTS).forEach(k => {
    const v = clamp_(Number(r[k]) || 0, 0, 100);
    total += v * WEIGHTS[k];
    parts.push(k.replace('_', ' ') + ' ' + v);
  });
  const lowerResume = resume.text.toLowerCase();
  const matching = arr_(r.matching_skills).filter(s => lowerResume.indexOf(s.toLowerCase()) !== -1 ||
    profile.skills.some(p => p.toLowerCase() === s.toLowerCase()));
  const mandatory = arr_(r.missing_mandatory);
  const penalty = Math.min(mandatory.length, 3) * APP.MANDATORY_GAP_PENALTY;
  const score = Math.round(clamp_(total - penalty, 0, 100));
  return {
    score: score, category: category_(score),
    breakdown: parts.join(', ') + (penalty ? ', mandatory-gap penalty -' + penalty : ''),
    matching_skills: matching, missing_skills: arr_(r.missing_skills), missing_mandatory: mandatory,
    experience_required: String(r.experience_required || ''), work_arrangement: String(r.work_arrangement || ''),
    summary: String(r.summary || ''), keywords: arr_(r.keywords),
  };
}

function category_(s) {
  if (s >= 85) return 'Excellent match';
  if (s >= 70) return 'Good match';
  if (s >= 55) return 'Moderate match';
  return 'Low match';
}

/* ---------------------------- tailoring ------------------------------------
 * Your uploaded resume is the TEMPLATE. Every tailored resume is an exact copy
 * of it; only the wording of existing summary / bullet / skills lines changes.
 * Nothing is added, removed, merged or split. Layout, fonts, sections, names,
 * employers, titles, dates, education and contact details are never touched.
 * --------------------------------------------------------------------------*/

const EDITABLE_TYPES = ['summary', 'bullet', 'skills'];

function tailorResume_(job, ev, profile, resume) {
  const lines = [];
  resume.paras.forEach(p => {
    if (p.type === 'heading') lines.push('\n== ' + p.text + ' ==');
    else if (p.type === 'role_header' || p.type === 'project_header') lines.push('(locked header) ' + p.text);
    else if (p.editable) lines.push('[' + p.id + '] (' + p.type + (p.type === 'bullet' ? ', group ' + p.group : '') + ') ' + p.text);
  });

  const system = 'You are an expert ATS resume editor bound by strict honesty rules. You only reword lines that already exist; you never add facts, lines or sections. Output JSON only.';
  const user = [
    'RESUME LINES (only lines with an [id] may be edited; everything else is locked):', lines.join('\n'), '',
    'TARGET JOB: ' + job.title + ' at ' + job.company,
    'JOB KEYWORDS: ' + ev.keywords.join(', '),
    'SKILLS THE CANDIDATE DOES NOT HAVE (never mention as theirs): ' + ev.missing_skills.concat(ev.missing_mandatory).join(', '),
    'JOB DESCRIPTION:', '<<<', String(job.description || '').slice(0, 6000), '>>>', '',
    'TASK: rewrite existing lines so the most relevant experience stands out for this job.',
    'STRICT RULES:',
    '1. Each edit replaces exactly ONE existing line (same id). Never add, delete, merge or split lines.',
    '2. Never invent experience, projects, skills, tools, certifications, metrics, achievements or responsibilities.',
    '3. A bullet rewrite may only use facts from that same bullet. Keep every number exactly as written. Do not add numbers.',
    '4. Do not exaggerate (e.g. "assisted" must not become "led"). Keep each line within about 20% of its original length.',
    '5. Use job keywords only where the original line genuinely supports them.',
    '6. "skills" lines: only REORDER the existing items (most relevant first). Keep any label such as "Languages:" unchanged. Do not reword, add or remove items.',
    '7. "summary" lines: rephrase using only facts found elsewhere in the resume.',
    '8. bullet_order (optional): reorder bullets inside a group, most relevant first. List every id of that group exactly once.',
    '9. Leave out lines that need no change.',
    '',
    'Return JSON exactly in this shape:',
    '{"edits":[{"id":0,"text":""}],"bullet_order":{"g0":[0,1,2]}}',
  ].join('\n');

  const r = callAI_(system, user, { maxTokens: 6000 });
  return planEdits_(r, resume.paras, resume.text, job.description || '');
}

/**
 * Code-level safety net. Decides the final text of every template line.
 * Anything that cannot be traced back to the original line keeps its original wording.
 */
function planEdits_(ai, paras, resumeText, jdText) {
  const byId = {};
  paras.forEach(p => { byId[p.id] = p; });
  const resumeLower = String(resumeText).toLowerCase();
  const jdLower = String(jdText).toLowerCase();
  const edited = {};
  let changed = 0, reverted = 0;

  (Array.isArray(ai.edits) ? ai.edits : []).forEach(e => {
    const p = byId[Number(e && e.id)];
    const t = String((e && e.text) || '').replace(/\s+/g, ' ').trim();
    if (!p || !p.editable || !t || t === p.text) return;
    let ok;
    if (p.type === 'skills') ok = sameSkillItems_(p.text, t);
    else if (p.type === 'summary') ok = textIsSafe_(t, resumeText, resumeLower, jdLower);
    else ok = textIsSafe_(t, p.text, resumeLower, jdLower);
    if (ok && t.length > p.text.length * 1.35 + 25) ok = false; // protects the template's page layout
    if (ok) { edited[p.id] = t; changed++; } else reverted++;
  });

  const finalText = {};
  paras.forEach(p => { finalText[p.id] = edited[p.id] != null ? edited[p.id] : p.text; });

  // Optional reordering of bullets inside the same group (a permutation, nothing gained or lost)
  const groups = {};
  paras.forEach(p => { if (p.editable && p.type === 'bullet') (groups[p.group] = groups[p.group] || []).push(p.id); });
  const order = ai.bullet_order && typeof ai.bullet_order === 'object' ? ai.bullet_order : {};
  const moved = {};
  Object.keys(groups).forEach(g => {
    const ids = groups[g];
    const want = (Array.isArray(order[g]) ? order[g] : []).map(Number);
    const valid = want.length === ids.length && ids.every(id => want.indexOf(id) !== -1);
    if (!valid || want.every((id, k) => id === ids[k])) return;
    ids.forEach((slot, k) => { moved[slot] = finalText[want[k]]; });
  });
  Object.keys(moved).forEach(slot => { finalText[slot] = moved[slot]; });

  return { finalText: finalText, changed: changed, reverted: reverted, reordered: Object.keys(moved).length > 0 };
}

function skillItems_(s) {
  const m = String(s).match(/^([^:]{1,40}):\s*(.*)$/);
  const label = m ? m[1].trim().toLowerCase() : '';
  const rest = m ? m[2] : String(s);
  return { label: label, items: rest.split(/\s*[,|•·;]\s*/).map(x => x.trim().toLowerCase()).filter(Boolean).sort() };
}

function sameSkillItems_(a, b) {
  const x = skillItems_(a), y = skillItems_(b);
  return x.label === y.label && x.items.join('\u0001') === y.items.join('\u0001');
}

/** True if `text` adds no new numbers and no job-only technical terms. */
function textIsSafe_(text, sourceText, resumeLower, jdLower) {
  const src = String(sourceText).replace(/[\s,]/g, '');
  const nums = text.match(/\d+(?:[.,]\d+)*/g) || [];
  for (const n of nums) if (src.indexOf(n.replace(/,/g, '')) === -1) return false;
  const words = text.split(/[\s,;:()\/]+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#]+$/g, '');
    if (w.length < 2) continue;
    const techy = /[A-Z].*[A-Z]/.test(w) || /[+#]/.test(w) || (i > 0 && /^[A-Z]/.test(w) && !/[.!?]$/.test(words[i - 1]));
    if (!techy) continue;
    const lw = w.toLowerCase();
    if (resumeLower.indexOf(lw) === -1 && jdLower.indexOf(lw) !== -1) return false; // term copied from the job, not in resume
  }
  return true;
}

/* ---------------------------- Google Doc (copy of your template) -----------*/

function docName_(company, title) {
  const part = s => String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return part(company) + '_' + part(title) + '_Customized_Resume_' + Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

function createTailoredDoc_(name, resume, finalText) {
  const folder = getFolder_();
  const existing = folder.getFilesByName(name);
  while (existing.hasNext()) {
    const f = existing.next();
    if (!f.isTrashed()) return { id: f.getId(), url: f.getUrl(), reused: true };
  }
  const copy = DriveApp.getFileById(resume.docId).makeCopy(name, folder);
  let ok = false;
  try {
    const doc = DocumentApp.openById(copy.getId());
    const els = textElements_(doc.getBody());
    if (els.length !== resume.paras.length) throw new Error('Your resume changed since it was last read — use menu → Re-read my resume');
    els.forEach((el, i) => {
      if (el.getText() !== resume.paras[i].raw) throw new Error('Template line ' + i + ' does not match — use menu → Re-read my resume');
    });
    resume.paras.forEach((p, i) => {
      const t = finalText[p.id];
      if (t != null && t !== p.text) replaceKeepingStyle_(els[i], t);
    });
    doc.saveAndClose();
    ok = true;
    return { id: copy.getId(), url: copy.getUrl(), reused: false };
  } finally {
    if (!ok) { try { copy.setTrashed(true); } catch (e) { /* ignore */ } }
  }
}

/** Replace a paragraph's words but keep its formatting (and a "Label:" prefix's own style). */
function replaceKeepingStyle_(el, newText) {
  const t = el.editAsText();
  const old = t.getText();
  const lead = old.length - old.replace(/^\s+/, '').length;
  const m = old.slice(lead).match(/^([^:]{1,40}:)/);
  const labelLen = m && newText.indexOf(m[1]) === 0 ? m[1].length : 0;
  const start = lead + labelLen;
  const newBody = newText.slice(labelLen).replace(/^\s+/, labelLen ? ' ' : '');
  const oldBodyLen = old.length - start;
  if (!newBody.trim() || oldBodyLen <= 0) return;
  const attrs = pickTextAttrs_(t.getAttributes(start));
  t.insertText(start, newBody);
  t.deleteText(start + newBody.length, start + newBody.length + oldBodyLen - 1);
  if (Object.keys(attrs).length) t.setAttributes(start, start + newBody.length - 1, attrs);
}

function pickTextAttrs_(a) {
  const A = DocumentApp.Attribute;
  const out = {};
  [A.FONT_FAMILY, A.FONT_SIZE, A.BOLD, A.ITALIC, A.UNDERLINE, A.STRIKETHROUGH, A.FOREGROUND_COLOR, A.BACKGROUND_COLOR]
    .forEach(k => { if (a && a[k] != null) out[k] = a[k]; });
  return out;
}

/** All non-empty paragraphs / list items in document order, including inside tables. */
function textElements_(container) {
  const out = [];
  const E = DocumentApp.ElementType;
  const walk = el => {
    const type = el.getType();
    if (type === E.PARAGRAPH || type === E.LIST_ITEM) {
      const p = type === E.PARAGRAPH ? el.asParagraph() : el.asListItem();
      if (p.getText().trim()) out.push(p);
      return;
    }
    if (type === E.TABLE) {
      const table = el.asTable();
      for (let r = 0; r < table.getNumRows(); r++) {
        const row = table.getRow(r);
        for (let c = 0; c < row.getNumCells(); c++) walk(row.getCell(c));
      }
      return;
    }
    if (type === E.TABLE_CELL || type === E.BODY_SECTION) {
      for (let i = 0; i < el.getNumChildren(); i++) walk(el.getChild(i));
    }
  };
  walk(container);
  return out;
}

/* ---------------------------- tracker --------------------------------------*/

function upsertTrackerRow_(values, jobUrl, docUrl, docStatus, isChangedPosting) {
  const sh = sheet_(APP.SHEETS.TRACKER);
  const last = sh.getLastRow();
  if (last > 1) {
    const links = sh.getRange(2, T.URL, last - 1, 1).getRichTextValues();
    const dates = sh.getRange(2, T.DATE, last - 1, 1).getDisplayValues();
    const statuses = sh.getRange(2, T.DOC_STATUS, last - 1, 1).getValues();
    const today = values[0];
    for (let i = links.length - 1; i >= 0; i--) {
      const url = links[i][0].getLinkUrl() || links[i][0].getText();
      if (url !== jobUrl) continue;
      // Same job already written: only repair the resume link/status (never touch Application Status / Notes)
      if (String(statuses[i][0]).indexOf('Failed') === 0 && docUrl) {
        sh.getRange(i + 2, T.DOC).setRichTextValue(link_('Open resume', docUrl));
        sh.getRange(i + 2, T.DOC_STATUS).setValue(docStatus);
        return;
      }
      if (!isChangedPosting || dates[i][0] === today) return; // never duplicate a row
      break; // changed posting → add as a new row
    }
  }
  const r = last + 1;
  ensureRows_(sh, r);
  const safe = values.map(safeCell_);
  safe[T.URL - 1] = ''; safe[T.CAREER - 1] = ''; safe[T.DOC - 1] = '';
  sh.getRange(r, 1, 1, TRACKER_HEADERS.length).setValues([safe]);
  sh.getRange(r, T.DATE).setNumberFormat('yyyy-mm-dd');
  sh.getRange(r, T.APP_STATUS).setDataValidation(statusRule_());
  if (values[T.URL - 1]) sh.getRange(r, T.URL).setRichTextValue(link_('View job posting', values[T.URL - 1]));
  if (values[T.CAREER - 1]) sh.getRange(r, T.CAREER).setRichTextValue(link_('Company careers', values[T.CAREER - 1]));
  if (values[T.DOC - 1]) sh.getRange(r, T.DOC).setRichTextValue(link_('Open resume', values[T.DOC - 1]));
  sh.getRange(r, 1, 1, TRACKER_HEADERS.length).setVerticalAlignment('top').setWrap(true);
  SpreadsheetApp.flush();
  const check = sh.getRange(r, T.TITLE).getValue();
  if (String(check) !== String(values[T.TITLE - 1])) throw new Error('Tracker row verification failed');
}

function link_(label, url) {
  return SpreadsheetApp.newRichTextValue().setText(label).setLinkUrl(url).build();
}

/* ---------------------------- report ---------------------------------------*/

function finishRun_(stats) {
  const rows = sheet_(APP.SHEETS.QUEUE).getDataRange().getValues().slice(1).filter(r => r[Q.PROC_RUN] === stats.runId);
  const c = { excellent: 0, good: 0, moderate: 0, low: 0, broken: 0, created: 0, failed: 0 };
  const docs = [];
  rows.forEach(r => {
    const cat = r[Q.CAT];
    if (cat === 'Excellent match') c.excellent++;
    else if (cat === 'Good match') c.good++;
    else if (cat === 'Moderate match') c.moderate++;
    else if (cat === 'Low match') c.low++;
    else if (cat === 'Link broken') c.broken++;
    if (r[Q.STATUS] === 'failed') c.failed++;
    if (r[Q.DOC] && r[Q.STATUS] === 'done') { c.created++; docs.push({ title: r[Q.TITLE], company: r[Q.COMPANY], url: r[Q.DOC], score: r[Q.SCORE] }); }
  });
  const stillQueued = countQueue_('pending');
  const rejected = stats.prefilterRejected + c.moderate + c.low + c.broken;
  const failedOps = c.failed + stats.sourceErrors.length;
  const ssUrl = ss_().getUrl();
  const notes = stats.notes.concat(stats.sourceErrors.map(e => 'Source error: ' + e));
  if (!docs.length) notes.unshift('No qualifying new opportunities were discovered in this run.');

  sheet_(APP.SHEETS.REPORTS).appendRow([
    stats.runId, stats.trigger, stats.discovered, stats.unique, stats.duplicatesSkipped,
    c.excellent, c.good, c.moderate, c.low, rejected, c.created, failedOps, stillQueued,
    docs.map(d => d.url).join('\n'), notes.join('\n'),
  ].map(safeCell_));

  const li = (k, v) => '<tr><td style="padding:3px 12px 3px 0;color:#555">' + k + '</td><td style="padding:3px 0"><b>' + v + '</b></td></tr>';
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px">' +
    '<h2 style="color:#1f3864;margin:0 0 8px">AI Job Search — ' + esc_(stats.runId) + '</h2>' +
    '<table>' + li('Jobs discovered', stats.discovered) + li('Unique jobs', stats.unique) + li('Already seen (skipped)', stats.duplicatesSkipped) +
    li('Excellent matches (85+)', c.excellent) + li('Good matches (70–84)', c.good) + li('Moderate matches (55–69)', c.moderate) +
    li('Low matches (<55)', c.low) + li('Rejected total', rejected + ' <span style="color:#777">(' + stats.prefilterRejected + ' by pre-filter, ' + c.broken + ' broken links)</span>') +
    li('Customized resumes created', c.created) + li('Failed operations', failedOps) + li('Still queued', stillQueued) + '</table>' +
    (docs.length ? '<h3>New resumes</h3><ul>' + docs.map(d => '<li><a href="' + esc_(d.url) + '">' + esc_(d.company + ' — ' + d.title) + '</a> (score ' + d.score + ')</li>').join('') + '</ul>' : '') +
    (notes.length ? '<h3>Notes</h3><ul>' + notes.map(n => '<li>' + esc_(n) + '</li>').join('') + '</ul>' : '') +
    '<p><a href="' + ssUrl + '">Open AI Job Search Tracker</a></p>' +
    '<p style="color:#777;font-size:12px">Nothing was applied for or sent to employers. Review every resume before using it.</p></div>';
  try {
    MailApp.sendEmail({ to: reportEmail_(), subject: 'AI Job Search ' + stats.runId + ': ' + c.created + ' new tailored resume(s)', htmlBody: html });
  } catch (e) { log_('ERROR', 'Could not send report email: ' + e.message); }
  PropertiesService.getScriptProperties().deleteProperty('CURRENT_RUN');
  log_('INFO', 'Run ' + stats.runId + ' finished: ' + c.created + ' resumes, ' + failedOps + ' failures.');
}

function sendFailureEmail_(msg) {
  try {
    MailApp.sendEmail({
      to: reportEmail_(), subject: 'AI Job Search: run stopped — action needed',
      htmlBody: '<p>The daily job search could not run:</p><p><b>' + esc_(msg) + '</b></p><p><a href="' + ss_().getUrl() + '">Open the tracker</a></p>',
    });
  } catch (e) { log_('ERROR', 'Could not send failure email: ' + e.message); }
}

/* ============================================================================
 * RESUME — your uploaded resume is the source of truth AND the template
 * ==========================================================================*/

const LINE_TYPES = ['name', 'contact', 'heading', 'summary', 'skills', 'role_header', 'project_header', 'bullet', 'education', 'certification', 'other'];

function getResume_(profile, force) {
  const id = extractDocId_(profile.resumeUrl);
  if (!id) throw new Error('Upload your resume (menu → Upload my resume) or paste its Google Doc link in the Profile tab.');
  let doc;
  try { doc = DocumentApp.openById(id); }
  catch (e) { throw new Error(resumeAccessMessage_()); }
  const els = textElements_(doc.getBody());
  const raws = els.map(e => e.getText());
  const text = raws.join('\n');
  if (text.trim().length < 200) throw new Error('Your resume document looks empty or too short to use.');

  const h = hash_(text) + ':' + raws.length;
  const cache = sheet_(APP.SHEETS.CACHE);
  if (!force && cache.getLastRow() >= 2 && cache.getRange(2, 1).getValue() === h) {
    const paras = JSON.parse(cache.getRange(2, 2).getValue());
    return { docId: id, text: text, paras: applyLockOverrides_(paras) };
  }

  // One AI call labels every line of the template (cached until the resume changes)
  const E = DocumentApp.ElementType;
  const listing = raws.map((r, i) => '[' + i + ']' + (els[i].getType() === E.LIST_ITEM ? ' (list item)' : '') + ' ' + r.replace(/\s+/g, ' ').trim().slice(0, 300)).join('\n');
  const system = 'You label the lines of a resume. You never change any text. Output JSON only.';
  const user = 'Label every numbered line of this resume with exactly one type:\n' +
    'name, contact (email/phone/links/address), heading (section title like "Experience"), summary (profile/objective text), ' +
    'skills (a line listing skills/tools), role_header (job title, company, location or dates of a job), project_header (project name/tech/dates line), ' +
    'bullet (an achievement/responsibility line under a job or project), education, certification, other.\n\n' +
    listing + '\n\nReturn JSON: {"labels":[{"id":0,"type":"name"}]} with one entry per line.';
  const ai = callAI_(system, user, { maxTokens: 4096 });
  const labels = {};
  (Array.isArray(ai.labels) ? ai.labels : []).forEach(l => { if (l && LINE_TYPES.indexOf(l.type) !== -1) labels[Number(l.id)] = l.type; });

  const paras = buildParas_(raws, labels);
  writeResumeView_(paras);
  cache.clear();
  cache.getRange(1, 1, 2, 3).setValues([['Hash', 'JSON', 'Updated'], [h, JSON.stringify(paras), new Date()]]);
  log_('INFO', 'Resume template indexed: ' + paras.length + ' lines, ' + paras.filter(p => p.editable).length + ' editable.');
  return { docId: id, text: text, paras: applyLockOverrides_(paras) };
}

/** Pure: turns raw lines + AI labels into the locked/editable template map. */
function buildParas_(raws, labels) {
  let group = 'g0';
  return raws.map((raw, i) => {
    const text = raw.replace(/\s+/g, ' ').trim();
    const type = labels[i] || 'other';
    if (type === 'heading' || type === 'role_header' || type === 'project_header') group = 'g' + i;
    let editable = EDITABLE_TYPES.indexOf(type) !== -1;
    // extra safety: anything that looks like dates or contact details is always locked
    if (editable && type !== 'skills' && text.length < 80 && /\b(19|20)\d{2}\b/.test(text)) editable = false;
    if (editable && /@[a-z0-9-]+\.[a-z]|https?:\/\/|\+?\d[\d\s().-]{8,}\d/i.test(text) && type !== 'bullet') editable = false;
    return { id: i, type: type, group: type === 'bullet' ? group : '', editable: editable, raw: raw, text: text };
  });
}

/** You can set "AI may edit?" to No on the "Resume (parsed)" tab to lock any line. */
function applyLockOverrides_(paras) {
  try {
    const sh = ss_().getSheetByName(APP.SHEETS.RESUME);
    if (!sh || sh.getLastRow() < 2) return paras;
    const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
    vals.forEach(r => {
      const p = paras[Number(r[0])];
      if (p && /^no$/i.test(String(r[3]).trim())) p.editable = false;
    });
  } catch (e) { /* view sheet optional */ }
  return paras;
}

function writeResumeView_(paras) {
  const view = sheet_(APP.SHEETS.RESUME);
  view.clear();
  view.getRange(1, 1, 1, 5).setValues([['Line', 'Type', 'Group', 'AI may edit?', 'Text (from your template)']]).setFontWeight('bold');
  if (paras.length) {
    ensureRows_(view, paras.length + 1);
    view.getRange(2, 1, paras.length, 5).setValues(paras.map(p => [p.id, p.type, p.group, p.editable ? 'Yes' : 'Locked', safeCell_(p.text)]));
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No', 'Locked'], true).setAllowInvalid(true).build();
    view.getRange(2, 4, paras.length, 1).setDataValidation(rule);
  }
  view.setFrozenRows(1);
  view.setColumnWidth(5, 650);
}

function resumeAccessMessage_() {
  return 'Cannot open your resume. Use menu → Upload my resume, or make sure the Profile link points to a Google Doc this Google account can open.';
}

/* ---------------------------- upload ---------------------------------------*/

function uploadResumeDialog() {
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial,sans-serif;font-size:14px">' +
    '<p>Choose your resume. <b>Word (.docx) or Google Docs keep your layout best</b>; PDF also works but its formatting may be simplified.</p>' +
    '<input type="file" id="f" accept=".docx,.doc,.odt,.rtf,.pdf,.txt"><br><br>' +
    '<button id="b" onclick="go()">Upload &amp; read</button><p id="s" style="color:#1f3864"></p></div>' +
    '<script>function go(){var f=document.getElementById("f").files[0];var s=document.getElementById("s");' +
    'if(!f){s.textContent="Pick a file first.";return;}document.getElementById("b").disabled=true;s.textContent="Uploading and reading your resume… (up to a minute)";' +
    'var r=new FileReader();r.onload=function(){google.script.run.withSuccessHandler(function(m){s.textContent=m;})' +
    '.withFailureHandler(function(e){s.textContent="❌ "+e.message;document.getElementById("b").disabled=false;})' +
    '.uploadResume(f.name,String(r.result).split(",")[1]);};r.readAsDataURL(f);}</script>')
    .setWidth(460).setHeight(280);
  ui_().showModalDialog(html, 'Upload your resume (base template)');
}

/** Called from the upload dialog. Converts the file to a Google Doc that becomes your template. */
function uploadResume(fileName, b64) {
  if (typeof Drive === 'undefined' || !Drive.Files) {
    throw new Error('One-time step: in the Apps Script editor click Services (+) → "Drive API" → Add, save, then upload again.');
  }
  const types = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
    odt: 'application/vnd.oasis.opendocument.text', rtf: 'application/rtf', pdf: 'application/pdf', txt: 'text/plain',
  };
  const ext = String(fileName).split('.').pop().toLowerCase();
  if (!types[ext]) throw new Error('Unsupported file. Use .docx, .doc, .odt, .rtf, .pdf or .txt');
  const blob = Utilities.newBlob(Utilities.base64Decode(b64), types[ext], fileName);
  const folder = getFolder_();
  const name = 'Original Resume (base template) - ' + String(fileName).replace(/\.[^.]+$/, '');
  const file = Drive.Files.create
    ? Drive.Files.create({ name: name, mimeType: MimeType.GOOGLE_DOCS, parents: [folder.getId()] }, blob)            // Drive API v3
    : Drive.Files.insert({ title: name, mimeType: MimeType.GOOGLE_DOCS, parents: [{ id: folder.getId() }] }, blob, { convert: true }); // v2
  const url = 'https://docs.google.com/document/d/' + file.id + '/edit';
  setProfileValue_('resume_url', url);
  const r = getResume_(getProfile_(), true);
  const editable = r.paras.filter(p => p.editable).length;
  return '✅ Uploaded as a Google Doc and set as your base template. Found ' + r.paras.length + ' lines; ' + editable +
    ' (summary, bullets, skills) may be reworded per job, everything else is locked. Open it from the Drive folder to check the layout, then review the "Resume (parsed)" tab. You can close this window.';
}

function setProfileValue_(key, value) {
  const sh = sheet_(APP.SHEETS.PROFILE);
  const keys = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i][0]).trim() === key) { sh.getRange(i + 1, 3).setValue(value); return; }
  }
  throw new Error('Profile row "' + key + '" not found — run Initial setup.');
}

/* ============================================================================
 * AI PROVIDERS (free tiers)
 * ==========================================================================*/

let LAST_CALL_ = {};

function callAI_(system, user, opts) {
  opts = opts || {};
  const k = keys_();
  const providers = [];
  if (k.gemini && opts.provider !== 'groq') providers.push(['Gemini', () => callGemini_(k.gemini, system, user, opts)]);
  if (k.groq && opts.provider !== 'gemini') providers.push(['Groq', () => callGroq_(k.groq, system, user, opts)]);
  if (!providers.length) throw new Error('No AI API key set. Menu → Set API keys.');
  const errs = [];
  let allQuota = true;
  for (const [name, fn] of providers) {
    try { return fn(); }
    catch (e) { errs.push(name + ': ' + short_(e.message)); if (!e.quota) allQuota = false; }
  }
  const err = new Error('AI call failed — ' + errs.join(' | '));
  err.quota = allQuota;
  throw err;
}

function callGemini_(key, system, user, opts) {
  const model = prop_('GEMINI_MODEL', APP.DEFAULT_GEMINI_MODEL);
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: Math.max(opts.maxTokens || 4096, 4096) * 2 },
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    pace_('gemini', APP.GEMINI_MIN_GAP_MS);
    const resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    const code = resp.getResponseCode(), body = resp.getContentText();
    if (code === 200) {
      const d = JSON.parse(body);
      const c = d.candidates && d.candidates[0];
      const text = c && c.content && c.content.parts ? c.content.parts.map(p => p.text || '').join('') : '';
      if (!text) throw new Error('Gemini returned no text (finishReason: ' + (c && c.finishReason) + ')');
      return parseJson_(text);
    }
    const daily = /per ?day|daily|PerDay/i.test(body);
    if ((code === 429 && !daily) || code >= 500) {
      if (attempt < 2) { Utilities.sleep(code === 429 ? 20000 : 5000); continue; }
    }
    const e = new Error('Gemini HTTP ' + code + ': ' + short_(body));
    e.quota = code === 429;
    throw e;
  }
}

function callGroq_(key, system, user, opts) {
  const payload = {
    model: APP.DEFAULT_GROQ_MODEL, temperature: 0.2, response_format: { type: 'json_object' },
    max_tokens: opts.maxTokens || 4096,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    pace_('groq', APP.GROQ_MIN_GAP_MS);
    const resp = UrlFetchApp.fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + key },
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    const code = resp.getResponseCode(), body = resp.getContentText();
    if (code === 200) {
      const d = JSON.parse(body);
      return parseJson_(d.choices[0].message.content);
    }
    if ((code === 429 || code >= 500) && attempt < 2) { Utilities.sleep(code === 429 ? 15000 : 5000); continue; }
    const e = new Error('Groq HTTP ' + code + ': ' + short_(body));
    e.quota = code === 429;
    throw e;
  }
}

function pace_(name, gap) {
  const wait = (LAST_CALL_[name] || 0) + gap - Date.now();
  if (wait > 0) Utilities.sleep(wait);
  LAST_CALL_[name] = Date.now();
}

function parseJson_(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('AI did not return valid JSON');
}

/* ============================================================================
 * HELPERS
 * ==========================================================================*/

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function ui_() { return SpreadsheetApp.getUi(); }
function tz_() { return ss_().getSpreadsheetTimeZone() || Session.getScriptTimeZone(); }
function toast_(m) { try { ss_().toast(m, 'AI Job Search', 8); } catch (e) { /* no UI in triggers */ } }
function prop_(k, d) { const v = PropertiesService.getScriptProperties().getProperty(k); return v == null || v === '' ? d : v; }

function keys_() {
  return {
    gemini: prop_('GEMINI_API_KEY', ''), groq: prop_('GROQ_API_KEY', ''),
    adzunaId: prop_('ADZUNA_APP_ID', ''), adzunaKey: prop_('ADZUNA_APP_KEY', ''),
    jooble: prop_('JOOBLE_API_KEY', ''), rapid: prop_('RAPIDAPI_KEY', ''),
  };
}

function getRunState_() { const s = prop_('CURRENT_RUN', ''); return s ? JSON.parse(s) : null; }
function setRunState_(s) { PropertiesService.getScriptProperties().setProperty('CURRENT_RUN', JSON.stringify(s)); }

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" is missing — run menu → Initial setup.');
  return sh;
}

function ensureRows_(sh, lastNeeded) {
  const max = sh.getMaxRows();
  if (lastNeeded > max) sh.insertRowsAfter(max, lastNeeded - max + 200);
}

function statusRule_() {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList(['Not Applied', 'Applied', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn', 'Skipped'], true)
    .setAllowInvalid(true).build();
}

function ensureSheet_(name, headers) {
  let sh = ss_().getSheetByName(name);
  if (!sh) sh = ss_().insertSheet(name);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  return sh;
}

function getFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* recreate */ } }
  const it = DriveApp.getFoldersByName(APP.FOLDER_NAME);
  let folder = null;
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) { folder = f; break; } }
  if (!folder) folder = DriveApp.createFolder(APP.FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function getProfile_() {
  const sh = sheet_(APP.SHEETS.PROFILE);
  const p = {};
  sh.getDataRange().getValues().slice(1).forEach(r => { if (r[0]) p[String(r[0]).trim()] = String(r[2] == null ? '' : r[2]).trim(); });
  const list = s => String(s || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
  const profile = {
    raw: p, currentTitle: p.current_title || '', targetTitles: list(p.target_titles), experienceYears: p.experience_years || '',
    skills: list(p.skills), industries: p.industries || '', locations: list(p.locations),
    country: String(p.country || '').toLowerCase().replace(/[^a-z]/g, ''), arrangement: p.arrangement || '',
    minSalary: Number(String(p.min_salary || '').replace(/[^\d.]/g, '')) || 0, employmentType: p.employment_type || '',
    noticePeriod: p.notice_period || '', education: p.education || '', other: p.other || '', resumeUrl: p.resume_url || '',
    careerBoards: list(p.career_boards), exclude: list(p.exclude_keywords).map(x => x.toLowerCase()),
    maxAiJobs: Math.max(1, Math.min(60, parseInt(p.max_ai_jobs, 10) || 25)), reportEmail: p.report_email || '',
  };
  profile.wantsRemote = /remote/i.test(profile.arrangement) || profile.locations.some(l => /^remote$/i.test(l));
  if (!profile.targetTitles.length) throw new Error('Fill in "Target job titles" on the Profile tab.');
  return profile;
}

function profileText_(p) {
  return [
    'Current title: ' + p.currentTitle, 'Target titles: ' + p.targetTitles.join(', '), 'Experience: ' + p.experienceYears + ' years',
    'Skills (self-declared): ' + p.skills.join(', '), 'Industries: ' + p.industries, 'Preferred locations: ' + p.locations.join(', '),
    'Preferred arrangement: ' + p.arrangement, 'Employment type: ' + p.employmentType, 'Minimum salary: ' + (p.minSalary || 'n/a'),
    'Notice period: ' + p.noticePeriod, 'Education: ' + p.education, 'Other: ' + p.other,
  ].join('\n');
}

function reportEmail_() { try { return getProfile_().reportEmail || Session.getEffectiveUser().getEmail(); } catch (e) { return Session.getEffectiveUser().getEmail(); } }

function verifyUrl_(url) {
  if (!/^https?:\/\//i.test(url || '')) return { status: 'broken', note: 'No valid posting URL' };
  try {
    const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0 (personal job tracker)' } });
    const c = r.getResponseCode();
    if (c === 404 || c === 410) return { status: 'broken', note: 'Posting link returned HTTP ' + c + ' (expired/removed)' };
    if (c >= 200 && c < 400) {
      const body = r.getContentText().slice(0, 200000).toLowerCase();
      if (/no longer (available|accepting applications)|job (has )?expired|position has been filled|this job is closed/.test(body)) {
        return { status: 'unverified', note: 'Link opens but page suggests the job may be closed — check manually' };
      }
      return { status: 'verified', note: 'Link verified (HTTP ' + c + ')' };
    }
    return { status: 'unverified', note: 'Link not verified — site blocks automated checks (HTTP ' + c + ')' };
  } catch (e) { return { status: 'unverified', note: 'Link not verified — check failed (' + short_(e.message) + ')' }; }
}

function testFetch_(name, req) {
  try {
    const r = UrlFetchApp.fetch(req.url, Object.assign({ muteHttpExceptions: true }, req));
    const c = r.getResponseCode();
    return c >= 200 && c < 300 ? '✅ ' + name : '❌ ' + name + ': HTTP ' + c + ' ' + short_(r.getContentText());
  } catch (e) { return '❌ ' + name + ': ' + short_(e.message); }
}

function scheduleContinue_() {
  deleteTriggers_('continueRun');
  ScriptApp.newTrigger('continueRun').timeBased().after(60 * 1000).create();
}

function deleteTriggers_(fn) {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t); });
}

function trimHousekeeping_() {
  // queue: drop finished entries older than 14 days
  const sh = sheet_(APP.SHEETS.QUEUE);
  const data = sh.getDataRange().getValues();
  const cutoff = Date.now() - 14 * 86400000;
  const keep = data.slice(1).filter(r => r[Q.STATUS] === 'pending' || new Date(r[Q.QUEUED]).getTime() >= cutoff);
  if (keep.length < data.length - 1) {
    sh.getRange(2, 1, Math.max(data.length - 1, 1), QUEUE_HEADERS.length).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, QUEUE_HEADERS.length).setValues(keep);
  }
  const log = ss_().getSheetByName(APP.SHEETS.LOG);
  if (log && log.getLastRow() > 3000) log.deleteRows(2, 1500);
}

function log_(level, msg) {
  console.log(level + ': ' + msg);
  try { const sh = ss_().getSheetByName(APP.SHEETS.LOG); if (sh) sh.appendRow([new Date(), level, safeCell_(String(msg).slice(0, 5000))]); } catch (e) { /* ignore */ }
}

function extractDocId_(url) {
  const m = String(url || '').match(/\/d\/([A-Za-z0-9_-]{20,})/) || String(url || '').match(/^([A-Za-z0-9_-]{25,})$/);
  return m ? m[1] : '';
}

function clean_(j) {
  j.title = htmlToText_(j.title).trim();
  j.company = htmlToText_(j.company).trim();
  j.location = htmlToText_(j.location || '').trim();
  j.description = htmlToText_(j.description || '');
  if (!j.arrangement) j.arrangement = guessArrangement_(j.title + ' ' + j.location + ' ' + j.description.slice(0, 3000));
  ['salary', 'experience', 'deadline', 'careerUrl', 'employmentType', 'datePosted'].forEach(f => { j[f] = j[f] ? String(j[f]) : ''; });
  j.salaryMaxAnnual = Number(j.salaryMaxAnnual) || 0;
  return j;
}

function guessArrangement_(text) {
  if (/\bhybrid\b/i.test(text)) return 'Hybrid';
  if (/\bremote\b|work from home|\bwfh\b/i.test(text)) return 'Remote';
  if (/\bon-?site\b|\bin-?office\b/i.test(text)) return 'On-site';
  return '';
}

function htmlToText_(s) {
  return decodeEntities_(String(s || '')
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

function decodeEntities_(s) {
  return String(s || '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
}

function norm_(s) { return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9+#]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function dedupKey_(j) {
  const company = norm_(j.company).replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|gmbh|plc|llp|lp|sa|ag|bv)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const title = norm_(j.title).replace(/\b(remote|hybrid|on site|onsite|wfh|work from home|full time|contract)\b/g, ' ').replace(/\bsr\b/g, 'senior').replace(/\bjr\b/g, 'junior').replace(/\s+/g, ' ').trim();
  return company + '|' + title;
}

function normUrl_(u) {
  u = String(u || '').trim();
  const m = u.match(/^(https?):\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!m) return '';
  const host = m[2].toLowerCase().replace(/^www\./, '');
  const path = m[3].replace(/\/+$/, '');
  const params = (m[4] || '').slice(1).split('&').filter(p => p && !/^(utm_[^=]*|se|v|ref|refid|src|source|trk|trackingid|from|gh_src|lever-source)=/i.test(p)).sort();
  return host + path + (params.length ? '?' + params.join('&') : '');
}

function hash_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, norm_(s).slice(0, 4000), Utilities.Charset.UTF_8);
  return 'h' + bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}


function wordRe_(s) { return new RegExp('(^|[^a-z0-9])' + String(s).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])', 'i'); }
function arr_(x) { return (Array.isArray(x) ? x : []).filter(v => v != null && v !== '').map(v => (typeof v === 'object' ? v : String(v).trim())); }
function uniq_(a) { const seen = {}; return a.filter(x => { const k = String(x).toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; }); }
function clamp_(v, a, b) { return Math.max(a, Math.min(b, v)); }
function range_(a, b) { a = Math.round(Number(a) || 0); b = Math.round(Number(b) || 0); return a && b && a !== b ? a.toLocaleString() + '–' + b.toLocaleString() : (a || b).toLocaleString(); }
function titleCase_(s) { return String(s).replace(/[-_.]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function enc_(s) { return encodeURIComponent(s); }
function esc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function short_(s) { return String(s || '').replace(/\s+/g, ' ').slice(0, 180); }
function mask_(s) { return s.length > 8 ? s.slice(0, 4) + '…' + s.slice(-3) : '••••'; }
function fmtDate_(d) { const t = new Date(d); return isNaN(t.getTime()) ? String(d) : Utilities.formatDate(t, tz_(), 'yyyy-MM-dd'); }
function safeCell_(v) { return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v; } // block formula injection from job text

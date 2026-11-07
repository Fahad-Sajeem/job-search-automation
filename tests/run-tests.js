/**
 * Offline test suite for Code.gs. Run with:  node tests/run-tests.js
 *
 * Google services (Docs, Drive, Sheets, UrlFetch) and the AI are replaced by
 * small fakes, so the tests need no internet, no API keys and no Google account.
 * They cover job parsing, duplicate detection, pre-filtering, scoring, and the
 * full resume-generation path (template copy → AI edits → integrity checks →
 * in-place text replacement).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ----------------------------- fakes -------------------------------------- */

const props = { GEMINI_API_KEY: 'test-key', FOLDER_ID: 'folder1' };
let aiResponder = () => ({});      // (systemPrompt, userPrompt) => object returned as AI JSON
const aiCalls = [];

global.Utilities = {
  computeDigest: (alg, s) => [...crypto.createHash('md5').update(String(s)).digest()].map(b => (b > 127 ? b - 256 : b)),
  DigestAlgorithm: { MD5: 'MD5' }, Charset: { UTF_8: 'UTF-8' },
  formatDate: (d, tz, fmt) => (fmt === 'HHmmss' ? '120000' : new Date(d).toISOString().slice(0, 10)),
  sleep: () => {},
};
global.Session = { getScriptTimeZone: () => 'UTC', getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) };
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; },
  }),
};
global.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSpreadsheetTimeZone: () => 'UTC', getSheetByName: () => null }) };
global.UrlFetchApp = {
  fetch: (url, opts) => {
    if (!/generativelanguage/.test(url)) throw new Error('Unexpected network call in tests: ' + url);
    const body = JSON.parse(opts.payload);
    const system = body.systemInstruction.parts[0].text, user = body.contents[0].parts[0].text;
    aiCalls.push({ system, user });
    const out = aiResponder(system, user);
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }),
    };
  },
};

// Minimal Google Docs model: paragraphs with plain text and per-character attributes.
function fakeParagraph(text, kind) {
  const p = {
    text, kind: kind || 'PARAGRAPH', attrs: [],
    getType: () => (p.kind === 'LIST_ITEM' ? 'LIST_ITEM' : 'PARAGRAPH'),
    asParagraph: () => p, asListItem: () => p,
    getText: () => p.text,
    editAsText: () => ({
      getText: () => p.text,
      getAttributes: () => ({ ff: 'Calibri', b: false }),
      insertText: (i, s) => { p.text = p.text.slice(0, i) + s + p.text.slice(i); },
      deleteText: (a, b) => { p.text = p.text.slice(0, a) + p.text.slice(b + 1); },
      setAttributes: (a, b, x) => { p.attrs.push([a, b, x]); },
    }),
  };
  return p;
}
function fakeBody(paras) {
  return { getType: () => 'BODY_SECTION', getNumChildren: () => paras.length, getChild: i => paras[i] };
}
const docs = {};       // id -> { name, paras, trashed }
let nextId = 1;
global.DocumentApp = {
  ElementType: { PARAGRAPH: 'PARAGRAPH', LIST_ITEM: 'LIST_ITEM', TABLE: 'TABLE', TABLE_CELL: 'TABLE_CELL', BODY_SECTION: 'BODY_SECTION' },
  Attribute: { FONT_FAMILY: 'ff', FONT_SIZE: 'fs', BOLD: 'b', ITALIC: 'i', UNDERLINE: 'u', STRIKETHROUGH: 's', FOREGROUND_COLOR: 'fc', BACKGROUND_COLOR: 'bc' },
  openById: id => ({ getBody: () => fakeBody(docs[id].paras), saveAndClose: () => {} }),
};
const fakeFolder = { getId: () => 'folder1', isTrashed: () => false, getFilesByName: () => ({ hasNext: () => false }) };
global.DriveApp = {
  getFolderById: () => fakeFolder,
  getFileById: id => ({
    makeCopy: name => {
      const cid = 'doc' + (nextId++);
      docs[cid] = { name, paras: docs[id].paras.map(p => fakeParagraph(p.text, p.kind)), trashed: false };
      return { getId: () => cid, getUrl: () => 'https://docs.google.com/document/d/' + cid, setTrashed: v => { docs[cid].trashed = v; } };
    },
  }),
};

/* ----------------------------- load Code.gs -------------------------------- */

const EXPORTS = ['normUrl_', 'dedupKey_', 'titleOverlap_', 'textIsSafe_', 'prefilter_', 'dedupeInRun_', 'clean_', 'classifyAgainstSeen_',
  'buildParas_', 'planEdits_', 'sameSkillItems_', 'replaceKeepingStyle_', 'scoreJob_', 'tailorResume_', 'createTailoredDoc_',
  'parseAdzuna_', 'parseJSearch_', 'parseLever_', 'docName_', 'category_', 'safeCell_', 'parseJson_', 'APP'];
const code = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const G = new Function(code + '\nreturn {' + EXPORTS.join(',') + '};')();

/* ----------------------------- runner -------------------------------------- */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'not equal') + '\n   expected ' + JSON.stringify(b) + '\n   got      ' + JSON.stringify(a)); };
const ok = (c, msg) => { if (!c) throw new Error(msg || 'assertion failed'); };

/* ----------------------------- sample data --------------------------------- */

const TEMPLATE = [
  ['Jane Doe'], ['jane@example.com | +91 98765 43210 | Bengaluru'],
  ['SUMMARY'], ['Data analyst with 4 years of experience turning sales data into dashboards and reports.'],
  ['SKILLS'], ['Languages: Python, SQL, R'], ['Tools: Power BI, Excel, Tableau'],
  ['EXPERIENCE'], ['Data Analyst, Acme Retail'], ['Jan 2021 – Present'],
  ['Built SQL dashboards in Power BI reducing report time by 30%.', 'LIST_ITEM'],
  ['Automated weekly sales reports with Python scripts for the sales team.', 'LIST_ITEM'],
  ['Assisted in migrating data warehouse tables to a new schema design.', 'LIST_ITEM'],
  ['EDUCATION'], ['B.Tech, Computer Science, XYZ University, 2020'],
];
const LABELS = { 0: 'name', 1: 'contact', 2: 'heading', 3: 'summary', 4: 'heading', 5: 'skills', 6: 'skills', 7: 'heading',
  8: 'role_header', 9: 'role_header', 10: 'bullet', 11: 'bullet', 12: 'bullet', 13: 'heading', 14: 'education' };
const JD = 'We are hiring a Data Analyst. Must have: SQL, Power BI, Python. Nice to have: Snowflake, Airflow, dbt. ' +
  'You will build dashboards for the sales team and automate reporting. 3+ years of experience required.';
const PROFILE = { currentTitle: 'Data Analyst', targetTitles: ['Data Analyst'], experienceYears: '4', skills: ['SQL', 'Python', 'Power BI'],
  industries: 'Retail', locations: ['Bengaluru'], arrangement: 'Hybrid', employmentType: 'Full-time', minSalary: 0, noticePeriod: '30 days',
  education: 'B.Tech', other: '', exclude: ['intern'], maxAiJobs: 25 };

function makeResume() {
  docs.template = { name: 'template', paras: TEMPLATE.map(([t, k]) => fakeParagraph(t, k)) };
  const raws = TEMPLATE.map(r => r[0]);
  return { docId: 'template', text: raws.join('\n'), paras: G.buildParas_(raws, LABELS) };
}

/* ----------------------------- tests: discovery ---------------------------- */

test('URL normalization strips tracking parameters', () => {
  eq(G.normUrl_('https://www.Adzuna.in/land/ad/123/?se=abc&utm_source=x&v=2'), 'adzuna.in/land/ad/123');
  eq(G.normUrl_('https://jobs.lever.co/acme/42?lever-source=li&team=data'), 'jobs.lever.co/acme/42?team=data');
});

test('Same job on two sites gets the same duplicate key', () => {
  eq(G.dedupKey_({ company: 'Acme Pvt. Ltd.', title: 'Sr. Data Analyst (Remote)' }), G.dedupKey_({ company: 'ACME', title: 'Senior Data Analyst' }));
});

test('Title relevance', () => {
  eq(G.titleOverlap_('Senior Data Analyst', ['Data Analyst']), 1);
  eq(G.titleOverlap_('Data Engineer', ['Data Analyst']), 0.5);
  eq(G.titleOverlap_('Marketing Manager', ['Data Analyst']), 0);
});

test('Adzuna parser: predicted salaries are not used for filtering', () => {
  const jobs = G.parseAdzuna_({ results: [{ title: '<b>Data</b> Analyst', company: { display_name: 'Acme' }, location: { display_name: 'Bengaluru' },
    description: 'Short snippet', redirect_url: 'https://adzuna.in/land/ad/1', created: '2026-11-07T00:00:00Z', salary_min: 800000, salary_max: 1200000, salary_is_predicted: '1' }] });
  const j = G.clean_(jobs[0]);
  eq(j.title, 'Data Analyst'); eq(j.salaryMaxAnnual, 0); ok(/estimated/.test(j.salary)); eq(j.descriptionComplete, false);
});

test('JSearch parser: publisher, remote flag and annualised salary', () => {
  const j = G.parseJSearch_({ data: [{ job_title: 'Data Analyst', employer_name: 'Beta', job_city: 'Pune', job_country: 'IN', job_is_remote: true,
    job_description: 'Full text', job_apply_link: 'https://linkedin.com/jobs/1', job_publisher: 'LinkedIn', job_min_salary: 50000, job_max_salary: 80000,
    job_salary_period: 'MONTH', job_salary_currency: 'INR', job_required_experience: { required_experience_in_months: 36 } }] })[0];
  eq(j.source, 'JSearch (LinkedIn)'); eq(j.arrangement, 'Remote'); eq(j.salaryMaxAnnual, 960000); eq(j.experience, '3+ years');
});

test('Lever parser: keeps only relevant titles in preferred locations', () => {
  const ctx = { slug: 'acme', profile: Object.assign({ wantsRemote: false }, PROFILE) };
  const jobs = G.parseLever_([
    { text: 'Data Analyst', categories: { location: 'Bengaluru' }, hostedUrl: 'https://jobs.lever.co/acme/1', descriptionPlain: 'x', lists: [] },
    { text: 'Data Analyst', categories: { location: 'London' }, hostedUrl: 'https://jobs.lever.co/acme/2', descriptionPlain: 'x', lists: [] },
    { text: 'Office Manager', categories: { location: 'Bengaluru' }, hostedUrl: 'https://jobs.lever.co/acme/3', descriptionPlain: 'x', lists: [] },
  ], ctx);
  eq(jobs.map(j => j.url), ['https://jobs.lever.co/acme/1']);
});

test('Cross-site duplicates are merged, keeping the fuller description', () => {
  const jobs = [
    { source: 'Adzuna', title: 'Data Analyst', company: 'Acme Ltd', url: 'https://a.com/1', description: 'short', descriptionComplete: false },
    { source: 'JSearch (LinkedIn)', title: 'Data Analyst', company: 'ACME', url: 'https://linkedin.com/jobs/9', description: 'long full description with SQL', descriptionComplete: true, careerUrl: 'https://acme.com' },
  ].map(G.clean_);
  const u = G.dedupeInRun_(jobs);
  eq(u.length, 1); ok(u[0].source.startsWith('JSearch')); eq(u[0].alsoOn, ['Adzuna']);
});

test('Seen-before detection: unchanged = skip, changed content = new row', () => {
  const j = G.dedupeInRun_([G.clean_({ source: 'Lever', title: 'Data Analyst', company: 'Acme', url: 'https://jobs.lever.co/acme/1', description: 'v1', descriptionComplete: true })])[0];
  const seen = { byKey: {}, byUrl: {} };
  seen.byUrl[j.nurl] = [{ date: Date.now() - 86400000, hash: j.hash }];
  ok(G.classifyAgainstSeen_(j, seen).dup, 'unchanged posting should be a duplicate');
  seen.byUrl[j.nurl][0].hash = 'hOLD';
  ok(G.classifyAgainstSeen_(j, seen).changedFrom, 'changed posting should come back as new');
});

test('Pre-filter removes excluded, irrelevant and low-salary jobs', () => {
  const mk = (title, extra) => G.clean_(Object.assign({ source: 'x', title, company: 'C', url: 'https://c.com/' + title, description: 'SQL' }, extra || {}));
  const pf = G.prefilter_([mk('Data Analyst'), mk('Data Analyst Intern'), mk('Chef'), mk('Junior Data Analyst', { salaryMaxAnnual: 100 })],
    Object.assign({}, PROFILE, { minSalary: 500000 }));
  eq(pf.keep.map(j => j.title), ['Data Analyst']);
  eq(pf.rejected.map(r => r[1]).sort(), ['excluded keyword', 'salary below minimum', 'title not relevant']);
});

test('Job text starting with = cannot become a spreadsheet formula', () => {
  eq(G.safeCell_('=HYPERLINK("x")'), '\'=HYPERLINK("x")'); eq(G.safeCell_('Data Analyst'), 'Data Analyst');
});

/* ----------------------------- tests: scoring ------------------------------ */

test('Scoring applies the 30/25/20/10/10/5 weights in code, plus mandatory-gap penalty', () => {
  aiResponder = () => ({ technical_skills: 90, experience: 80, responsibilities: 70, industry: 60, location_arrangement: 100, education: 100,
    matching_skills: ['SQL', 'Kubernetes'], missing_skills: ['Snowflake'], missing_mandatory: ['Airflow'], summary: 'A data role.', keywords: ['SQL'] });
  const ev = G.scoreJob_({ title: 'Data Analyst', company: 'Acme', description: JD, descriptionComplete: true }, PROFILE, makeResume());
  // 90*.3 + 80*.25 + 70*.2 + 60*.1 + 100*.1 + 100*.05 = 82, minus 5 for one missing mandatory = 77
  eq(ev.score, 77); eq(ev.category, 'Good match');
  eq(ev.matching_skills, ['SQL'], 'skills not in the resume must not be reported as matching');
});

test('Match categories', () => {
  eq([G.category_(90), G.category_(70), G.category_(60), G.category_(10)], ['Excellent match', 'Good match', 'Moderate match', 'Low match']);
});

/* ----------------------------- tests: resume generation -------------------- */

test('Template map: only summary, bullets and skills are editable', () => {
  const r = makeResume();
  eq(r.paras.filter(p => p.editable).map(p => p.id), [3, 5, 6, 10, 11, 12]);
  eq(r.paras[10].group, 'g9'); eq(r.paras[12].group, 'g9');
});

test('Integrity: skills can only be reordered, never added', () => {
  ok(G.sameSkillItems_('Languages: Python, SQL, R', 'Languages: SQL, R, Python'));
  ok(!G.sameSkillItems_('Languages: Python, SQL, R', 'Languages: Python, SQL, Scala'));
  ok(!G.sameSkillItems_('Languages: Python, SQL, R', 'Skills: Python, SQL, R'));
});

test('Integrity: invented numbers and job-only tools are rejected', () => {
  const resume = 'built sql dashboards in power bi reducing report time by 30%. python automation.';
  const jd = 'need kubernetes, snowflake and sql. power bi a plus.';
  ok(G.textIsSafe_('Built Power BI dashboards with SQL, cutting reporting time 30%', 'Built SQL dashboards in Power BI reducing report time by 30%', resume, jd));
  ok(!G.textIsSafe_('Built dashboards with SQL, cutting time 45%', 'Built SQL dashboards in Power BI reducing report time by 30%', resume, jd));
  ok(!G.textIsSafe_('Deployed dashboards on Kubernetes using SQL', 'Built SQL dashboards', resume, jd));
});

test('END-TO-END: tailored resume is a copy of the template with only allowed lines reworded', () => {
  const resume = makeResume();
  aiCalls.length = 0;
  aiResponder = () => ({
    edits: [
      { id: 3, text: 'Data analyst with 4 years of experience building sales dashboards and reports.' },        // ok
      { id: 5, text: 'Languages: SQL, Python, R' },                                                              // ok (reorder)
      { id: 6, text: 'Tools: Power BI, Excel, Snowflake' },                                                      // adds skill → reject
      { id: 10, text: 'Built Power BI dashboards with SQL, cutting reporting time by 30%.' },                    // ok
      { id: 11, text: 'Built Airflow pipelines to automate weekly sales reports in Python.' },                   // job-only tool → reject
      { id: 12, text: 'Led migration of 120 data warehouse tables to a new schema design.' },                    // new number → reject
      { id: 9, text: 'Jan 2019 – Present' },                                                                     // locked date → ignored
      { id: 14, text: 'M.Tech, Computer Science' },                                                              // locked education → ignored
      { id: 99, text: 'Brand-new invented achievement.' },                                                       // not a line → ignored
    ],
    bullet_order: { g9: [11, 10, 12] },
  });
  const ev = { keywords: ['SQL', 'Power BI'], missing_skills: ['Snowflake', 'Airflow'], missing_mandatory: [] };
  const job = { title: 'Data Analyst', company: 'Acme', description: JD };
  const plan = G.tailorResume_(job, ev, PROFILE, resume);
  eq(plan.changed, 3, 'accepted edits'); eq(plan.reverted, 3, 'rejected edits'); ok(plan.reordered, 'bullets reordered');
  ok(/Snowflake, Airflow/.test(aiCalls[0].user), 'AI was told which skills the candidate lacks');

  const doc = G.createTailoredDoc_(G.docName_('Acme', 'Data Analyst'), resume, plan.finalText);
  const copy = Object.values(docs).find(d => d.name === 'Acme_Data_Analyst_Customized_Resume_' + new Date().toISOString().slice(0, 10));
  ok(copy && !copy.trashed && doc.url.indexOf('docs.google.com') !== -1, 'copy created');
  const out = copy.paras.map(p => p.text);

  eq(out.length, TEMPLATE.length, 'no lines added or removed');
  [0, 1, 2, 4, 7, 8, 9, 13, 14].forEach(i => eq(out[i], TEMPLATE[i][0], 'locked line ' + i + ' unchanged'));
  eq(out[3], 'Data analyst with 4 years of experience building sales dashboards and reports.');
  eq(out[5], 'Languages: SQL, Python, R');
  eq(out[6], TEMPLATE[6][0], 'skills line with an added skill keeps original');
  // bullets reordered (11, 10, 12): rejected ones keep their original wording
  eq(out[10], TEMPLATE[11][0]);
  eq(out[11], 'Built Power BI dashboards with SQL, cutting reporting time by 30%.');
  eq(out[12], TEMPLATE[12][0]);
  ok(!out.join('\n').match(/Snowflake|Airflow|120|M\.Tech|2019|invented/), 'nothing fabricated reached the document');
  ok(docs.template.paras.every((p, i) => p.text === TEMPLATE[i][0]), 'original template untouched');
});

test('END-TO-END: a changed template is detected and the bad copy is discarded', () => {
  const resume = makeResume();
  docs.template.paras.push(fakeParagraph('A line added after the resume was read'));
  let threw = false;
  try { G.createTailoredDoc_('X_Y_Customized_Resume', resume, {}); } catch (e) { threw = /Re-read my resume/.test(e.message); }
  ok(threw, 'should ask to re-read the resume');
  ok(Object.values(docs).filter(d => d.name === 'X_Y_Customized_Resume').every(d => d.trashed), 'failed copy is trashed');
});

test('AI JSON wrapped in code fences is still parsed', () => {
  eq(G.parseJson_('```json\n{"a":1}\n```'), { a: 1 });
});

/* ----------------------------- run ----------------------------------------- */

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log('  ✔ ' + t.name); }
  catch (e) { failed++; console.log('  ✘ ' + t.name + '\n    ' + e.message); }
}
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' tests passed');
process.exit(failed ? 1 : 0);

# AI Job Search Assistant

This finds relevant jobs every morning, scores them against your resume, and makes a tailored copy of your resume for each good match (score 70+). It records everything in a Google Sheet.

It runs **entirely on free services**. There's no server, no coding agent, and nothing to install. It never applies to jobs or contacts anyone for you.

---

## What's in this folder

| File | What it is |
|---|---|
| `Code.gs` | The whole system. You paste it into a Google Sheet (*Extensions → Apps Script*). You never need to edit it. |
| `SETUP.md` | Detailed step-by-step setup and troubleshooting. |
| `tests/run-tests.js` | Offline automated tests (fake Google services + fake AI). Run with `node tests/run-tests.js`. |
| `README.md` | This overview. |

---

## Everything it uses, and the cost

All of these are free for **personal use**. None of them need a credit card.

| Service | Role | Required? | Cost | Free limits (as of Nov 2026) |
|---|---|---|---|---|
| **Google Sheets + Apps Script** | Runs the system and holds the tracker | Yes | Free with any Google account | About 90 min of scheduled run time per day. A normal daily run uses about 5–15 min. |
| **Google Drive + Docs** | Stores your template and the tailored resumes | Yes | Free (15 GB storage) | One resume Doc is about 50 KB |
| **Google Gemini API** | Scores jobs and rewrites resume lines | Yes | Free tier, no card | Limits change and vary by account; check yours in AI Studio. The script uses about 50 AI calls per day by default. |
| **Adzuna API** | Job listings, including India and 18 other countries | Recommended | Free key on sign-up, no card | Shown in your Adzuna dashboard. Commonly quoted as about 250 calls/day. The script uses about 5–15 per day. |
| **JSearch (RapidAPI)** | LinkedIn, Indeed and Glassdoor listings via Google for Jobs | Recommended | Free "Basic" plan, no card | A small monthly allowance (a hard cap, so you're **never charged**). The script uses at most 3 calls/day. Check the exact number on the JSearch pricing tab. |
| **Jooble API** | Extra job listings | Optional | Free key by email | Generous for personal use |
| **Groq API** | Backup AI if Gemini is busy or out of quota | Optional | Free tier, no card | Per-minute and per-day caps; only used as a fallback |
| **Remotive** | Remote jobs | Automatic | Free, no key | The script calls it at most 3 times/day |
| **Greenhouse / Lever / Ashby boards** | Jobs straight from companies you name | Optional | Free, public, no key | – |
| **Gmail (MailApp)** | Sends you the daily report | Automatic | Free | 100 emails/day (it sends 1) |

> **Note:** Free limits are set by each provider and can change. If a free limit runs out, nothing is charged. The script keeps the remaining jobs queued for the next day and says so in the report.
> **Privacy:** on Gemini's free tier, Google may use what you send (your resume and job ads) to improve its products.
> **Commercial use:** Adzuna's terms allow personal use freely. Business use needs their written agreement.

### Where to get each key
| Key | Sign-up page |
|---|---|
| Gemini | <https://aistudio.google.com/apikey> → *Create API key* |
| Adzuna | <https://developer.adzuna.com> → Register (gives an **App ID** + **App Key**) |
| JSearch | <https://rapidapi.com> → search **JSearch** → *Pricing* → subscribe to **Basic (free)** → copy `X-RapidAPI-Key` |
| Jooble | <https://jooble.org/api/about> |
| Groq | <https://console.groq.com/keys> |

---

## How it's set up

```
Google Sheet "AI Job Search Tracker"
 ├─ Tracker            ← one row per matching job (columns A–R); you edit Application Status & Notes
 ├─ Profile            ← your preferences (titles, skills, locations, salary, resume link…)
 ├─ Daily Reports      ← one row per run
 ├─ Resume (parsed)    ← every line of your template: "Yes" (may be reworded) or "Locked"
 └─ hidden: _queue, _seen, _resume_cache, _log   (history, duplicate memory, errors)

Apps Script (Code.gs, attached to the sheet)
 ├─ Menu: 🤖 AI Job Search
 ├─ Daily trigger 9:00 AM (sheet timezone)
 └─ API keys stored privately in Script Properties (not visible in the sheet)

Google Drive folder "AI Job Search - Customized Resumes"
 ├─ Original Resume (base template)        ← your uploaded resume, converted to a Google Doc
 └─ Company_Title_Customized_Resume_Date   ← one tailored copy per qualifying job
```

### Daily flow
1. **Find** jobs from all configured sources.
2. **Remove duplicates** across sites and against the last 60 days.
3. **Pre-filter** by title, age, salary and excluded words. This uses no AI.
4. **Check the link** of each shortlisted job. Dead links are rejected.
5. **Score** each job with Gemini, using your weights 30/25/20/10/10/5. Below 70 means rejected.
6. **Tailor:** the script copies your template Doc, and Gemini rewords only the existing summary, bullet and skills lines. The code rejects anything new (numbers, skills or tools not in your resume, extra lines).
7. **Track:** a new row is appended to the Tracker, with links to the posting and the resume.
8. **Report:** you get an email summary, and a row is added to Daily Reports.

### Your resume is the template
- Each tailored resume is an **exact copy** of your uploaded resume, so the layout and fonts stay the same.
- Only existing lines are reworded or reordered. Nothing is added or removed.
- Names, contact details, job titles, employers, dates, education and certifications are always locked.

---

## Quick start (full details in SETUP.md)

1. Get a Gemini key, and ideally Adzuna and JSearch keys too.
2. Go to <https://sheets.new>, then **Extensions → Apps Script**. Paste `Code.gs` and save.
3. In the Apps Script editor, click **Services (+) → Drive API → Add**. This is needed for Word/PDF upload.
4. Reload the sheet. In the **🤖 AI Job Search** menu, run these in order:
   1. **Initial setup**, then allow the permissions.
   2. Fill in the **Profile** tab.
   3. **Set API keys**.
   4. **Upload my resume**.
   5. **Test connections**.
   6. **🧪 Test tools → Test resume generation**: paste one real job description to see your tailored resume.
   7. **▶ Run job search now**.
   8. **⏰ Enable daily run**.

---

## Testing

### In the sheet (with your real resume and keys)
The **🤖 AI Job Search → 🧪 Test tools** menu has two tools:

| Tool | What it does | Saves anything? |
|---|---|---|
| **Test resume generation (paste a job)** | You paste a job title, company and description. It shows the score and breakdown, matching and missing skills, a link to a tailored resume, and every changed line (old wording crossed out in red, new wording in green). | Only a `TEST_…` Doc in the Drive folder (delete it when you're done). The Tracker isn't touched. |
| **Preview job search (no AI, nothing saved)** | Searches all sources and shows how many jobs were found, merged as duplicates, filtered out and shortlisted, plus the top 12 titles and any source errors. | Nothing. It uses a few job-API calls and no AI calls. |

Run these after setup to check everything before switching on the daily schedule.

### Automated tests (no keys or Google account needed)
```bash
node tests/run-tests.js
```
These tests replace Google Docs, Drive, Sheets and the AI with fakes. They check:
- job parsing for Adzuna, JSearch and Lever
- duplicate detection and changed-posting detection
- the pre-filter
- the scoring weights and the mandatory-gap penalty
- **end-to-end resume generation**:
  - the template is copied
  - allowed lines are reworded
  - invented numbers, tools and skills are rejected
  - locked lines (names, dates, education) never change
  - no lines are added or removed
  - the original template is never modified
  - a changed template is detected


## Coverage, honestly

| Site | Covered? |
|---|---|
| LinkedIn, Indeed, Glassdoor | Yes, through **JSearch** (Google for Jobs) |
| Naukri, Foundit | Partly, when the same jobs appear on Adzuna India or Jooble |
| Wellfound | No. Add the companies' own career boards instead. |
| Company career pages | Yes, for companies using Greenhouse, Lever or Ashby |

LinkedIn, Naukri, Indeed, Glassdoor, Foundit and Wellfound don't offer free public job APIs and forbid scraping, so the system uses only permitted sources.

## Safety
- It never applies to jobs, never emails recruiters, and never uploads your resume anywhere.
- Resumes stay private in your Drive.
- It never overwrites your Application Status or Notes.
- Failures are reported as **Failed**, never hidden.
- **Always review a tailored resume before you use it.**

# AI Job Search Assistant: setup guide (free, no coding agent)

Everything runs inside **one Google Sheet** using **Google Apps Script**, which is free and built into Google.
There's no server, no coding agent and no paid plan. You paste one file once. After that you only use the sheet's menu.

```
 9:00 AM daily trigger (Apps Script)
        │
        ├─► Job APIs (free): Adzuna · Jooble · JSearch* · Remotive · Greenhouse/Lever/Ashby boards
        ├─► Remove duplicates (across sites and against everything seen before)
        ├─► Pre-filter (title, age, salary, excluded words): no AI cost
        ├─► Gemini free tier: scores 6 dimensions → weighted 30/25/20/10/10/5 in code
        ├─► Score ≥ 70 → copy of YOUR uploaded resume (same template) → only existing
        │     summary / bullet / skills lines reworded → integrity checks in code
        ├─► Google Doc in "AI Job Search - Customized Resumes"
        ├─► Row appended to the "Tracker" tab (never overwrites your status/notes)
        └─► Daily report emailed to you + "Daily Reports" tab
 *JSearch = Google for Jobs, which includes LinkedIn, Indeed, Glassdoor, ZipRecruiter… listings
```

---

## Part 1: Get your free API keys (about 10 minutes)

| Key | Needed? | Where | Free limit |
|---|---|---|---|
| **Gemini** | **Required** | <https://aistudio.google.com/apikey> → *Create API key* | ~10 requests/min, a few hundred/day (Google changes these) |
| **Adzuna** | Strongly recommended | <https://developer.adzuna.com> → Register → you get an *App ID* + *App Key* | Generous for daily use |
| **JSearch** (RapidAPI) | Recommended (this is how you get LinkedIn/Indeed/Glassdoor listings) | <https://rapidapi.com> → search **JSearch** → *Subscribe to Basic (free)* → copy `X-RapidAPI-Key` | ~200 requests/month (the script uses at most 3/day) |
| **Jooble** | Optional | <https://jooble.org/api/about> → request key (emailed) | Free |
| **Groq** | Optional backup AI | <https://console.groq.com/keys> | Free tier; used only if Gemini is down or out of quota |
| Remotive | No key | used automatically if you want Remote | – |

## Part 2: Install (about 5 minutes)

1. Go to <https://sheets.new> to create a blank Google Sheet.
3. In the sheet: **Extensions → Apps Script**.
4. Delete the sample code, paste **all of `Code.gs`**, and click 💾 **Save**.
   **One-time extra (only needed for uploading Word/PDF):** in the Apps Script editor's left sidebar, click **Services (+)**, pick **Drive API**, click **Add**, and save.
5. Close the Apps Script tab and **reload the sheet**. A **🤖 AI Job Search** menu appears.
6. **🤖 AI Job Search → 1. Initial setup.**
   Google asks for permission: *Review permissions → your account → Advanced → Go to (unsafe) → Allow*.
   ("Unsafe" only means Google hasn't reviewed it, because it's your own private script.)
7. Fill in the yellow **"Your value"** column on the **Profile** tab. That's everything from section 2 of your brief, plus:
   * **Country code** such as `in`, `us` or `gb`
   * Optional **career boards** for companies you love, written like `greenhouse:stripe, lever:plaid, ashby:notion`
     (the slug is the last part of their jobs-page URL, e.g. `boards.greenhouse.io/stripe`)
8. **Menu → 2. Set API keys.** Paste each key, or leave a box blank to skip it.
9. **Menu → 3. Upload my resume (base template).** Pick your .docx, PDF or other file. It's converted to a Google Doc that becomes your **base template**, and its link is filled into the Profile automatically.
   * Word (.docx) keeps your layout best. PDF works, but Google may simplify its formatting, so open the converted Doc once to check it.
   * Already have a Google Doc? Skip the upload and paste its link in the Profile row "Original resume = base template".
   * Then open the **"Resume (parsed)"** tab. It lists every line of your template with **AI may edit? = Yes** (summary, bullets, skills) or **Locked** (everything else). Change any *Yes* to **No** to freeze that line too.
10. **Menu → 4. Test connections.** Each line should show ✅ (optional sources show ➖).
11. **Menu → 🧪 Test tools** to check everything before the first real run:
    * **Test resume generation:** paste a real job description. You'll see the score, the changes line by line, and a link to a `TEST_` resume. Open it and check the layout matches your original.
    * **Preview job search:** shows which jobs would be found and shortlisted today. It uses no AI and saves nothing.
12. **Menu → ▶ Run job search now** for the first run.
13. **Menu → ⏰ Enable daily run (9 AM).** The time uses the sheet's timezone (*File → Settings → Time zone*).

That's it. Every morning you get an email report and new rows/Docs.

---

## How each requirement is met

| Your requirement | How |
|---|---|
| Match score /100 with your weights | AI scores each of the 6 dimensions. **The code** applies 30/25/20/10/10/5, then subtracts 5 points per missing *mandatory* requirement (max −15). Similar job titles get no credit unless the resume shows evidence. |
| Only ≥ 70 proceeds | Enforced in code (`MIN_SCORE`). |
| **Your resume is the template** | Each tailored resume is a **Drive copy of your uploaded resume**, so the fonts, layout, sections, tables, header/footer and links stay identical. Text is then replaced **line by line, in place**. No line is ever added, deleted, merged or split, and the code checks this before saving. |
| **Only existing content is modified** | Only lines labelled summary, bullet or skills can change. Names, contact details, job titles, employers, **dates**, education and certifications are locked, and so is any short line containing a year. Skills lines can only be **reordered** (same items, same label). Bullets can be reworded using that bullet's own facts, or reordered within the same job. Each rewrite must stay within about 35% of the original length, so your page count doesn't change. |
| **Never invent anything** | The code checks every AI edit. Any **number** not in the original line, or any **tool/term copied from the job ad that isn't in your resume**, means that line keeps its original wording. The tracker's *Resume Creation Status* shows how many lines were reworded and how many edits were rejected. |
| Duplicates | Same company + title (normalized, e.g. "Sr." = "Senior", "Pvt Ltd" ignored) or same URL counts as a duplicate within 60 days. Duplicates *within* a run are merged and the best source is kept ("also on: …" in Notes). |
| Changed posting → new row | Same URL with different content gets a new row, with a note saying when it was first seen. |
| Never overwrite your status/notes | The script only *appends* rows. The only edit it ever makes to an existing row is fixing column O/P after a **failed** resume is retried. |
| Link verification | Every link is opened before scoring. HTTP 404/410 means rejected as expired. Sites that block bots (LinkedIn often does) are marked **"not verified"** in Notes instead of verified. |
| Partial descriptions | Adzuna/Jooble only give snippets, so these are marked "partial/unverified" in Notes and scored conservatively. |
| No fake results | A failed Doc gets status `Failed: <reason>` with no URL. Source errors are listed in the report. |
| 6-minute Apps Script limit | It works for 4 minutes, then schedules itself to continue 1 minute later until the queue is empty. |
| Free AI quota exhausted | Remaining jobs stay queued for the next day, and the report says so. |
| Safety | It never applies, never emails anyone except **you**, and never uploads your resume anywhere. Docs stay private in your Drive. |

## Honest limitations

* **LinkedIn, Indeed, Naukri, Glassdoor, Foundit and Wellfound have no free public job APIs, and their terms forbid scraping.** The script respects that.
  * LinkedIn / Indeed / Glassdoor listings arrive legitimately through **JSearch** (Google for Jobs).
  * Many Naukri/Foundit-posted roles also appear on **Adzuna India** and **Jooble**, but coverage isn't 100%.
  * Wellfound isn't covered. Add startups you care about as `greenhouse:/lever:/ashby:` career boards instead.
* **Free Gemini tier privacy:** Google may use free-tier prompts (your resume and job ads) to improve its products. If that matters, use a paid key or only Groq.
* Free limits change. If Gemini starts failing with "model not found", set a newer model name under *Set API keys → Gemini model*.
* The 9 AM trigger fires within roughly 15 minutes of 9:00.
* **Always read each tailored resume before sending it.** The checks catch invented numbers and tools, but they can't judge tone.
* If a line mixes bold and normal text (e.g. **Led:** rest of line), a reworded line keeps the style of its first word. A bold "Label:" prefix is preserved.

## Daily use

* **Tracker tab:** update *Application Status* (dropdown) and *Notes* freely. The script never overwrites them.
* **Daily Reports tab:** one row per run.
* **🔁 Retry failed jobs:** reprocesses anything marked failed.
* **📄 Re-read my resume:** run this after editing your base template. It also happens automatically when the template's text changes.
* **To switch templates**, upload a new resume. Future resumes use the new one, and old ones stay as they were.
* Hidden tabs (`_queue`, `_seen`, `_log`) hold the history. Right-click a tab → *Show* to inspect `_log` if something goes wrong.

## Tuning (optional, top of Code.gs)

`MIN_SCORE` (70), `MAX_JOB_AGE_DAYS` (7), `DEDUP_WINDOW_DAYS` (60), `MANDATORY_GAP_PENALTY` (5).
The daily AI budget is the **"Max jobs to AI-evaluate per day"** row on the Profile tab (default 25, roughly 50 AI calls).

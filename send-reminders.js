require("dotenv").config();
const axios = require("axios");
const CryptoJS = require("crypto-js");
const Airtable = require("airtable");

// =========================
// ACTIVITY LOG (Airtable)
// =========================
let airtableBase = null;
if (process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID) {
  airtableBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
} else {
  console.warn("AIRTABLE_API_KEY or AIRTABLE_BASE_ID not set — activity logging disabled");
}

async function logActivity(action) {
  if (!airtableBase) return;
  try {
    await airtableBase("Activity Log").create([{
      fields: { "Action": action, "Department": "Scheduling" },
    }]);
  } catch (err) {
    console.warn("Airtable activity log failed:", err.message);
  }
}

// =========================
// AROFLO
// =========================
const AROFLO_BASE = "https://api.aroflo.com/";
const AROFLO_ACCEPT = "text/json";
const AROFLO_AUTH =
  "uencoded=" + encodeURIComponent(process.env.UENCODED) +
  "&pencoded=" + encodeURIComponent(process.env.PENCODED) +
  "&orgEncoded=" + encodeURIComponent(process.env.ORGENCODED);

function arofloSign(method, query, ts) {
  return CryptoJS.HmacSHA512(
    [method, "", AROFLO_ACCEPT, AROFLO_AUTH, ts, query].join("+"),
    process.env.SECRET_KEY
  ).toString();
}

function buildHeaders(method, query, extra = {}) {
  const ts = new Date().toISOString();
  const sig = arofloSign(method, query, ts);
  return {
    Accept: AROFLO_ACCEPT,
    Authorization: AROFLO_AUTH,
    Authentication: "HMAC " + sig,
    afdatetimeutc: ts,
    ...extra,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// AroFlo enforces a per-second rate limit (status "6") — retry with backoff
// rather than treating it as a hard failure.
async function arofloGet(params, retries = 5) {
  for (let i = 0; i < retries; i++) {
    const res = await axios.get(AROFLO_BASE + "?" + params, {
      headers: buildHeaders("GET", params),
    });
    if (res.data.status === "6") {
      await sleep(1500);
      continue;
    }
    return res.data;
  }
  throw new Error("AroFlo GET rate limit retries exhausted: " + params);
}

async function arofloPost(body, retries = 5) {
  for (let i = 0; i < retries; i++) {
    const res = await axios.post(AROFLO_BASE + "?", body, {
      headers: buildHeaders("POST", body, {
        "Content-Type": "application/x-www-form-urlencoded",
      }),
    });
    if (res.data.status === "6") {
      await sleep(1500);
      continue;
    }
    return res.data;
  }
  throw new Error("AroFlo POST rate limit retries exhausted");
}

// AroFlo date strings look like "YYYY/MM/DD" or "YYYY/MM/DD HH:MM:SS".
function parseArofloDateString(str) {
  const [year, month, day] = str.split(" ")[0].split("/").map(Number);
  return { year, month, day };
}

async function getSchedulesForDate(startDate) {
  const params = [
    "zone=schedules",
    "where=" + encodeURIComponent(`and|startdate|=|${startDate}`),
    "page=1",
  ].join("&");
  const data = await arofloGet(params);
  const schedules = data.zoneresponse?.schedules || [];
  return Array.isArray(schedules) ? schedules : [schedules];
}

async function getSchedulesForTaskId(taskId) {
  const params = [
    "zone=schedules",
    "where=" + encodeURIComponent(`and|taskid|=|${taskId}`),
    "page=1",
  ].join("&");
  const data = await arofloGet(params);
  const schedules = data.zoneresponse?.schedules || [];
  return Array.isArray(schedules) ? schedules : [schedules];
}

async function getTaskByTaskId(taskId) {
  const params = [
    "zone=tasks",
    "where=" + encodeURIComponent(`and|taskid|=|${taskId}`),
    "page=1",
  ].join("&");
  const data = await arofloGet(params);
  return data.zoneresponse?.tasks?.[0] || null;
}

// The task's own duedate/duedatetime fields can drift from the real booked
// slot (e.g. after a reschedule), so the Schedules zone — not duedate — is
// the source of truth for both which jobs get reminded and what date goes
// in the SMS. Returns [{ task, startParts }] for jobs actually booked on
// the given date.
async function getBookedJobsForDate(startDate) {
  const schedules = await getSchedulesForDate(startDate);
  const taskIds = [
    ...new Set(
      schedules
        .filter((s) => s.scheduletype?.type === "task")
        .map((s) => s.scheduletype.typeid)
    ),
  ];

  const results = [];
  for (const taskId of taskIds) {
    await sleep(1100);
    const task = await getTaskByTaskId(taskId);
    if (
      task &&
      task.status === "Not Started" &&
      (task.substatus?.substatus || "").startsWith("6 Booked")
    ) {
      results.push({ task, startParts: parseArofloDateString(startDate) });
    }
  }
  return results;
}

async function getTaskByJobNumber(jobNumber) {
  const params = [
    "zone=tasks",
    "where=" + encodeURIComponent(`and|jobnumber|=|${jobNumber}`),
    "page=1",
  ].join("&");
  const data = await arofloGet(params);
  return data.zoneresponse?.tasks?.[0] || null;
}

async function getLocationContact(locationId) {
  const params = [
    "zone=locations",
    "where=" + encodeURIComponent(`and|locationid|=|${locationId}`),
    "page=1",
  ].join("&");
  const data = await arofloGet(params);
  return data.zoneresponse?.locations?.[0] || null;
}

async function addNote(task, noteText) {
  const xml =
`<tasks>
  <task>
    <taskid>${task.taskid}</taskid>
    <notes>
      <note>
        <content><![CDATA[${noteText}]]></content>
      </note>
    </notes>
  </task>
</tasks>`;
  await arofloPost("zone=tasks&postxml=" + encodeURIComponent(xml));
}

// =========================
// PHONE NUMBERS
// =========================
// Australian mobiles only — normalised form is +614 followed by 8 digits.
// Landlines and malformed numbers (e.g. missing area code) are dropped since
// MessageMedia can't SMS them anyway.
const AU_MOBILE_RE = /^\+614\d{8}$/;

function extractPhones(sitePhoneField) {
  if (!sitePhoneField) return [];
  const raw = sitePhoneField.split(",").map((s) => s.trim()).filter(Boolean);
  const normalise = (n) => n.replace(/\s+/g, "").replace(/^0/, "+61");
  const normalised = raw.map(normalise);
  return [...new Set(normalised.filter((n) => AU_MOBILE_RE.test(n)))];
}

// =========================
// MESSAGEMEDIA (outbound SMS)
// =========================
async function sendSms(phoneNumber, content) {
  const auth = Buffer.from(
    `${process.env.MESSAGEMEDIA_API_KEY}:${process.env.MESSAGEMEDIA_API_SECRET}`
  ).toString("base64");
  await axios.post(
    "https://api.messagemedia.com/v1/messages",
    { messages: [{ content, destination_number: phoneNumber, format: "SMS" }] },
    { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" } }
  );
}

// =========================
// DATE HELPERS
// =========================
// Perth (AWST) is UTC+8 year-round — no daylight saving.
function perthDateParts(days = 0) {
  const now = new Date();
  const perthMs = now.getTime() + 8 * 60 * 60 * 1000;
  const perth = new Date(perthMs);
  perth.setUTCDate(perth.getUTCDate() + days);
  return {
    year: perth.getUTCFullYear(),
    month: perth.getUTCMonth() + 1,
    day: perth.getUTCDate(),
  };
}

// 0 = Sunday, 6 = Saturday
function dayOfWeek({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function addCalendarDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + n);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Steps forward one calendar day at a time, only counting weekdays,
// so "2 business days" from Thu lands on Mon and from Fri lands on Tue.
function addBusinessDays(startParts, n) {
  let parts = startParts;
  let remaining = n;
  while (remaining > 0) {
    parts = addCalendarDays(parts, 1);
    const dow = dayOfWeek(parts);
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return parts;
}

function targetBookingDate() {
  return addBusinessDays(perthDateParts(0), 2);
}

// AroFlo where-clause format: YYYY/MM/DD
function toArofloDate({ year, month, day }) {
  return `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}

// SMS wording format: D/M/YYYY (no leading zeros)
function toAuDate({ year, month, day }) {
  return `${day}/${month}/${year}`;
}

// =========================
// SMS TEMPLATE
// =========================
function buildReminderSms(jobNumber, auDate) {
  return `Hi. This is a friendly reminder of your booking on ${auDate}. If you need to rebook, please contact our office on 08 6206 6899 at least 24 hours prior to your appointment (excluding weekends and public holidays) to avoid a $140+GST cancellation fee. This fee may also apply should our technician be unable to access the property during the agreed time frame. Your job reference number is ${jobNumber}. Regards, Bara Electrical.
NO REPLY`;
}

// =========================
// RUN MODE
// =========================
const EXPLICIT_DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";
const testJobArg = process.argv.find((a) => a.startsWith("--job="));
const TEST_JOB_NUMBER = testJobArg ? testJobArg.split("=")[1] : null;

// Any CLI flag means "someone is manually testing this right now" — run once
// immediately and exit. No flags (the normal Railway/production invocation)
// means run as a persistent service that only wakes up at 9am AWST.
const RUN_ONCE = EXPLICIT_DRY_RUN || !!TEST_JOB_NUMBER || process.argv.includes("--once");

// Hard safety gate: a live send (real SMS, real notes) only ever happens if
// CONFIRM_LIVE=yes is explicitly set. Anything else — a bare deploy restart,
// a misconfigured Railway service, a forgotten flag — falls back to a safe
// no-op dry run instead of silently texting real customers.
const CONFIRM_LIVE = process.env.CONFIRM_LIVE === "yes";
const DRY_RUN = EXPLICIT_DRY_RUN || !CONFIRM_LIVE;

async function runReminderJob() {
  if (EXPLICIT_DRY_RUN) {
    console.log("=== DRY RUN (--dry-run) — no SMS will be sent, no notes will be written ===\n");
  } else if (!CONFIRM_LIVE) {
    console.log("=== CONFIRM_LIVE is not set to 'yes' — forcing dry run as a safety default ===\n");
  }

  const todayDow = dayOfWeek(perthDateParts(0));
  if (!TEST_JOB_NUMBER && (todayDow === 0 || todayDow === 6)) {
    console.log("Today is a weekend in Perth — skipping run.");
    return;
  }

  const targetDate = targetBookingDate();
  const arofloDate = toArofloDate(targetDate);

  let jobs;
  if (TEST_JOB_NUMBER) {
    console.log(`TEST MODE: targeting single job ${TEST_JOB_NUMBER} only.\n`);
    const task = await getTaskByJobNumber(TEST_JOB_NUMBER);
    if (!task) {
      console.log(`Job ${TEST_JOB_NUMBER} not found.`);
      return;
    }
    await sleep(1100);
    const schedules = await getSchedulesForTaskId(task.taskid);
    if (schedules.length === 0) {
      console.log(`Job ${TEST_JOB_NUMBER} has no schedule entry in AroFlo — can't confirm a real booked date, skipping.`);
      return;
    }
    if (schedules.length > 1) {
      console.log(`Job ${TEST_JOB_NUMBER} has ${schedules.length} schedule entries — using the first: ${schedules[0].startdate}.`);
    }
    jobs = [{ task, startParts: parseArofloDateString(schedules[0].startdate) }];
  } else {
    console.log(`Fetching jobs actually booked (per AroFlo Schedules) for ${arofloDate}...`);
    jobs = await getBookedJobsForDate(arofloDate);
    console.log(`Found ${jobs.length} booked jobs.\n`);
  }

  let sentCount = 0;
  let skippedCount = 0;

  for (const { task, startParts } of jobs) {
    await sleep(1100);

    const auDate = toAuDate(startParts);
    const locationId = task.tasklocation?.locationid;
    const location = locationId ? await getLocationContact(locationId) : null;
    const phones = extractPhones(location?.SitePhone);

    if (phones.length === 0) {
      console.log(`Job ${task.jobnumber}: no mobile number on file — skipping.`);
      if (!DRY_RUN) {
        await sleep(1100);
        await addNote(
          task,
          `Bara AI: booking reminder SMS not sent — no mobile phone number on file for this property.`
        );
      }
      skippedCount++;
      continue;
    }

    const message = buildReminderSms(task.jobnumber, auDate);
    for (const phone of phones) {
      if (DRY_RUN) {
        console.log(`Job ${task.jobnumber}: WOULD send to ${phone}:\n---\n${message}\n---`);
      } else {
        await sendSms(phone, message);
        console.log(`Job ${task.jobnumber}: reminder sent to ${phone}`);
      }
    }

    if (!DRY_RUN) {
      await sleep(1100);
      await addNote(
        task,
        `Bara AI: booking reminder SMS sent to ${phones.join(", ")}.`
      );
    }
    sentCount++;
  }

  console.log(`\nDone. Sent: ${sentCount}, Skipped (no phone): ${skippedCount}, Total: ${jobs.length}`);

  if (!DRY_RUN && !TEST_JOB_NUMBER) {
    await logActivity(`Booking reminder SMS sent for ${sentCount} jobs`);
  }
}

// =========================
// SCHEDULER (persistent service mode)
// =========================
// Milliseconds until next 9:00am Perth (AWST = UTC+8, no daylight saving).
function msUntilNineAmPerth() {
  const now = new Date();
  const perthMs = now.getTime() + 8 * 60 * 60 * 1000;
  const perth = new Date(perthMs);
  const perthHour = perth.getUTCHours();
  const daysToAdd = perthHour < 9 ? 0 : 1;
  const next9amUTC = new Date(Date.UTC(
    perth.getUTCFullYear(), perth.getUTCMonth(), perth.getUTCDate() + daysToAdd,
    1, 0, 0 // 9am AWST = 1am UTC
  ));
  return next9amUTC - now;
}

function scheduleNextRun() {
  const waitMs = msUntilNineAmPerth();
  console.log(`Next run scheduled in ${(waitMs / 1000 / 60 / 60).toFixed(1)} hours (9am AWST).`);
  setTimeout(async () => {
    try {
      await runReminderJob();
    } catch (err) {
      console.error("Reminder job failed:", err.response?.data || err.message);
    }
    scheduleNextRun();
  }, waitMs);
}

// Minimal HTTP responder so Railway's health check has something to hit —
// this service does no request handling of its own, it just needs to stay alive.
function startHealthServer() {
  const http = require("http");
  const port = process.env.PORT || 3000;
  http.createServer((req, res) => res.end("booking-reminders is running")).listen(port);
  console.log(`Health server listening on port ${port}.`);
}

// =========================
// ENTRYPOINT
// =========================
if (RUN_ONCE) {
  runReminderJob()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("FATAL:", err.response?.data || err.message);
      process.exit(1);
    });
} else {
  console.log("Starting booking-reminders as a persistent service.");
  startHealthServer();
  scheduleNextRun();
}

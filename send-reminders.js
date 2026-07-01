require("dotenv").config();
const axios = require("axios");
const CryptoJS = require("crypto-js");

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
    "af-hmac-signature": sig,
    "af-iso-timestamp": ts,
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

async function getBookedJobsForDate(dueDate) {
  const params = [
    "zone=tasks",
    "where=" + encodeURIComponent(`and|duedate|=|${dueDate}`),
    "page=1",
  ].join("&");
  const data = await arofloGet(params);
  const tasks = data.zoneresponse?.tasks || [];
  return tasks.filter(
    (t) =>
      t.status === "Not Started" &&
      (t.substatus?.substatus || "").startsWith("6 Booked")
  );
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
function extractPhones(sitePhoneField) {
  if (!sitePhoneField) return [];
  const raw = sitePhoneField.split(",").map((s) => s.trim()).filter(Boolean);
  const normalise = (n) => n.replace(/\s+/g, "").replace(/^0/, "+61");
  return [...new Set(raw.map(normalise))];
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
function perthDatePlusDays(days) {
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
// MAIN
// =========================
const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";
const testJobArg = process.argv.find((a) => a.startsWith("--job="));
const TEST_JOB_NUMBER = testJobArg ? testJobArg.split("=")[1] : null;

async function main() {
  if (DRY_RUN) console.log("=== DRY RUN — no SMS will be sent, no notes will be written ===\n");

  const targetDate = perthDatePlusDays(2);
  const arofloDate = toArofloDate(targetDate);
  const auDate = toAuDate(targetDate);

  let jobs;
  if (TEST_JOB_NUMBER) {
    console.log(`TEST MODE: targeting single job ${TEST_JOB_NUMBER} only.\n`);
    const task = await getTaskByJobNumber(TEST_JOB_NUMBER);
    if (!task) {
      console.log(`Job ${TEST_JOB_NUMBER} not found.`);
      return;
    }
    jobs = [task];
  } else {
    console.log(`Fetching booked jobs due ${arofloDate}...`);
    jobs = await getBookedJobsForDate(arofloDate);
    console.log(`Found ${jobs.length} booked jobs.\n`);
  }

  let sentCount = 0;
  let skippedCount = 0;

  for (const task of jobs) {
    await sleep(1100);

    const locationId = task.tasklocation?.locationid;
    const location = locationId ? await getLocationContact(locationId) : null;
    const phones = extractPhones(location?.SitePhone);

    if (phones.length === 0) {
      console.log(`Job ${task.jobnumber}: no phone on file — skipping.`);
      if (!DRY_RUN) {
        await sleep(1100);
        await addNote(
          task,
          `Bara AI: booking reminder SMS not sent — no contact phone number on file for this property.`
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
}

main().catch((err) => {
  console.error("FATAL:", err.response?.data || err.message);
  process.exit(1);
});

const key = process.env.FIRMS_MAP_KEY;

function safe(text) {
  let out = String(text);
  if (typeof key === "string" && key.length >= 8) out = out.split(key).join("[redacted]");
  return out.replace(/https?:\/\/\S+/g, "[url]");
}

function line(message) {
  process.stdout.write(`${safe(message)}\n`);
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "hazardwatch/0.1.0 (live-check)" },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${safe(text).slice(0, 180)}`);
  }
  return JSON.parse(text);
}

let failed = false;

try {
  const categories = await getJson("https://eonet.gsfc.nasa.gov/api/v3/categories");
  const ids = Array.isArray(categories.categories)
    ? categories.categories.map((category) => category.id)
    : [];
  if (!ids.includes("wildfires")) throw new Error("categories response has no wildfires id");
  line(`EONET categories ok count=${ids.length} wildfires=yes`);

  const events = await getJson(
    "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=wildfires&limit=5",
  );
  const list = Array.isArray(events.events) ? events.events : [];
  const first = list[0];
  const firstId = first && typeof first.id === "string" ? first.id : "none";
  line(`EONET open wildfires ok count=${list.length} first=${firstId}`);
  if (list.length === 0) line("EONET open wildfires returned no events");
} catch (error) {
  failed = true;
  line(`EONET live failed ${error instanceof Error ? error.message : "unknown"}`);
}

if (typeof key !== "string" || key.length === 0) {
  line("FIRMS live skipped: FIRMS_MAP_KEY unset");
} else if (!/^[0-9A-Za-z]{32}$/.test(key)) {
  line("FIRMS live skipped: FIRMS_MAP_KEY is not a 32-character alphanumeric key");
} else {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_NOAA21_NRT/-112,34,-111,35/1`;
  try {
    const response = await fetch(url, {
      headers: { accept: "text/csv", "user-agent": "hazardwatch/0.1.0 (live-check)" },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${safe(text).slice(0, 180)}`);
    }
    const rows = text.trim().split(/\r?\n/).filter((row) => row.length > 0);
    line(`FIRMS live ok rows=${Math.max(0, rows.length - 1)}`);
  } catch (error) {
    failed = true;
    line(`FIRMS live failed ${error instanceof Error ? error.message : "unknown"}`);
  }
}

if (failed) process.exitCode = 1;

const express = require("express");
const fetch = require("node-fetch");
const dotenv = require("dotenv");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ─── Leaderboard file path ────────────────────────────────────────────────────
const LB_FILE = path.join(__dirname, "data", "leaderboard.json");

function readLeaderboard() {
  try {
    const raw = fs.readFileSync(LB_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return { players: [] };
  }
}

function writeLeaderboard(data) {
  fs.mkdirSync(path.dirname(LB_FILE), { recursive: true });
  fs.writeFileSync(LB_FILE, JSON.stringify(data, null, 2), "utf8");
}

// GET /api/leaderboard — returns full sorted player list
app.get("/api/leaderboard", (req, res) => {
  const data = readLeaderboard();
  data.players.sort((a, b) => b.pts - a.pts);
  res.json(data);
});

// POST /api/leaderboard — upserts a player's score
// Body: { name: string, pts: number }
app.post("/api/leaderboard", (req, res) => {
  const { name, pts } = req.body;

  if (!name || typeof name !== "string" || name.trim().length < 2) {
    return res.status(400).json({ error: "Invalid name." });
  }
  if (typeof pts !== "number" || pts < 0) {
    return res.status(400).json({ error: "Invalid pts." });
  }

  const safeName = name.trim().slice(0, 20);
  const data = readLeaderboard();

  const idx = data.players.findIndex(p => p.name === safeName);
  if (idx >= 0) {
    // Only update if new score is higher
    if (pts > data.players[idx].pts) {
      data.players[idx].pts = pts;
      data.players[idx].updatedAt = new Date().toISOString();
    }
  } else {
    data.players.push({
      name: safeName,
      pts,
      joinedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  writeLeaderboard(data);
  data.players.sort((a, b) => b.pts - a.pts);
  res.json({ ok: true, rank: data.players.findIndex(p => p.name === safeName) + 1 });
});

// ─── Instructor data files ────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(__dirname, "data", "instructor-settings.json");
const STUDENTS_FILE = path.join(__dirname, "data", "students.json");

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); }
  catch { return { studentOverrides: {} }; }
}
function writeSettings(data) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf8");
}
function readStudents() {
  try { return JSON.parse(fs.readFileSync(STUDENTS_FILE, "utf8")); }
  catch { return {}; }
}
function writeStudents(data) {
  fs.mkdirSync(path.dirname(STUDENTS_FILE), { recursive: true });
  fs.writeFileSync(STUDENTS_FILE, JSON.stringify(data, null, 2), "utf8");
}

// Simple hash so the instructor page emailHash field works with plain student names
function nameToHash(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) { h = (Math.imul(31, h) + name.charCodeAt(i)) | 0; }
  return "u" + Math.abs(h).toString(36);
}

const LEVEL_NAMES = ["Beginner", "Rookie", "Explorer", "Intermediate", "Advanced", "Proficient"];

// GET /api/instructor/students — full dashboard data
app.get("/api/instructor/students", (req, res) => {
  const settings = readSettings();
  const studentsRaw = readStudents();
  const lb = readLeaderboard();

  // Merge leaderboard pts into student records
  lb.players.forEach(p => {
    const hash = nameToHash(p.name);
    if (!studentsRaw[hash]) studentsRaw[hash] = { name: p.name, emailHash: hash };
    studentsRaw[hash].pts = p.pts;
  });

  // Build sorted student list
  const students = Object.values(studentsRaw)
    .sort((a, b) => (b.pts || 0) - (a.pts || 0))
    .map((s, i) => ({
      ...s,
      rank: i + 1,
      emailHash: s.emailHash || nameToHash(s.name),
      email: s.email || "",
      pts: s.pts || 0,
      challengesSolved: s.challengesSolved || 0,
      levelSummary: s.levelSummary || {},
      currentView: s.currentView || null,
      completedMap: s.completedMap || {},
      lastActive: s.lastActive || null
    }));

  res.json({ settings, students, levelNames: LEVEL_NAMES });
});

// POST /api/instructor/settings — save instructor overrides
app.post("/api/instructor/settings", (req, res) => {
  writeSettings(req.body);
  res.json({ ok: true, settings: req.body });
});

// POST /api/instructor/auth/logout — no-op (no real auth needed for local use)
app.post("/api/instructor/auth/logout", (req, res) => res.json({ ok: true }));

// POST /api/student/sync — students call this to sync their activity & get their settings
app.post("/api/student/sync", (req, res) => {
  const { name, pts, completedMap, currentView, challengesSolved, levelSummary } = req.body;
  if (!name) return res.status(400).json({ error: "Missing name" });

  const hash = nameToHash(name.trim());
  const students = readStudents();
  students[hash] = {
    ...students[hash],
    name: name.trim(),
    emailHash: hash,
    pts: pts || 0,
    completedMap: completedMap || {},
    currentView: currentView || null,
    challengesSolved: challengesSolved || 0,
    levelSummary: levelSummary || {},
    lastActive: new Date().toISOString()
  };
  writeStudents(students);

  // Return this student's overrides so challenge.html can enforce them
  const settings = readSettings();
  const override = (settings.studentOverrides || {})[hash] || {};
  res.json({ ok: true, override });
});

if (!process.env.API_KEY) {
  console.error("⚠️  WARNING: API_KEY is not set in .env — AI features will not work.");
}

// AI route — proxies to Gemini so the API key stays server-side
app.post("/api/bloom", async (req, res) => {
  try {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "API_KEY not configured on server." });
    }

    // Ensure a model is always set
    const body = { ...req.body };
    if (!body.model) {
      body.model = "gemini-2.5-flash";
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${body.model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Strip the model field — it's in the URL, not the body
        body: JSON.stringify({ ...body, model: undefined })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini API error:", response.status, errText);
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    res.json(data);

  } catch (err) {
    console.error("Server error:", err.message);
    res.status(500).json({ error: "Server failed: " + err.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bloom App running → http://localhost:${PORT}`);
});

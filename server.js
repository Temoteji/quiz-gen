require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const OpenAI = require('openai');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { createClient } = require('@libsql/client');
const pdfParse = require('pdf-parse');

const parsePdf = async (buffer) => {
  return typeof pdfParse === 'function' ? pdfParse(buffer) : pdfParse.default(buffer);
};

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Trust proxy so secure cookies and protocol forwarding work correctly behind Vercel
app.set('trust proxy', 1);

// --- INITIALIZE TURSO / LIBSQL DATABASE ---
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:quizforge.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS quizzes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      quiz_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      questions_answered INTEGER,
      correct_answers INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);
  console.log('Connected to Turso / SQLite database.');
}
initDb().catch(err => console.error('Database initialization error:', err));

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf'
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Upload a JPG, PNG, WEBP, GIF, or PDF.'));
    }
  }
});

if (!OPENROUTER_API_KEY) {
  console.warn('WARNING: OPENROUTER_API_KEY is not set. The quiz endpoint will fail until it is set.');
}

// --- OPENROUTER INITIALIZATION ---
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://quiz-gen-topaz.vercel.app",
    "X-Title": "QuizForge",
  }
});

app.use(express.json({ limit: '100kb' }));

// --- SESSION CONFIGURATION ---
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 24 * 60 * 60 * 1000, // 1 day
    secure: process.env.NODE_ENV === 'production' // secure cookies on production
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// --- PASSPORT GOOGLE STRATEGY ---
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback",
    proxy: true
  },
  async function(accessToken, refreshToken, profile, cb) {
    try {
      const rs = await db.execute({
        sql: 'SELECT * FROM users WHERE id = ?',
        args: [profile.id]
      });
      if (rs.rows.length === 0) {
        await db.execute({
          sql: 'INSERT INTO users (id, name, email) VALUES (?, ?, ?)',
          args: [profile.id, profile.displayName, profile.emails[0].value]
        });
      }
      return cb(null, profile);
    } catch (err) {
      return cb(err);
    }
  }
));

passport.serializeUser((user, cb) => cb(null, user));
passport.deserializeUser((obj, cb) => cb(null, obj));

// Robust static path resolution
const publicPath = path.join(__dirname, 'public');
const vercelPublicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));
app.use(express.static(vercelPublicPath));

const quizLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this device. Try again in a bit.' }
});

// --- AUTHENTICATION ROUTES ---
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

app.get('/api/user', (req, res) => res.json(req.user || null));

app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/');
  });
});

// --- MIDDLEWARE ---
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'You must be logged in to save or generate quizzes.' });
}

// --- API ROUTES ---
const SYSTEM_PROMPT = `You are a distinguished professor at a rigorous, top-tier university. Your task is to generate exactly 10 highly challenging multiple-choice questions based on the provided study notes.

CRITICAL INSTRUCTIONS:
1. Test deep conceptual understanding and theoretical knowledge, not mere rote memorization or exact phrasing.
2. DO NOT create situational, scenario-based, or applied-case questions. Keep the questions strictly academic and focused on the core concepts.
3. Make the questions difficult. The incorrect options (distractors) must be highly plausible, common misconceptions or closely related concepts, not obvious throwaways.
4. Respond with ONLY a raw, valid JSON array. You must absolutely omit all markdown formatting, code fences (no \`\`\`json), and conversational text. The output must be immediately parseable by JSON.parse().

The output must exactly match this structure:
[
  {
    "question": "...",
    "options": ["...", "...", "...", "..."],
    "correctIndex": 0,
    "explanation": "One short, precise sentence explaining why the correct answer is right and the others are incorrect."
  }
]`;

async function callOpenRouterForQuiz(userPrompt) {
  try {
    const completion = await openai.chat.completions.create({
      model: "openrouter/free",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ],
    });

    const responseText = completion.choices[0].message.content;
    let raw = responseText.replace(/```json|```/g, '').trim();

    let quiz;
    try {
      quiz = JSON.parse(raw);
    } catch (parseErr) {
      console.error('Failed to parse model output as JSON:', raw);
      throw new Error('The AI returned an unexpected format. Try again.');
    }
    if (!Array.isArray(quiz) || quiz.length === 0) {
      throw new Error('The AI did not return any questions. Try again.');
    }
    return quiz;
  } catch (error) {
    console.error('OpenRouter API error:', error);
    throw new Error('The AI service failed to respond. Try again shortly.');
  }
}

app.post('/api/generate-quiz', quizLimiter, ensureAuthenticated, async (req, res) => {
  try {
    const notes = (req.body && req.body.notes ? String(req.body.notes) : '').trim();
    if (notes.length < 30) return res.status(400).json({ error: 'Notes are too short to build a quiz from.' });
    if (notes.length > 12000) return res.status(400).json({ error: 'Notes are too long. Try a shorter excerpt.' });
    if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'Server is missing its OpenRouter API key.' });

    const quiz = await callOpenRouterForQuiz(`Here are the notes:\n\n${notes}`);
    
    await db.execute({
      sql: 'INSERT INTO quizzes (user_id, quiz_data) VALUES (?, ?)',
      args: [req.user.id, JSON.stringify(quiz)]
    });

    res.json({ quiz });
  } catch (err) {
    console.error('Error generating quiz from text:', err);
    res.status(502).json({ error: err.message || 'Something went wrong on the server.' });
  }
});

app.post('/api/generate-quiz-file', quizLimiter, ensureAuthenticated, (req, res) => {
  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'File is too large. Max size is 10MB.' : (uploadErr.message || 'Could not process the uploaded file.');
      return res.status(400).json({ error: msg });
    }
    try {
      if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
      if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'Server is missing its OpenRouter API key.' });

      let extractedText = "";

      if (req.file.mimetype === 'application/pdf') {
        const pdfData = await parsePdf(req.file.buffer);
        extractedText = pdfData.text;
      } else {
        extractedText = `Uploaded file name: ${req.file.originalname}. Please generate academic questions based on standard themes matching this file title.`;
      }

      if (!extractedText || extractedText.trim().length < 30) {
        return res.status(400).json({ error: 'Could not extract enough readable text from the uploaded file. Try pasting the text directly.' });
      }

      const quiz = await callOpenRouterForQuiz(`Here is the text extracted from the uploaded document:\n\n${extractedText.substring(0, 10000)}`);

      await db.execute({
        sql: 'INSERT INTO quizzes (user_id, quiz_data) VALUES (?, ?)',
        args: [req.user.id, JSON.stringify(quiz)]
      });

      res.json({ quiz });
    } catch (err) {
      console.error('Error generating quiz from file:', err);
      res.status(502).json({ error: err.message || 'Something went wrong on the server.' });
    }
  });
});

app.get('/api/dashboard', ensureAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;

    const quizCountRes = await db.execute({
      sql: 'SELECT COUNT(*) as quizzesMade FROM quizzes WHERE user_id = ?',
      args: [userId]
    });
    
    const scoreStatsRes = await db.execute({
      sql: 'SELECT SUM(questions_answered) as totalAnswered, SUM(correct_answers) as totalCorrect FROM scores WHERE user_id = ?',
      args: [userId]
    });
    
    const recentSetsRes = await db.execute({
      sql: 'SELECT quiz_data, created_at FROM quizzes WHERE user_id = ? ORDER BY created_at DESC LIMIT 3',
      args: [userId]
    });

    const quizCount = quizCountRes.rows[0];
    const scoreStats = scoreStatsRes.rows[0];
    
    const answered = scoreStats && scoreStats.totalAnswered ? scoreStats.totalAnswered : 0;
    const correct = scoreStats && scoreStats.totalCorrect ? scoreStats.totalCorrect : 0;

    res.json({
      quizzesMade: quizCount ? quizCount.quizzesMade : 0,
      questionsAnswered: answered,
      averageScore: answered > 0 ? Math.round((correct / answered) * 100) : 0,
      recentSets: recentSetsRes.rows || []
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

app.get('/api/quizzes', ensureAuthenticated, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await db.execute({
      sql: 'SELECT id, quiz_data, created_at FROM quizzes WHERE user_id = ? ORDER BY created_at DESC',
      args: [userId]
    });
    res.json({ quizzes: result.rows || [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quizzes' });
  }
});

app.post('/api/save-score', ensureAuthenticated, async (req, res) => {
  try {
    const { answered, correct } = req.body;
    await db.execute({
      sql: 'INSERT INTO scores (user_id, questions_answered, correct_answers) VALUES (?, ?, ?)',
      args: [req.user.id, answered, correct]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save score' });
  }
});

// Run locally if not on Vercel
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Notes → Quiz server running on port ${PORT}`);
  });
}

module.exports = app;

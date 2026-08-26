require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const OpenAI = require('openai');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { createClient } = require('@libsql/client');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const pdfParse = require('pdf-parse');

const parsePdf = async (buffer) => {
  return typeof pdfParse === 'function' ? pdfParse(buffer) : pdfParse.default(buffer);
};

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const JWT_SECRET = process.env.SESSION_SECRET || 'fallback_secret_key';

app.set('trust proxy', 1);

// Database Client Setup
if (process.env.NODE_ENV === 'production' && !process.env.TURSO_DATABASE_URL) {
  console.warn('CRITICAL: TURSO_DATABASE_URL is missing in production environment.');
}

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

// Multer Upload Configuration (4.5 MB Vercel Serverless Limit)
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf'
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4.5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Upload a JPG, PNG, WEBP, GIF, or PDF.'));
    }
  }
});

// OpenAI / Gemini Integration
const openai = new OpenAI({
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  apiKey: GEMINI_API_KEY || 'missing_key',
});

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(passport.initialize());

// JWT Auth Middleware
app.use((req, res, next) => {
  const token = req.cookies.token;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      req.user = null;
    }
  }
  next();
});

// Passport Google Strategy Configuration
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'missing_client_id',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'missing_client_secret',
    callbackURL: process.env.NODE_ENV === 'production' 
      ? "https://quiz-gen-topaz.vercel.app/auth/google/callback" 
      : "http://localhost:3000/auth/google/callback",
    proxy: true,
    state: false 
  },
  async function(accessToken, refreshToken, profile, cb) {
    try {
      const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
      const rs = await db.execute({
        sql: 'SELECT * FROM users WHERE id = ?',
        args: [profile.id]
      });
      if (rs.rows.length === 0) {
        await db.execute({
          sql: 'INSERT INTO users (id, name, email) VALUES (?, ?, ?)',
          args: [profile.id, profile.displayName, email]
        });
      }
      return cb(null, profile);
    } catch (err) {
      console.error('Error during Passport user lookup/insert:', err);
      return cb(err);
    }
  }
));

// Static Files
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

// Auth Routes
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));

// Custom OAuth Callback Handler to catch and display backend errors directly
app.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, (err, user, info) => {
    if (err) {
      console.error('OAuth Authentication Exception:', err);
      return res.status(500).json({ 
        error: 'Authentication process failed.', 
        details: err.message || 'Database or configuration error during login.' 
      });
    }
    if (!user) {
      return res.status(401).json({ error: 'Google authentication was denied or failed.' });
    }

    const token = jwt.sign(
      {
        id: user.id,
        displayName: user.displayName,
        name: user.name,
        emails: user.emails
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });

    res.redirect('/');
  })(req, res, next);
});

app.get('/api/user', (req, res) => res.json(req.user || null));

app.get('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/');
});

function ensureAuthenticated(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: 'You must be logged in to save or generate quizzes.' });
}

// AI Prompting & Parsing Helpers
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

function shuffleQuizOptions(quizArray) {
  return quizArray.map(item => {
    let optionsWithIndices = item.options.map((opt, idx) => ({ 
      text: opt, 
      isCorrect: idx === item.correctIndex 
    }));

    for (let i = optionsWithIndices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [optionsWithIndices[i], optionsWithIndices[j]] = [optionsWithIndices[j], optionsWithIndices[i]];
    }

    const newCorrectIndex = optionsWithIndices.findIndex(opt => opt.isCorrect);

    return {
      ...item,
      options: optionsWithIndices.map(opt => opt.text),
      correctIndex: newCorrectIndex !== -1 ? newCorrectIndex : 0
    };
  });
}

function parseAndShuffleQuiz(responseText) {
  const match = responseText.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new Error('The AI response did not contain a valid JSON array.');
  }
  const quiz = JSON.parse(match[0]);
  if (!Array.isArray(quiz) || quiz.length === 0) {
    throw new Error('The AI did not return any questions. Try again.');
  }
  return shuffleQuizOptions(quiz);
}

async function callGeminiForQuiz(userPrompt, retries = 1) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: "gemini-2.0-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ],
      });

      const responseText = completion.choices[0].message.content;
      return parseAndShuffleQuiz(responseText);
    } catch (error) {
      if (error.status === 429 && attempt <= retries) {
        console.warn(`Rate limit hit. Retrying attempt ${attempt}...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      console.error('Gemini API error:', error);
      throw new Error('The AI service failed to respond. Try again shortly.');
    }
  }
}

// API Endpoints
app.post('/api/generate-quiz', quizLimiter, ensureAuthenticated, async (req, res) => {
  try {
    const notes = (req.body && req.body.notes ? String(req.body.notes) : '').trim();
    if (notes.length < 30) return res.status(400).json({ error: 'Notes are too short to build a quiz from.' });
    if (notes.length > 8000) return res.status(400).json({ error: 'Notes are too long. Try a shorter excerpt.' });
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Server is missing its Gemini API key.' });

    const quiz = await callGeminiForQuiz(`Here are the notes:\n\n${notes}`);
    
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

app.get('/api/generate-quiz-file', (req, res) => {
  res.status(405).json({ error: 'This endpoint requires a POST request with a file upload (multipart/form-data).' });
});

app.post('/api/generate-quiz-file', quizLimiter, ensureAuthenticated, (req, res) => {
  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg = uploadErr.code === 'LIMIT_FILE_SIZE' 
        ? 'File is too large. Max limit on Vercel is 4.5MB.' 
        : (uploadErr.message || 'Could not process the uploaded file.');
      return res.status(400).json({ error: msg });
    }
    try {
      if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
      if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Server is missing its Gemini API key.' });

      let quiz;

      if (req.file.mimetype === 'application/pdf') {
        let extractedText = "";
        try {
          const pdfData = await parsePdf(req.file.buffer);
          extractedText = pdfData.text || "";
        } catch (pdfErr) {
          return res.status(400).json({ error: 'Could not extract text from the PDF file.' });
        }

        if (extractedText.trim().length < 30) {
          return res.status(400).json({ error: 'Could not extract enough readable text from the PDF. Ensure it contains selectable text.' });
        }

        quiz = await callGeminiForQuiz(`Here is the text extracted from the uploaded document:\n\n${extractedText.substring(0, 8000)}`);
      } else if (req.file.mimetype.startsWith('image/')) {
        const base64Image = req.file.buffer.toString('base64');
        const dataUrl = `data:${req.file.mimetype};base64,${base64Image}`;

        const completion = await openai.chat.completions.create({
          model: "gemini-2.0-flash",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                { type: "text", text: "Generate academic multiple-choice questions based on the study notes in this image." },
                { type: "image_url", image_url: { url: dataUrl } }
              ]
            }
          ]
        });

        const responseText = completion.choices[0].message.content;
        quiz = parseAndShuffleQuiz(responseText);
      } else {
        return res.status(400).json({ error: 'Unsupported file format.' });
      }

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

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;

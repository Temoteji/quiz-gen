const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@libsql/client');

const app = express();

// Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'quizforge-super-secret-key';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || 'https://quiz-gen-topaz.vercel.app';

// Database Client (Turso / libSQL). Falls back to a local file for dev if
// no remote credentials are set, but on Vercel you MUST set TURSO_DATABASE_URL
// and TURSO_AUTH_TOKEN, since the deployed filesystem is read-only/ephemeral.
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN
});

let dbReady = db.execute(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    picture TEXT
  )
`).then(() => db.execute(`
  CREATE TABLE IF NOT EXISTS quizzes (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    quiz_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )
`)).then(() => db.execute(`
  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    questions_answered INTEGER,
    correct_answers INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )
`)).catch(err => console.error('DB init error:', err));

// Ensure tables exist before handling any request
app.use(async (req, res, next) => {
  try {
    await dbReady;
    next();
  } catch (err) {
    next(err);
  }
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));

// In-Memory Storage for File Uploads (Vercel compatible)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Initialize Gemini AI client
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Auth Middleware
function authenticateToken(req, res, next) {
  const token = req.cookies.token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired session' });
    req.user = user;
    next();
  });
}

// AI Call Helper with Exponential Backoff Retry Logic
async function generateQuizWithRetry(prompt, fileBuffer = null, mimeType = null, retries = 3) {
  if (!genAI) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const model = genAI.getGenerativeModel({ 
    model: 'gemini-1.5-flash',
    generationConfig: { responseMimeType: 'application/json' }
  });

  const systemInstruction = `
    You are an expert academic quiz generator.
    Generate a JSON array of exactly 10 multiple-choice questions based on the provided material.
    Each item must strictly follow this structure:
    {
      "question": "Clear and challenging question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctIndex": 0,
      "explanation": "Detailed explanation of why this answer is correct."
    }
    Ensure options are distinct and correctIndex is an integer from 0 to 3.
  `;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      let contents = [];
      if (fileBuffer && mimeType) {
        contents = [
          systemInstruction,
          prompt,
          {
            inlineData: {
              data: fileBuffer.toString('base64'),
              mimeType
            }
          }
        ];
      } else {
        contents = [systemInstruction, prompt];
      }

      const result = await model.generateContent(contents);
      const responseText = result.response.text();
      const cleanedJson = responseText.replace(/```json|```/g, '').trim();
      
      const parsedQuiz = JSON.parse(cleanedJson);
      if (!Array.isArray(parsedQuiz) || parsedQuiz.length === 0) {
        throw new Error('AI generated an invalid quiz structure.');
      }
      return parsedQuiz;
    } catch (err) {
      lastError = err;
      console.warn(`Gemini generation attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        // Wait 1.5s, 3s, etc. before retrying
        await new Promise(resolve => setTimeout(resolve, attempt * 1500));
      }
    }
  }
  throw lastError;
}

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================

// Google OAuth Redirect
app.get('/auth/google', (req, res) => {
  const redirectUri = `${BASE_URL}/auth/google/callback`;
  const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${GOOGLE_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent('openid email profile')}` +
    `&prompt=select_account`;
  
  res.redirect(googleAuthUrl);
});

// Google OAuth Callback
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=NoCode');

  try {
    // Exchange auth code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/auth/google/callback`,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokenData.error_description || 'Token exchange failed');

    // Fetch user info from Google
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await userRes.json();

    const userData = {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      picture: profile.picture
    };

    await db.execute({
      sql: `INSERT INTO users (id, name, email, picture) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email, picture = excluded.picture`,
      args: [userData.id, userData.name, userData.email, userData.picture]
    });

    // Generate JWT Token
    const token = jwt.sign(userData, JWT_SECRET, { expiresIn: '24h' });

    // Set secure HTTP-Only cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 24 * 60 * 60 * 1000
    });

    res.redirect('/');
  } catch (err) {
    console.error('OAuth Callback Error:', err);
    res.redirect('/?error=AuthFailed');
  }
});

// Logout
app.get('/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.redirect('/');
});

// Get Current Authenticated User Profile
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await db.execute({
      sql: `SELECT COALESCE(SUM(questions_answered), 0) AS total_answered,
                   COALESCE(SUM(correct_answers), 0) AS correct_answered
            FROM scores WHERE user_id = ?`,
      args: [userId]
    });

    const row = result.rows[0] || { total_answered: 0, correct_answered: 0 };
    const totalAnswered = Number(row.total_answered) || 0;
    const correctAnswered = Number(row.correct_answered) || 0;
    const avgScore = totalAnswered > 0 ? (correctAnswered / totalAnswered) * 100 : 0;

    res.json({
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      picture: req.user.picture,
      total_answered: totalAnswered,
      avg_score: avgScore
    });
  } catch (err) {
    console.error('Fetch /api/me Error:', err);
    res.status(500).json({ error: 'Failed to load profile.' });
  }
});

// ==========================================
// QUIZ MANAGEMENT & GENERATION ROUTES
// ==========================================

// Get All Quizzes for Logged-In User
app.get('/api/quizzes', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const quizzesResult = await db.execute({
      sql: `SELECT id, user_id, quiz_data, created_at FROM quizzes
            WHERE user_id = ? ORDER BY created_at DESC`,
      args: [userId]
    });

    const statsResult = await db.execute({
      sql: `SELECT COALESCE(SUM(questions_answered), 0) AS total_answered,
                   COALESCE(SUM(correct_answers), 0) AS correct_answered
            FROM scores WHERE user_id = ?`,
      args: [userId]
    });

    const statsRow = statsResult.rows[0] || { total_answered: 0, correct_answered: 0 };
    const totalAnswered = Number(statsRow.total_answered) || 0;
    const correctAnswered = Number(statsRow.correct_answered) || 0;
    const avgScore = totalAnswered > 0 ? (correctAnswered / totalAnswered) * 100 : 0;

    res.json({ quizzes: quizzesResult.rows, avg_score: avgScore });
  } catch (err) {
    console.error('Fetch /api/quizzes Error:', err);
    res.status(500).json({ error: 'Failed to load quizzes.' });
  }
});

// Generate Quiz from Text Notes
app.post('/api/generate-quiz', authenticateToken, async (req, res) => {
  const { notes } = req.body;
  if (!notes || notes.trim().length < 30) {
    return res.status(400).json({ error: 'Please provide at least 30 characters of notes.' });
  }

  try {
    const prompt = `Generate a 10-question quiz based on these study notes:\n\n${notes}`;
    const quizData = await generateQuizWithRetry(prompt);

    await db.execute({
      sql: `INSERT INTO quizzes (id, user_id, quiz_data) VALUES (?, ?, ?)`,
      args: [Date.now().toString(), req.user.id, JSON.stringify(quizData)]
    });

    res.json({ quiz: quizData });
  } catch (err) {
    console.error('Quiz Generation Error:', err);
    res.status(500).json({ error: 'The AI service failed to respond. Please try again shortly.' });
  }
});

// Generate Quiz from Uploaded File (Image/PDF)
app.post('/api/generate-quiz-file', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  try {
    const prompt = 'Extract the key educational topics from this uploaded document and generate a 10-question quiz.';
    const quizData = await generateQuizWithRetry(prompt, req.file.buffer, req.file.mimetype);

    await db.execute({
      sql: `INSERT INTO quizzes (id, user_id, quiz_data) VALUES (?, ?, ?)`,
      args: [Date.now().toString(), req.user.id, JSON.stringify(quizData)]
    });

    res.json({ quiz: quizData });
  } catch (err) {
    console.error('File Quiz Generation Error:', err);
    res.status(500).json({ error: 'The AI service failed to process the file. Please try again.' });
  }
});

// Save Completed Quiz Score
app.post('/api/save-score', authenticateToken, async (req, res) => {
  try {
    const { answered, correct } = req.body;
    const userId = req.user.id;

    await db.execute({
      sql: `INSERT INTO scores (user_id, questions_answered, correct_answers) VALUES (?, ?, ?)`,
      args: [userId, Number(answered) || 0, Number(correct) || 0]
    });

    const statsResult = await db.execute({
      sql: `SELECT COALESCE(SUM(questions_answered), 0) AS total_answered,
                   COALESCE(SUM(correct_answers), 0) AS correct_answered
            FROM scores WHERE user_id = ?`,
      args: [userId]
    });

    const row = statsResult.rows[0] || { total_answered: 0, correct_answered: 0 };
    res.json({
      success: true,
      stats: {
        total_answered: Number(row.total_answered) || 0,
        correct_answered: Number(row.correct_answered) || 0
      }
    });
  } catch (err) {
    console.error('Save Score Error:', err);
    res.status(500).json({ error: 'Failed to save score.' });
  }
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// Export for Vercel Serverless Function
module.exports = app;

// Local Development Guard
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server listening at http://localhost:${PORT}`);
  });
}

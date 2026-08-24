require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

app.use(express.json({ limit: '100kb' }));

// Vercel serverless static path resolution
app.use(express.static(path.join(__dirname, 'public')));

const quizLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this device. Try again in a bit.' }
});

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

async function callGeminiForQuiz(contentParts) {
  try {
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.0-flash',
      systemInstruction: SYSTEM_PROMPT 
    });

    const result = await model.generateContent(contentParts);
    const responseText = result.response.text();

    let raw = responseText.replace(/```json|```/g, '').trim();
    let quiz = JSON.parse(raw);

    if (!Array.isArray(quiz) || quiz.length === 0) {
      throw new Error('The AI did not return any questions. Try again.');
    }
    return quiz;
  } catch (error) {
    console.error('Gemini API error:', error);
    throw new Error(error.message || 'The AI service failed to respond. Try again shortly.');
  }
}

app.post('/api/generate-quiz', quizLimiter, async (req, res) => {
  try {
    const notes = (req.body && req.body.notes ? String(req.body.notes) : '').trim();
    if (notes.length < 30) {
      return res.status(400).json({ error: 'Notes are too short to build a quiz from.' });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server is missing its API key.' });
    }

    const quiz = await callGeminiForQuiz([`Here are the notes:\n\n${notes}`]);
    res.json({ quiz });
  } catch (err) {
    console.error('Error generating quiz from text:', err);
    res.status(502).json({ error: err.message || 'Something went wrong on the server.' });
  }
});

app.post('/api/generate-quiz-file', quizLimiter, (req, res) => {
  upload.single('file')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message || 'Could not process file.' });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file was uploaded.' });
      }
      if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Server is missing its API key.' });
      }

      const base64Data = req.file.buffer.toString('base64');
      const quiz = await callGeminiForQuiz([
        { inlineData: { data: base64Data, mimeType: req.file.mimetype } },
        'Generate the quiz from this material.'
      ]);

      res.json({ quiz });
    } catch (err) {
      console.error('Error generating quiz from file:', err);
      res.status(502).json({ error: err.message || 'Something went wrong on the server.' });
    }
  });
});

// Explicit root route fallback for SPA/static serving
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;

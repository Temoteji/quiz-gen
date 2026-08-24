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

if (!GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is not set. The quiz endpoint will fail until it is set.');
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

app.use(express.json({ limit: '100kb' }));

// Robust static path resolution: checks both local and Vercel serverless layouts
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
      model: 'gemini-1.5-flash',
      systemInstruction: SYSTEM_PROMPT 
    });

    const result = await model.generateContent(contentParts);
    const responseText = result.response.text();

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
    console.error('Gemini API error:', error);
    throw new Error('The AI service failed to respond. Try again shortly.');
  }
}

app.post('/api/generate-quiz', quizLimiter, async (req, res) => {
  try {
    const notes = (req.body && req.body.notes ? String(req.body.notes) : '').trim();
    if (notes.length < 30) {
      return res.status(400).json({ error: 'Notes are too short to build a quiz from.' });
    }
    if (notes.length > 12000) {
      return res.status(400).json({ error: 'Notes are too long. Try a shorter excerpt.' });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server is missing its API key. The site owner needs to configure GEMINI_API_KEY.' });
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
      const msg = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large. Max size is 10MB.'
        : (uploadErr.message || 'Could not process the uploaded file.');
      return res.status(400).json({ error: msg });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file was uploaded.' });
      }
      if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Server is missing its API key. The site owner needs to configure GEMINI_API_KEY.' });
      }

      const base64Data = req.file.buffer.toString('base64');
      const filePart = {
        inlineData: {
          data: base64Data,
          mimeType: req.file.mimetype
        }
      };

      const quiz = await callGeminiForQuiz([
        filePart,
        'Here are the study notes (as an image or document). Generate the quiz from this material.'
      ]);

      res.json({ quiz });
    } catch (err) {
      console.error('Error generating quiz from file:', err);
      res.status(502).json({ error: err.message || 'Something went wrong on the server.' });
    }
  });
});

// Fallback route to serve index.html for any unhandled non-API GET request
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'), (err) => {
    if (err) {
      res.sendFile(path.join(vercelPublicPath, 'index.html'));
    }
  });
});

// Run locally if not on Vercel
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Notes → Quiz server running on port ${PORT}`);
  });
}

// Export for Vercel's serverless environment
module.exports = app;

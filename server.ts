import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));

const STUDENTS_DB_PATH = path.resolve(__dirname, 'students_roster_db.json');

function readStudentsFromDisk(): any[] {
  try {
    if (fs.existsSync(STUDENTS_DB_PATH)) {
      const raw = fs.readFileSync(STUDENTS_DB_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.warn('Could not read students_roster_db.json:', e);
  }
  return [];
}

function writeStudentsToDisk(students: any[]) {
  try {
    fs.writeFileSync(STUDENTS_DB_PATH, JSON.stringify(students, null, 2), 'utf-8');
  } catch (e) {
    console.warn('Could not write students_roster_db.json:', e);
  }
}

// API: Get saved student roster for Teacher Dashboard
app.get('/api/students', (_req, res) => {
  const students = readStudentsFromDisk();
  return res.json({ students });
});

// API: Sync / Save student roster when student enters name or teacher updates roster
app.post('/api/students', (req, res) => {
  const { students } = req.body;
  if (!Array.isArray(students)) {
    return res.status(400).json({ error: 'Invalid students array' });
  }
  writeStudentsToDisk(students);
  return res.json({ ok: true, count: students.length });
});

// API: Sunny conversational assistant for Grade 4
app.post('/api/sunny-chat', async (req, res) => {
  const {
    message,
    topic = 'General',
    history = [],
    unitInfo,
    isSpokenVoice = false,
    nextSuggestedQuestion,
  } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    const fallback = generateFallbackSunnyResponse(
      message,
      topic,
      history,
      isSpokenVoice,
      nextSuggestedQuestion
    );
    return res.json({
      ...fallback,
      isAiGenerated: false,
      note: 'Dịch vụ AI ngoại tuyến hoặc chưa cấu hình API key. Đang dùng kịch bản thông minh sư phạm.',
    });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const previouslyAsked = history
      .filter((h: any) => h.role === 'model')
      .map((h: any) => h.text)
      .join(' | ');

    const systemPrompt = `You are Sunny, a cheerful, warm, and encouraging learning companion robot for 4th-grade primary school students in Vietnam learning English with the "Global Success 4" textbook.
Target Audience: 9-10 year old Vietnamese elementary pupils (CEFR Pre-A1/A1).
Current Topic: ${topic}
${unitInfo ? `Target Unit: ${unitInfo.title}. Target vocabulary: ${unitInfo.vocab}. Target structures: ${unitInfo.structures}` : ''}
${nextSuggestedQuestion ? `Suggested next curriculum question to ask: "${nextSuggestedQuestion.questionEn}"` : ''}
Previously asked questions (DO NOT REPEAT THESE): ${previouslyAsked}
${isSpokenVoice ? 'CRITICAL REQUIREMENT: The student spoke this response using the microphone. In the "evaluation" field, write an inspiring, warm, cheerful, positive, and motivating feedback comment IN VIETNAMESE praising their spoken effort. Highlight their courage, clear pronunciation, natural intonation, and correct Grade 4 sentence structure. Always give them words of encouragement. Never be harsh or critical.' : ''}

Pedagogical Rules:
1. Always be super enthusiastic, friendly, and kind. Never judge mistakes harshly.
2. Keep your English response SHORT (1-2 simple sentences max): first praise/acknowledge the student's answer, then ask ONE NEW, DIVERSE question from the Grade 4 curriculum (never repeat a previous question).
3. Include a friendly Vietnamese translation in "vietnameseTranslation".
4. Suggest 3 short sample answers that 4th graders can practice saying.
5. If isSpokenVoice is true, the "evaluation" field MUST contain an encouraging, positive Vietnamese review with emojis (🎉, 👏, 🌟, ⭐) celebrating their speaking attempt.
6. NEVER ask for personal data (no phone, home address, school passwords).
7. Response MUST be valid JSON with this exact structure:
{
  "reply": "English reply from Sunny (max 2 sentences, ends with a new friendly question)",
  "vietnameseTranslation": "Bản dịch tiếng Việt thân thiện",
  "hint": "Gợi ý cách trả lời ngắn gọn",
  "evaluation": "Nhận xét tích cực, động viên và khen ngợi phát âm chi tiết bằng tiếng Việt",
  "suggestedReplies": ["English option 1", "English option 2", "English option 3"]
}`;

    const formattedContents = [
      { role: 'user' as const, parts: [{ text: systemPrompt }] },
      ...history.slice(-8).map((h: { role: string; text: string }) => ({
        role: (h.role === 'user' ? 'user' : 'model') as 'user' | 'model',
        parts: [{ text: h.text }],
      })),
      {
        role: 'user' as const,
        parts: [
          {
            text: `Student says: "${message}". ${isSpokenVoice ? 'The student SPOKE this sentence via microphone.' : ''} Please reply as Sunny in JSON format with a new question.`,
          },
        ],
      },
    ];

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: formattedContents,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.75,
      },
    });

    const responseText = response.text || '{}';
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      parsed = generateFallbackSunnyResponse(
        message,
        topic,
        history,
        isSpokenVoice,
        nextSuggestedQuestion
      );
    }

    return res.json({
      ...parsed,
      isAiGenerated: true,
    });
  } catch (error: any) {
    console.error('Gemini API chat error:', error?.message || error);
    const fallback = generateFallbackSunnyResponse(
      message,
      topic,
      history,
      isSpokenVoice,
      nextSuggestedQuestion
    );
    return res.json({
      ...fallback,
      isAiGenerated: false,
      note: 'Dịch vụ AI tạm thời bận. Đã chuyển sang phản hồi sư phạm chuẩn lớp 4.',
    });
  }
});

// Rule-based fallback response engine with diverse question progression
function generateFallbackSunnyResponse(
  _message: string,
  _topic: string,
  _history: any[],
  isSpokenVoice = false,
  nextSuggestedQuestion?: {
    questionEn: string;
    translationVi: string;
    hint: string;
    suggestedReplies: string[];
  }
) {
  const praisesVi = [
    'Em phát âm rất to, rõ ràng và tự tin, ngữ điệu câu nói rất tự nhiên!',
    'Giọng đọc tiếng Anh của em rất trong sáng, phát âm âm cuối rất chuẩn xác!',
    'Em phản xạ trả lời rất nhanh, vận dụng đúng mẫu câu Tiếng Anh lớp 4!',
    'Câu trả lời của em rất mạch lạc, tự tin và đáng khen ngợi!',
  ];
  const randomPraise = praisesVi[Math.floor(Math.random() * praisesVi.length)];

  const evaluation = isSpokenVoice
    ? `🎉 Giỏi lắm! ${randomPraise} Sunny cộng cho em 2 ngôi sao chăm chỉ nhé! ⭐⭐`
    : undefined;

  if (nextSuggestedQuestion && nextSuggestedQuestion.questionEn) {
    const englishPrefixes = ['Awesome!', 'Wonderful!', 'Great job!', 'Fantastic!', 'Well done!'];
    const viPrefixes = ['Tuyệt vời quá!', 'Giỏi lắm!', 'Em trả lời rất tốt!', 'Hay lắm!'];
    const idx = Math.floor(Math.random() * englishPrefixes.length);

    return {
      reply: `${englishPrefixes[idx]} ${nextSuggestedQuestion.questionEn}`,
      vietnameseTranslation: `${viPrefixes[idx]} ${nextSuggestedQuestion.translationVi}`,
      hint: nextSuggestedQuestion.hint,
      evaluation,
      suggestedReplies: nextSuggestedQuestion.suggestedReplies,
    };
  }

  return {
    reply: 'Great job speaking English with me! What do you like doing after school?',
    vietnameseTranslation: 'Em nói tiếng Anh rất tốt! Sau giờ học em thích làm gì nào?',
    hint: "Dùng mẫu: 'I play badminton.' hoặc 'I listen to music.'",
    evaluation,
    suggestedReplies: ['I play badminton with my friends.', 'I listen to music.', 'I read comic books.'],
  };
}

// Development with Vite middleware or Production static files
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`English Speaking Adventure 4 server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});

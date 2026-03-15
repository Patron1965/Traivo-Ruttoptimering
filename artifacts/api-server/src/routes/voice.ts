import { Router, type IRouter } from "express";
import multer from "multer";
import { openai } from "@workspace/integrations-openai-ai-server";
import { handleError } from "../lib/errors";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "audio/webm",
      "audio/wav",
      "audio/mp4",
      "audio/mpeg",
      "audio/ogg",
      "audio/x-m4a",
      "video/webm",
    ];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported audio format"));
    }
  },
});

router.post("/voice/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No audio file provided" });
      return;
    }

    const languageHint = (req.body?.language as string) || undefined;

    const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
    const ext = req.file.mimetype.includes("webm") ? "webm" : req.file.mimetype.includes("wav") ? "wav" : "mp4";
    const file = new File([blob], `audio.${ext}`, { type: req.file.mimetype });

    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file,
      language: languageHint,
    });

    res.json({ text: transcription.text, language: languageHint || "auto" });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;

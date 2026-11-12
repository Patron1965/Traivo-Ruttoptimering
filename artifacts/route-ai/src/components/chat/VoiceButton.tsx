import { useState, useRef, useCallback } from "react";
import { Mic, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

type VoiceState = "idle" | "recording" | "transcribing";

interface VoiceButtonProps {
  onTranscription: (text: string) => void;
  disabled?: boolean;
  size?: "sm" | "lg" | "responsive";
}

export function VoiceButton({ onTranscription, disabled, size = "sm" }: VoiceButtonProps) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<VoiceState>("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/mp4";

      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mimeType });

        if (blob.size < 100) {
          setState("idle");
          return;
        }

        setState("transcribing");

        try {
          const formData = new FormData();
          const ext = mimeType.includes("webm") ? "webm" : "mp4";
          formData.append("audio", blob, `recording.${ext}`);

          const lang = i18n.language === "sv" ? "sv" : undefined;
          if (lang) formData.append("language", lang);

          const res = await fetch(`${import.meta.env.BASE_URL}api/voice/transcribe`, {
            method: "POST",
            body: formData,
          });

          if (!res.ok) throw new Error("Transcription failed");

          const data = await res.json();
          if (data.text?.trim()) {
            onTranscription(data.text.trim());
          }
        } catch (err) {
          console.error("Voice transcription error:", err);
        } finally {
          setState("idle");
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setState("recording");
    } catch (err) {
      console.error("Microphone access error:", err);
      setState("idle");
    }
  }, [i18n.language, onTranscription]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const handleClick = useCallback(() => {
    if (state === "idle") {
      startRecording();
    } else if (state === "recording") {
      stopRecording();
    }
  }, [state, startRecording, stopRecording]);

  const sizeClasses = size === "lg"
    ? "h-14 w-14"
    : size === "responsive"
      ? "h-10 w-10 sm:h-10 sm:w-10 max-[640px]:h-12 max-[640px]:w-12"
      : "h-10 w-10";

  const iconClasses = size === "lg"
    ? "h-6 w-6"
    : size === "responsive"
      ? "h-4 w-4 max-[640px]:h-5 max-[640px]:w-5"
      : "h-4 w-4";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || state === "transcribing"}
      title={
        state === "idle"
          ? t("voice.clickToTalk")
          : state === "recording"
            ? t("voice.listening")
            : t("voice.transcribing")
      }
      className={cn(
        "relative flex items-center justify-center rounded-xl transition-all duration-200",
        sizeClasses,
        state === "recording"
          ? "bg-red-500 text-white hover:bg-red-600"
          : state === "transcribing"
            ? "bg-muted text-muted-foreground cursor-wait"
            : "bg-muted text-muted-foreground hover:bg-primary hover:text-primary-foreground",
        (disabled || state === "transcribing") && "opacity-50 cursor-not-allowed"
      )}
    >
      {state === "recording" && (
        <span className="absolute inset-0 rounded-xl border-2 border-red-400 animate-ping opacity-50" />
      )}
      {state === "transcribing" ? (
        <Loader2 className={cn("animate-spin", iconClasses)} />
      ) : (
        <Mic className={iconClasses} />
      )}
    </button>
  );
}

"""Local transcription service for the Comerdata player."""

import argparse
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import os
from pathlib import Path
import re
from threading import Lock, Thread
from time import monotonic
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from report import transcript_pdf

ADDRESS = ("127.0.0.1", 17831)
DATA = Path(os.environ.get("TRANSCRIPT_DATA") or (
    Path(os.environ.get("LOCALAPPDATA", Path.home())) / "ComerdataTranscript"
))
WHISPER_PATH = DATA / "models" / "whisper-base"
ORIGIN = re.compile(r"chrome-extension://[a-p]{32}")
JOB_PATH = re.compile(r"/jobs/([0-9a-f]{32})")
JOBS = {}
JOBS_LOCK = Lock()
LONG_GAP_SECONDS = 12
MAX_LESSON_SECONDS = 15 * 60
MAX_DECODED_SECONDS = MAX_LESSON_SECONDS + 10


class UserError(Exception):
    pass


@lru_cache(maxsize=1)
def whisper():
    from faster_whisper import WhisperModel

    return WhisperModel(str(WHISPER_PATH), device="cpu", compute_type="int8", local_files_only=True)


def long_gaps(duration, coverage):
    gaps = []
    previous_end = 0
    for start, end in sorted(coverage):
        start = max(0.0, float(start))
        end = min(duration, float(end))
        if end <= start:
            continue
        if start - previous_end >= LONG_GAP_SECONDS:
            gaps.append({"start": round(previous_end, 2), "end": round(start, 2)})
        previous_end = max(previous_end, end)
    if duration - previous_end >= LONG_GAP_SECONDS:
        gaps.append({"start": round(previous_end, 2), "end": round(duration, 2)})
    return gaps


def transcribe(data, expected_seconds, progress):
    from faster_whisper.audio import decode_audio

    try:
        audio = decode_audio(BytesIO(data))
    except Exception as error:
        raise UserError("No se pudo decodificar el audio de la lección.") from error
    if not 0 < audio.size <= 16_000 * MAX_DECODED_SECONDS:
        raise UserError("El audio está vacío o supera el límite de duración.")
    if abs(audio.size / 16_000 - expected_seconds) > max(2.5, expected_seconds * 0.07):
        raise UserError("La duración del audio extraído no coincide con la lección. Vuelve a procesarla.")

    progress(0)
    segments, info = whisper().transcribe(audio, beam_size=3, vad_filter=True, word_timestamps=True)
    lines = []
    coverage = []
    for segment in segments:
        text = segment.text.strip()
        if text:
            lines.append({"start": round(max(0.0, float(segment.start)), 2),
                          "end": round(max(0.0, float(segment.end)), 2), "text": text})
            coverage.extend(
                (word.start, word.end) for word in (segment.words or []) if word.word.strip()
            )
        progress(min(99, int(segment.end / expected_seconds * 100)))
    if not lines:
        raise UserError("Whisper no encontró voz reconocible en esta lección.")
    return {"language": info.language, "segments": lines,
            "gaps": long_gaps(expected_seconds, coverage) if coverage else None}


def run_job(job_id, audio, seconds):
    def update(state, **details):
        with JOBS_LOCK:
            JOBS[job_id] = {"state": state, "updated": monotonic(), **details}

    try:
        print("Procesando audio de una lección...", flush=True)
        result = transcribe(audio, seconds, lambda percent: update("transcribing", percent=percent))
        update("done", **result)
        print("Transcripción lista. Esperando otra lección.", flush=True)
    except UserError as error:
        update("failed", error=str(error))
        print(str(error), flush=True)
    except Exception as error:
        update("failed", error="Falló Whisper. Revisa la ventana de Transcript.")
        print(f"Error de Whisper: {type(error).__name__}", flush=True)


def start_job(audio, seconds):
    with JOBS_LOCK:
        for key, job in list(JOBS.items()):
            if job["state"] in ("decoding", "transcribing"):
                raise UserError("Ya hay una lección en proceso. Espera a que termine.")
            if monotonic() - job["updated"] > 1800:
                del JOBS[key]
        while len(JOBS) >= 16:
            del JOBS[next(iter(JOBS))]
        job_id = uuid4().hex
        JOBS[job_id] = {"state": "decoding", "updated": monotonic()}
    Thread(target=run_job, args=(job_id, audio, seconds), daemon=True).start()
    return job_id


def export_document(payload, format):
    if not isinstance(payload, dict):
        raise UserError("Falta una transcripción válida.")
    title, lessons = payload.get("title"), payload.get("lessons")
    combined = payload.get("combined") is True
    if not isinstance(title, str) or not title.strip() or len(title) > 160:
        raise UserError("Falta el título de la lección.")
    if not isinstance(lessons, list) or not lessons or (not combined and len(lessons) != 1):
        raise UserError("Falta una transcripción válida.")
    for lesson in lessons:
        if not isinstance(lesson, dict):
            raise UserError("Hay una lección inválida.")
        subtitle, segments = lesson.get("title"), lesson.get("segments")
        if not isinstance(subtitle, str) or not subtitle.strip() or len(subtitle) > 160:
            raise UserError("Una lección no tiene un título válido.")
        if not isinstance(segments, list) or not 1 <= len(segments) <= 1200:
            raise UserError("Una lección no tiene una transcripción válida.")
        if format == "docx" and combined:
            if any(not isinstance(lesson.get(key), str) or not lesson[key].strip()
                   or len(lesson[key]) > 160 for key in ("module", "moduleTitle")):
                raise UserError("Una lección no tiene un módulo válido.")
        for segment in segments:
            if not isinstance(segment, dict):
                raise UserError("Hay un segmento de texto inválido.")
            start, text = segment.get("start"), segment.get("text")
            if type(start) not in (int, float) or not 0 <= start <= MAX_DECODED_SECONDS or not isinstance(text, str):
                raise UserError("Hay un segmento de texto inválido.")
            end = segment.get("end")
            if format == "docx" and (type(end) not in (int, float) or not start <= end <= MAX_DECODED_SECONDS):
                raise UserError("Vuelve a transcribir la lección para obtener sus tiempos completos.")
    if format == "docx":
        from word_report import transcript_docx

        return transcript_docx(title, lessons, combined)
    return transcript_pdf(title, lessons, combined)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def permitted(self, require_client=True, require_origin=True):
        return (
            self.headers.get("Host") == f"{ADDRESS[0]}:{ADDRESS[1]}"
            and (not require_origin or ORIGIN.fullmatch(self.headers.get("Origin", "")))
            and (not require_client or self.headers.get("X-Transcript-Client") == "1")
        )

    def reply(self, code, body=b"", kind="application/json; charset=utf-8"):
        self.send_response(code)
        origin = self.headers.get("Origin", "")
        if ORIGIN.fullmatch(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def reply_json(self, code, value):
        self.reply(code, json.dumps(value, ensure_ascii=False).encode("utf-8"))

    def do_OPTIONS(self):
        if not self.permitted(require_client=False):
            self.reply(403)
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Transcript-Client")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self):
        if not self.permitted(require_origin=False):
            self.reply(403)
        elif self.path == "/health":
            self.reply_json(200, {"service": "comerdata-transcript", "protocol": 6})
        elif match := JOB_PATH.fullmatch(self.path):
            with JOBS_LOCK:
                job = JOBS.get(match[1])
            if job is None or (
                job["state"] in ("done", "failed") and monotonic() - job["updated"] > 1800
            ):
                self.reply_json(404, {"error": "La transcripción ya no está disponible. Vuelve a iniciarla."})
            else:
                self.reply_json(200, {key: value for key, value in job.items() if key != "updated"})
        else:
            self.reply(404)

    def do_POST(self):
        if not self.permitted():
            self.reply(403)
            return
        route = urlsplit(self.path)
        if route.path not in ("/jobs", "/pdf", "/docx"):
            self.reply(404)
            return
        is_audio = route.path == "/jobs"
        kind = "audio/mp4" if is_audio else "application/json"
        if self.headers.get_content_type() != kind:
            self.reply(415)
            return
        length = self.headers.get("Content-Length", "")
        limit = 32_000_000 if is_audio else 12_000_000
        if not length.isascii() or not length.isdecimal() or len(length) > 9 or not 0 < int(length) <= limit:
            self.reply_json(413, {"error": "La solicitud supera el tamaño admitido o está vacía."})
            return
        try:
            self.connection.settimeout(25)
            body = self.rfile.read(int(length))
            if len(body) != int(length):
                raise UserError("La solicitud llegó incompleta.")
            if is_audio:
                seconds = float(parse_qs(route.query).get("seconds", ["0"])[0])
                if not 0 < seconds <= MAX_LESSON_SECONDS:
                    raise UserError("La duración de la lección debe ser mayor que cero y de hasta 15 minutos.")
                self.reply_json(202, {"id": start_job(body, seconds)})
            else:
                format = route.path[1:]
                mime = ("application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        if format == "docx" else "application/pdf")
                self.reply(200, export_document(json.loads(body), format), mime)
        except (UserError, ValueError, TimeoutError) as error:
            message = str(error) if isinstance(error, UserError) else "La solicitud no se pudo leer."
            self.reply_json(422, {"error": message})
        except Exception as error:
            print(f"Error local: {type(error).__name__}", flush=True)
            self.reply_json(500, {"error": "Falló el servicio local. Revisa la ventana de Transcript."})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare", action="store_true", help="Descarga el modelo de Whisper si falta.")
    args = parser.parse_args()
    if args.prepare and not (WHISPER_PATH / "model.bin").is_file():
        from faster_whisper.utils import download_model

        print("Descargando el modelo multilingüe de Whisper...", flush=True)
        download_model("base", output_dir=str(WHISPER_PATH))
    print("Cargando Whisper local...", flush=True)
    whisper()
    if args.prepare:
        return
    with ThreadingHTTPServer(ADDRESS, Handler) as server:
        print("Transcript listo. Esperando que pulses Transcribir en Brave. Deja esta ventana abierta.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()

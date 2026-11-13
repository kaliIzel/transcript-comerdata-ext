importScripts("archive.js");

const academy = /^https:\/\/academia\.comerdata\.com\/course\//;
const player = "https://iframe.mediadelivery.net";
const service = "http://127.0.0.1:17831";

async function localRequest(path, { body, kind, timeout = 15_000 } = {}) {
  const headers = { "X-Transcript-Client": "1" };
  if (kind) headers["Content-Type"] = kind;
  let response;
  try {
    response = await fetch(service + path, {
      method: body === undefined ? "GET" : "POST",
      body, headers, redirect: "error", signal: AbortSignal.timeout(timeout)
    });
  } catch (error) {
    throw new Error(error.name === "TimeoutError"
      ? "El servicio local no respondió a tiempo. Revisa la ventana de Transcript."
      : "Abre Iniciar Transcript.cmd y espera el mensaje «Transcript listo».");
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const error = new Error(detail?.error || `El servicio local respondió HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function download(format, title, lessons, combined = false) {
  const base = title.replace(/[^\p{L}\p{N} -]+/gu, "").trim().slice(0, 100) || "Lección";
  let bytes;
  let mime;
  if (format === "pdf" || format === "docx") {
    const response = await localRequest(`/${format}`, {
      body: JSON.stringify({ title, lessons, combined }), kind: "application/json", timeout: 25_000
    });
    bytes = new Uint8Array(await response.arrayBuffer());
    mime = format === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf";
  } else {
    bytes = new TextEncoder().encode(transcriptMarkdown(title, lessons, combined));
    mime = "text/markdown;charset=utf-8";
  }
  await chrome.downloads.download({
    url: `data:${mime};base64,${bytes.toBase64()}`,
    filename: `Transcript - ${base}.${format}`
  });
}

const cleanTitle = title => typeof title === "string" ? title.trim().replace(/\s+/g, " ").slice(0, 160) : "";
const lessonTitles = tab => chrome.tabs.sendMessage(tab.id, { type: "lesson-titles" }, { frameId: 0 })
  .catch(() => null);

async function readTitles(tab, info) {
  const titles = await lessonTitles(tab);
  const detected = cleanTitle(titles?.moduleTitle);
  const key = moduleKey(info);
  await trustedArchive;
  const stored = (await chrome.storage.local.get(key))[key];
  if (!stored && detected) await chrome.storage.local.set({ [key]: detected });
  return { title: cleanTitle(titles?.lessonTitle), courseTitle: cleanTitle(titles?.courseTitle),
    moduleTitle: stored || detected, moduleFallback: `Módulo ${info.module}` };
}

const resolvingJobs = new Map();

function resolveJob(pending) {
  if (!resolvingJobs.has(pending.id)) {
    const request = resolvePendingJob(pending).finally(() => resolvingJobs.delete(pending.id));
    resolvingJobs.set(pending.id, request);
  }
  return resolvingJobs.get(pending.id);
}

async function resolvePendingJob(pending) {
  let job;
  try {
    job = await (await localRequest(`/jobs/${pending.id}`, { timeout: 4000 })).json();
  } catch (error) {
    if (error.status !== 404) throw error;
    job = { state: "failed", error: error.message };
  }
  if (job.state !== "done" && job.state !== "failed") return job;
  const latest = (await chrome.storage.session.get(pending.key))[pending.key];
  if (latest?.id === pending.id) {
    if (job.state === "done") {
      const { id, ...lesson } = pending;
      await trustedArchive;
      try {
        await chrome.storage.local.set({ [pending.key]: { ...lesson, jobId: id, segments: job.segments,
          gaps: job.gaps ?? null, reviewed: false } });
      } catch {
        return { ...job, saved: false };
      }
    }
    await chrome.storage.session.remove(pending.key);
  }
  if (job.state === "failed") return job;
  await trustedArchive;
  const saved = (await chrome.storage.local.get(pending.key))[pending.key];
  return { ...job, saved: saved?.jobId === pending.id };
}

async function reconcileCourse(info) {
  const pending = await courseItems(chrome.storage.session, info.prefix);
  await Promise.allSettled(pending.map(resolveJob));
}

async function handle(message, tab, info) {
  if (message.type !== "enable" && message.key !== info.key) {
    throw new Error("Cambió la lección. Recarga la página para transcribir el nuevo video.");
  }
  switch (message.type) {
    case "enable": {
      await reconcileCourse(info);
      const titles = await readTitles(tab, info);
      const lessons = await courseArchive(info);
      const current = lessons.find(lesson => lesson.key === info.key);
      const pending = (await chrome.storage.session.get(info.key))[info.key];
      return {
        key: info.key,
        ...titles,
        title: current?.title || pending?.title || titles.title || `Lección ${info.lesson}`,
        courseTitle: titles.courseTitle || lessons.find(lesson => lesson.courseTitle)?.courseTitle || "",
        current: current?.segments,
        gaps: current?.gaps,
        reviewed: current?.reviewed,
        jobId: current?.jobId,
        pending: pending?.id,
        count: lessons.length
      };
    }
    case "titles":
      return readTitles(tab, info);
    case "health": {
      const health = await (await localRequest("/health", { timeout: 4000 })).json();
      if (health.service !== "comerdata-transcript" || health.protocol !== 6) {
        throw new Error("Cierra la ventana anterior de Transcript y vuelve a abrir Iniciar Transcript.cmd.");
      }
      return null;
    }
    case "start": {
      if (typeof message.audio !== "string" || message.audio.length > 42_666_668
          || !Number.isFinite(message.seconds) || message.seconds <= 0 || message.seconds > 15 * 60) {
        throw new Error("El audio supera el tamaño o la duración admitidos.");
      }
      const existing = (await chrome.storage.session.get(info.key))[info.key];
      if (existing) return { id: existing.id };
      const response = await localRequest(`/jobs?seconds=${message.seconds}`, {
        body: Uint8Array.fromBase64(message.audio), kind: "audio/mp4"
      });
      const { id } = await response.json();
      await chrome.storage.session.set({ [info.key]: {
        ...info, id,
        title: cleanTitle(message.title) || `Lección ${info.lesson}`,
        courseTitle: cleanTitle(message.courseTitle)
      } });
      return { id };
    }
    case "status": {
      if (!/^[0-9a-f]{32}$/.test(message.id)) throw new Error("La solicitud de transcripción no es válida.");
      const pending = (await chrome.storage.session.get(info.key))[info.key];
      if (pending?.id === message.id) return resolveJob(pending);
      await trustedArchive;
      const saved = (await chrome.storage.local.get(info.key))[info.key];
      if (saved?.jobId === message.id) return { state: "done", segments: saved.segments,
        gaps: saved.gaps, reviewed: saved.reviewed, saved: true };
      throw new Error("La transcripción ya no está disponible. Vuelve a iniciarla.");
    }
    case "rename": {
      const title = cleanTitle(message.title);
      await trustedArchive;
      const saved = (await chrome.storage.local.get(info.key))[info.key];
      if (saved && title) await chrome.storage.local.set({ [info.key]: { ...saved, title } });
      return null;
    }
    case "rename-module": {
      const title = cleanTitle(message.title);
      await trustedArchive;
      if (title) await chrome.storage.local.set({ [moduleKey(info)]: title });
      return null;
    }
    case "review": {
      await trustedArchive;
      const saved = (await chrome.storage.local.get(info.key))[info.key];
      if (!saved || saved.jobId !== message.id || !saved.gaps?.length) {
        throw new Error("Abre de nuevo la lección para revisar la transcripción más reciente.");
      }
      await chrome.storage.local.set({ [info.key]: { ...saved, reviewed: true } });
      return null;
    }
    case "count":
      await reconcileCourse(info);
      return (await courseArchive(info)).length;
    case "saved-lessons": {
      await reconcileCourse(info);
      return (await courseArchive(info)).map(({ key, jobId, module, moduleTitle, title }) =>
        ({ key, jobId, module, moduleTitle, title }));
    }
    case "delete-course-transcripts": {
      await reconcileCourse(info);
      if ((await courseItems(chrome.storage.session, info.prefix)).length) {
        throw new Error("Espera a que terminen las transcripciones del curso antes de eliminarlas.");
      }
      const lessons = await courseArchive(info);
      if (!Array.isArray(message.lessons) || message.lessons.length !== lessons.length
          || lessons.some((lesson, index) => lesson.key !== message.lessons[index]?.key
            || lesson.jobId !== message.lessons[index]?.jobId)) {
        throw new Error("La lista cambió. Revísala antes de volver a confirmar.");
      }
      if (lessons.length) await chrome.storage.local.remove(lessons.map(lesson => lesson.key));
      return lessons.length;
    }
    case "delete-lesson": {
      const target = message.target;
      if (typeof target !== "string" || !target.startsWith(info.prefix)
          || !/^[\w-]+\/[\w-]+$/.test(target.slice(info.prefix.length))) {
        throw new Error("La lección no pertenece a este curso.");
      }
      await trustedArchive;
      if ((await chrome.storage.session.get(target))[target]) {
        throw new Error("Espera a que termine la transcripción antes de eliminarla.");
      }
      const saved = (await chrome.storage.local.get(target))[target];
      if (saved && saved.jobId !== message.id) {
        throw new Error("La transcripción cambió. Actualiza la lista y vuelve a intentarlo.");
      }
      if (saved) await chrome.storage.local.remove(target);
      return null;
    }
    case "download": {
      if (!["md", "pdf", "docx"].includes(message.format)) throw new Error("Formato de descarga inválido.");
      if (message.combined) {
        await reconcileCourse(info);
        const lessons = await courseArchive(info);
        if (!lessons.length) throw new Error("Todavía no hay lecciones guardadas en este curso.");
        if (message.format === "docx") {
          const pending = lessons.filter(lesson => wordBlocker(lesson));
          if (pending.length) {
            const names = pending.slice(0, 4).map(lesson => lesson.title).join(" · ");
            const extra = pending.length > 4 ? ` y ${pending.length - 4} más` : "";
            throw new Error(`Word está pendiente de revisión en ${pending.length} lección(es). ${names}${extra}`);
          }
        }
        const title = cleanTitle(message.courseTitle) || lessons.find(lesson => lesson.courseTitle)?.courseTitle
          || `Curso ${info.course}`;
        await download(message.format, title,
          lessons.map(({ title, module, moduleTitle, segments }) => ({ title, module, moduleTitle, segments })), true);
        return lessons.length;
      }
      const title = cleanTitle(message.title) || `Lección ${info.lesson}`;
      if (message.format === "docx") {
        await trustedArchive;
        const key = moduleKey(info);
        const stored = await chrome.storage.local.get([info.key, key]);
        const saved = stored[info.key];
        if (!saved || saved.jobId !== message.id) throw new Error("Guarda la transcripción más reciente antes de descargar Word.");
        const blocker = wordBlocker(saved);
        if (blocker) throw new Error(blocker);
        await download(message.format, title, [{ title, moduleTitle: stored[key] || `Módulo ${info.module}`,
          segments: saved.segments }]);
      } else {
        await download(message.format, title, [{ title, segments: message.segments }]);
      }
      return null;
    }
    default:
      throw new Error("Solicitud de Transcript desconocida.");
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.origin !== player || !academy.test(sender.tab?.url || "")) {
    return;
  }
  const info = lessonInfo(sender.tab.url);
  if (!info) return;
  handle(message, sender.tab, info).then(
    value => respond({ value }),
    error => respond({ error: error.message })
  );
  return true;
});

chrome.action.onClicked.addListener(tab => {
  if (academy.test(tab.url || "")) {
    void chrome.tabs.sendMessage(tab.id, { type: "open-panel" }).catch(() => {});
  }
});


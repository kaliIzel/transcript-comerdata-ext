(async function installTranscript() {
  let context;
  async function request(type, data = {}) {
    const response = await chrome.runtime.sendMessage({ type, key: context?.key, ...data });
    if (!response) throw new Error("Abre Transcript desde una lección de Comerdata.");
    if (response.error) throw new Error(response.error);
    return response.value;
  }

  // The same video provider is used on other websites. Only mount on Comerdata.
  context = await request("enable").catch(() => null);
  if (!context) return;

  const triggerHost = document.createElement("transcript-trigger");
  const panelHost = document.createElement("transcript-panel");
  const triggerRoot = triggerHost.attachShadow({ mode: "closed" });
  const panelRoot = panelHost.attachShadow({ mode: "closed" });
  const style = new CSSStyleSheet();
  style.replaceSync(`
    :host { font: 14px/1.4 system-ui, sans-serif; color: #f6f6f6; }
    :host([floating]) {
      position: fixed; right: 12px; bottom: 48px; z-index: 2147483647;
    }
    button {
      font: inherit; color: inherit; background: #293847; border: 1px solid #687a8d;
      border-radius: 5px; padding: 4px 8px; cursor: pointer; white-space: nowrap;
    }
    button:focus-visible, textarea:focus-visible { outline: 2px solid #8cdbff; outline-offset: 2px; }
    button:disabled { opacity: .55; cursor: default; }
    section {
      box-sizing: border-box; position: fixed; right: 12px; bottom: 48px;
      z-index: 2147483647; width: min(365px, calc(100vw - 24px)); max-height: calc(100vh - 57px);
      overflow: auto; padding: 12px; background: #151b23; border: 1px solid #687a8d;
      border-radius: 8px; box-shadow: 0 4px 20px #0009;
    }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h2 { font-size: 15px; margin: 0; }
    p { margin: 9px 0; }
    progress, textarea, input { box-sizing: border-box; width: 100%; }
    progress { accent-color: #8cdbff; }
    label { display: block; margin: 9px 0; }
    input {
      margin-top: 3px; padding: 5px; border: 1px solid #687a8d; border-radius: 4px;
      background: #0c1118; color: inherit; font: inherit;
    }
    textarea {
      display: block; min-height: 52px; height: min(32vh, 155px); resize: vertical;
      margin: 10px 0; padding: 6px; border: 1px solid #687a8d; border-radius: 4px;
      color: inherit; background: #0c1118; font: inherit;
    }
    footer { display: flex; gap: 5px; flex-wrap: wrap; }
    .gap-list { display: flex; flex-wrap: wrap; gap: 5px; margin: 6px 0; }
    [hidden] { display: none !important; }
  `);
  triggerRoot.adoptedStyleSheets = panelRoot.adoptedStyleSheets = [style];

  function add(parent, tag, text) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (tag === "button") element.type = "button";
    parent.append(element);
    return element;
  }

  const trigger = add(triggerRoot, "button", "Transcribir");
  trigger.setAttribute("aria-expanded", "false");
  const panel = add(panelRoot, "section");
  panel.hidden = true;
  panel.setAttribute("aria-label", "Transcripción de la lección");
  const heading = add(panel, "header");
  add(heading, "h2", "Transcript");
  const close = add(heading, "button", "Cerrar");
  const moduleLabel = add(panel, "label", "Nombre del módulo");
  const moduleName = add(moduleLabel, "input");
  moduleName.type = "text";
  moduleName.maxLength = 160;
  moduleName.value = context.moduleTitle;
  moduleName.placeholder = context.moduleFallback;
  const titleLabel = add(panel, "label", "Título del video");
  const lessonTitle = add(titleLabel, "input");
  lessonTitle.type = "text";
  lessonTitle.maxLength = 160;
  lessonTitle.value = context.title;
  const start = add(panel, "button", "Transcribir lección");
  const status = add(panel, "p", "Pulsa Transcribir lección. El video puede quedar en pausa.");
  status.setAttribute("role", "status");
  const progress = add(panel, "progress");
  progress.max = 100;
  progress.setAttribute("aria-label", "Progreso de la transcripción");
  progress.hidden = true;
  const output = add(panel, "textarea");
  output.readOnly = true;
  output.setAttribute("aria-label", "Texto de la lección");
  output.hidden = true;
  const exports = add(panel, "footer");
  exports.hidden = true;
  const copy = add(exports, "button", "Copiar texto");
  const md = add(exports, "button", "Markdown");
  const pdf = add(exports, "button", "PDF");
  const word = add(exports, "button", "Word");
  const reviewArea = add(panel, "div");
  reviewArea.hidden = true;
  const reviewStatus = add(reviewArea, "p");
  const gapList = add(reviewArea, "div");
  gapList.className = "gap-list";
  const confirmReview = add(reviewArea, "button", "Confirmar que no falta voz");
  const courseStatus = add(panel, "p");
  const courseExports = add(panel, "footer");
  const courseMd = add(courseExports, "button", "Curso en Markdown");
  const coursePdf = add(courseExports, "button", "Curso en PDF");
  const courseWord = add(courseExports, "button", "Curso en Word");
  const savedLessons = add(panel, "details");
  add(savedLessons, "summary", "Gestionar transcripciones guardadas");
  const savedList = add(savedLessons, "div");

  async function refreshSavedLessons() {
    const lessons = await request("saved-lessons");
    showCount(lessons.length);
    savedList.replaceChildren();
    if (!lessons.length) {
      add(savedList, "p", "Este curso todavía no tiene transcripciones guardadas.");
      return;
    }
    const bulk = add(savedList, "div");
    addDeleteControls(bulk, "Eliminar todas las del curso", `Eliminar ${lessons.length} del curso`, async () => {
      const count = await request("delete-course-transcripts", {
        lessons: lessons.map(({ key, jobId }) => ({ key, jobId }))
      });
      clearDeletedTranscript(lessons);
      update(`Transcripciones eliminadas del curso: ${count}.`);
    });
    let module;
    let list;
    for (const lesson of lessons) {
      if (module !== lesson.module) {
        module = lesson.module;
        add(savedList, "h3", lesson.moduleTitle);
        list = add(savedList, "ul");
      }
      const row = add(list, "li");
      add(row, "p", lesson.title);
      const remove = addDeleteControls(row, "Eliminar", "Confirmar eliminación", async () => {
        await request("delete-lesson", { target: lesson.key, id: lesson.jobId });
        clearDeletedTranscript([lesson]);
        update("Transcripción eliminada del curso.");
      });
      remove.setAttribute("aria-label", `Eliminar ${lesson.title}`);
    }
  }

  function clearDeletedTranscript(lessons) {
    if (!review?.saved || !lessons.some(lesson => lesson.key === context.key && lesson.jobId === review.id)) return;
    segments = review = undefined;
    output.value = "";
    output.hidden = exports.hidden = true;
    displayReview();
  }

  function addDeleteControls(row, label, confirmLabel, deleteTranscripts) {
      const remove = add(row, "button", label);
      remove.addEventListener("click", () => {
        remove.hidden = true;
        confirm.hidden = cancel.hidden = false;
        cancel.focus();
      });
      const confirm = add(row, "button", confirmLabel);
      const cancel = add(row, "button", "Cancelar");
      confirm.hidden = cancel.hidden = true;
      cancel.addEventListener("click", () => {
        confirm.hidden = cancel.hidden = true;
        remove.hidden = false;
        remove.focus();
      });
      confirm.addEventListener("click", async () => {
        confirm.disabled = cancel.disabled = true;
        try {
          await deleteTranscripts();
          await refreshSavedLessons();
          savedLessons.querySelector("summary").focus();
        } catch (error) {
          update(error.message);
          confirm.disabled = cancel.disabled = false;
        }
      });
      return remove;
  }

  savedLessons.addEventListener("toggle", () => {
    if (savedLessons.open) void refreshSavedLessons().catch(error => update(error.message));
  });

  function showCount(count) {
    courseStatus.textContent = count === 1 ? "1 lección guardada en este curso"
      : `${count} lecciones guardadas en este curso`;
    courseMd.disabled = coursePdf.disabled = courseWord.disabled = count === 0;
  }
  showCount(context.count);

  function showPanel(open) {
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      (start.disabled ? close : start).focus();
      void request("count").then(showCount).catch(() => {});
      if (savedLessons.open) void refreshSavedLessons().catch(error => update(error.message));
      if (!moduleName.value) void request("titles").then(applyTitles).catch(() => {});
    }
    else trigger.focus();
  }

  function mount() {
    const time = document.querySelector(".plyr__controls .plyr__time--current")
      || document.querySelector(".plyr__controls .plyr__time--duration, .plyr__controls .plyr__time");
    const fallback = document.fullscreenElement instanceof HTMLVideoElement
      ? document.body : document.fullscreenElement || document.body;
    if (time) {
      if (time.nextElementSibling !== triggerHost) time.after(triggerHost);
    } else if (triggerHost.parentElement !== fallback) {
      fallback.append(triggerHost);
    }
    triggerHost.toggleAttribute("floating", !time);
    if (panelHost.parentElement !== fallback) fallback.append(panelHost);
  }

  let mountPending = false;
  const observer = new MutationObserver(() => {
    if (mountPending) return;
    mountPending = true;
    requestAnimationFrame(() => {
      mountPending = false;
      mount();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("fullscreenchange", mount);
  mount();

  for (const root of [triggerRoot, panelRoot]) {
    for (const event of ["click", "pointerdown", "keydown"]) {
      root.addEventListener(event, ev => ev.stopPropagation());
    }
  }
  trigger.addEventListener("click", () => showPanel(panel.hidden));
  close.addEventListener("click", () => showPanel(false));
  panelRoot.addEventListener("keydown", event => {
    if (event.key === "Escape") showPanel(false);
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message.type === "open-panel") showPanel(true);
  });

  function update(text, percent) {
    status.textContent = text;
    progress.hidden = percent === undefined;
    if (percent === null) progress.removeAttribute("value");
    else if (percent !== undefined) progress.value = percent;
  }

  async function audioFrom(mode) {
    const extractor = createAudioExtractor();
    try {
      const track = await readTrack(mode, (sample, count, total) => {
        extractor.append(sample);
        update(`Leyendo audio de la lección · ${count}/${total} segmentos`, count / total * 100);
      });
      const blob = track && extractor.finish();
      return blob ? { blob, seconds: track.seconds } : null;
    } finally {
      extractor.dispose();
    }
  }

  function stamp(seconds) {
    return [Math.floor(seconds / 60), Math.floor(seconds % 60)]
      .map(value => String(value).padStart(2, "0")).join(":");
  }

  function applyTitles(titles) {
    if (!moduleName.value && titles.moduleTitle) moduleName.value = titles.moduleTitle;
    if (titles.courseTitle) context.courseTitle = titles.courseTitle;
  }

  function displaySegments(rows) {
    segments = rows;
    output.value = rows.map(row => `[${stamp(row.start)}] ${row.text}`).join("\n");
    output.hidden = exports.hidden = false;
  }

  function displayReview() {
    reviewArea.hidden = !review;
    if (!review) return;
    const gaps = review.gaps;
    const needsReview = Boolean(gaps?.length && !review.reviewed);
    word.disabled = start.disabled || !review.saved || !Array.isArray(gaps) || needsReview;
    confirmReview.hidden = !needsReview || !review.saved;
    confirmReview.disabled = start.disabled;
    gapList.replaceChildren();
    if (!Array.isArray(gaps)) {
      reviewStatus.textContent = "Vuelve a transcribir esta lección para comprobar sus intervalos antes de exportar Word.";
    } else if (needsReview) {
      reviewStatus.textContent = "Hay intervalos de 12 s o más sin texto. Escúchalos y confirma solo si no falta voz.";
      for (const gap of gaps) {
        const seek = add(gapList, "button", `${stamp(gap.start)} a ${stamp(gap.end)}`);
        seek.addEventListener("click", () => {
          const video = document.querySelector("video");
          if (!video || video.readyState === 0) {
            update("Reproduce el video unos segundos para poder saltar a este intervalo.");
            return;
          }
          video.currentTime = gap.start;
          void video.play().catch(() => update("Pulsa reproducir para escuchar este intervalo."));
        });
      }
    } else {
      reviewStatus.textContent = gaps.length ? "Revisión de intervalos confirmada."
        : "Sin intervalos de 12 s o más detectados.";
    }
  }

  let segments;
  let review;
  if (context.current) {
    displaySegments(context.current);
    review = { id: context.jobId, gaps: context.gaps, reviewed: context.reviewed, saved: true };
    displayReview();
    update("Transcripción guardada en este curso.");
  }

  async function watchJob(id) {
    for (;;) {
      const job = await request("status", { id });
      if (job.state === "failed") throw new Error(job.error);
      if (job.state === "done") {
        displaySegments(job.segments);
        review = { id, gaps: job.gaps, reviewed: job.reviewed, saved: job.saved };
        displayReview();
        if (job.saved) {
          if (savedLessons.open) await refreshSavedLessons();
          else showCount(await request("count"));
        }
        update(job.saved ? "Transcripción guardada en este curso."
          : "Transcripción lista. No se pudo guardar en el curso. Puedes descargarla por separado.");
        return;
      }
      if (job.state === "decoding") update("Preparando el audio para Whisper…", null);
      else if (job.percent > 0) update(`Transcribiendo con Whisper · ${job.percent} % aprox.`, job.percent);
      else update("Whisper está escuchando y convirtiendo el audio en texto…", null);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  async function run(pending) {
    start.disabled = true;
    lessonTitle.disabled = true;
    displayReview();
    trigger.textContent = "Procesando…";
    try {
      if (pending) {
        await watchJob(pending);
        return;
      }
      update("Comprobando Whisper local…", null);
      await request("health");
      const titles = await request("titles");
      if (!segments && lessonTitle.value === context.title && titles.title) lessonTitle.value = titles.title;
      applyTitles(titles);
      update("Buscando la pista de audio…", null);
      const track = await audioFrom("video") ?? await audioFrom("audio");
      if (!track) throw new Error("El reproductor no proporcionó una pista de audio compatible.");
      if (track.blob.size > 32_000_000) throw new Error("La pista de audio supera el tamaño admitido.");
      update("Enviando el audio a Whisper en esta PC…", null);
      const audio = new Uint8Array(await track.blob.arrayBuffer()).toBase64();
      const { id } = await request("start", {
        seconds: track.seconds, audio, title: lessonTitle.value, courseTitle: context.courseTitle
      });
      await watchJob(id);
    } catch (error) {
      update(error.message);
    } finally {
      start.disabled = false;
      lessonTitle.disabled = false;
      displayReview();
      trigger.textContent = "Transcribir";
    }
  }
  start.addEventListener("click", () => void run());
  if (context.pending) void run(context.pending);

  let titleUpdate = Promise.resolve();
  moduleName.addEventListener("change", () => {
    const title = moduleName.value.trim();
    if (!title) return;
    titleUpdate = titleUpdate.then(() => request("rename-module", { title }))
      .catch(error => update(error.message));
  });
  lessonTitle.addEventListener("change", () => {
    if (!lessonTitle.value.trim()) lessonTitle.value = context.title;
    const title = lessonTitle.value;
    if (segments) {
      titleUpdate = titleUpdate.then(() => request("rename", { title }))
        .catch(error => update(error.message));
    }
  });

  confirmReview.addEventListener("click", async () => {
    confirmReview.disabled = true;
    try {
      await request("review", { id: review.id });
      review.reviewed = true;
      update("Revisión guardada. Ya puedes descargar Word.");
    } catch (error) {
      update(error.message);
    } finally {
      displayReview();
    }
  });

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(output.value);
      update("Texto copiado.");
    } catch {
      output.select();
      update(document.execCommand("copy") ? "Texto copiado." : "Texto seleccionado. Pulsa Ctrl+C para copiarlo.");
    }
  });
  for (const [button, format, combined] of [[md, "md", false], [pdf, "pdf", false], [word, "docx", false],
    [courseMd, "md", true], [coursePdf, "pdf", true], [courseWord, "docx", true]]) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await titleUpdate;
        const count = await request("download", combined ? { format, combined, courseTitle: context.courseTitle }
          : { format, title: lessonTitle.value, segments, id: review?.id });
        if (combined) showCount(count);
        update(combined ? `Descarga del curso iniciada · ${count} ${count === 1 ? "lección" : "lecciones"}`
          : "Descarga de la lección iniciada.");
      } catch (error) {
        update(error.message);
      } finally {
        button.disabled = false;
        if (button === word) displayReview();
      }
    });
  }
})();

const trustedArchive = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

function lessonInfo(url) {
  const path = URL.parse(url)?.pathname;
  const match = path?.match(/^\/course\/([\w-]+)\/module\/([\w-]+)\/lesson\/([\w-]+)\/?$/);
  if (!match) return null;
  const [, course, module, lesson] = match;
  const prefix = `lesson/${course}/`;
  return { prefix, key: `${prefix}${module}/${lesson}`, course, module, lesson };
}

async function courseItems(storage, prefix) {
  if (storage === chrome.storage.local) await trustedArchive;
  const keys = (await storage.getKeys()).filter(key => key.startsWith(prefix));
  return Object.values(await storage.get(keys));
}

async function courseArchive(info) {
  const lessons = await courseItems(chrome.storage.local, info.prefix);
  const modules = await chrome.storage.local.get([...new Set(lessons.map(lesson => moduleKey(info, lesson.module)))]);
  for (const lesson of lessons) lesson.moduleTitle = modules[moduleKey(info, lesson.module)] || `Módulo ${lesson.module}`;
  const compare = (a, b) => a.localeCompare(b, "es", { numeric: true });
  return lessons.sort((a, b) => compare(a.module, b.module) || compare(a.lesson, b.lesson));
}

function moduleKey(info, module = info.module) {
  return `module/${info.course}/${module}`;
}

function wordBlocker(lesson) {
  if (!Array.isArray(lesson?.gaps)) return "Vuelve a transcribir para comprobar sus intervalos.";
  if (lesson.gaps.length && !lesson.reviewed) return "Revisa los intervalos marcados.";
  return "";
}

function timestamp(seconds) {
  return [Math.floor(seconds / 60), Math.floor(seconds % 60)]
    .map(value => String(value).padStart(2, "0")).join(":");
}

function markdownText(text) {
  return text.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}\[\]<>#~|]/g, "\\$&");
}

function transcriptMarkdown(title, lessons, combined) {
  const lines = [`# ${markdownText(title)}`, ""];
  let module;
  for (const lesson of lessons) {
    if (combined) {
      if (lesson.module !== module) {
        lines.push(`## ${markdownText(lesson.moduleTitle)}`, "");
        module = lesson.module;
      }
      lines.push(`### ${markdownText(lesson.title)}`, "");
    }
    for (const row of lesson.segments) {
      lines.push(`- **${timestamp(row.start)}** ${markdownText(row.text)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

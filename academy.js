function readLessonTitles() {
  const path = location.pathname.replace(/\/$/, "");
  const coursePath = path.split("/").slice(0, 3).join("/");
  const text = node => node?.textContent?.trim().replace(/\s+/g, " ").slice(0, 160) || "";
  const links = [...document.querySelectorAll("a[href]")];
  const linkTitle = target => text(links.find(link => {
    const url = URL.parse(link.href);
    return url?.origin === location.origin && url.pathname.replace(/\/$/, "") === target && text(link);
  }));
  const heading = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")]
    .find(node => !node.closest("aside, nav, header, footer")
      && node.getClientRects().length && text(node)
      && !/^(contenido|descripción|transcript)$/i.test(text(node)));
  const descriptionTitle = document.querySelector(".content .v-window-item--active h2.title-main")
    || document.querySelector(".content .v-window-item h2.title-main");
  const lessonTitle = text(descriptionTitle) || linkTitle(path) || text(heading);
  const moduleGroups = [...document.querySelectorAll(
    "li.sidebar-dropdown > .module_title, [data-module-title], .v-expansion-panel-title, .v-list-group__header, details > summary"
  )].map(header => ({
    header,
    group: header.closest("li.sidebar-dropdown, [data-course-module], .v-expansion-panel, .v-list-group, details"),
    title: text(header.matches(".module_title") ? header.querySelector(":scope > div.mt-1") || header : header)
  })).filter(({ group, title }) => group && title);
  const belongsToLesson = link => {
    const url = URL.parse(link.href);
    return url?.origin === location.origin && url.pathname.replace(/\/$/, "") === path;
  };
  const linkedModule = moduleGroups.find(({ group }) => [...group.querySelectorAll("a[href]")].some(belongsToLesson));
  const namedModules = lessonTitle ? new Set(moduleGroups.filter(({ group, header }) =>
    [...group.querySelectorAll("*")].some(node => !header.contains(node)
      && !node.children.length && text(node) === lessonTitle)).map(({ title }) => title)) : new Set();
  const moduleTitle = linkedModule?.title
    || (namedModules.size === 1 ? namedModules.values().next().value : "")
    || inferModuleTitle(links, belongsToLesson, lessonTitle, text);
  const tabTitle = document.title.trim();
  const namedCourse = linkTitle(coursePath) || document.querySelector("[data-course-title]")?.textContent?.trim();
  const courseTitle = namedCourse || (tabTitle !== lessonTitle
    && !/^(https?:\/\/|academia\.comerdata\.com\/|comerdata$)/i.test(tabTitle) ? tabTitle : "");
  return { lessonTitle, courseTitle, moduleTitle };
}

function inferModuleTitle(links, belongsToLesson, lessonTitle, text) {
  const headingSelector = "button, [role=button], span, p, div, h2, h3, h4";
  const lessonNodes = links.filter(belongsToLesson);
  if (!lessonNodes.length && lessonTitle) {
    lessonNodes.push(...[...document.querySelectorAll("span, a, button, div, p")].filter(node =>
      !node.children.length && !node.closest(".content .v-window-item")
      && node.getClientRects().length && text(node) === lessonTitle));
  }
  const candidates = new Set();
  for (const lesson of lessonNodes) {
    for (let parent = lesson.parentElement, depth = 0; parent && depth < 6; parent = parent.parentElement, depth++) {
      const names = new Set([...parent.querySelectorAll(headingSelector)]
        .filter(node => !node.children.length || node.matches("button, [role=button], h2, h3, h4"))
        .map(text).filter(title => title !== lessonTitle && /^\d+\.\s+\S/.test(title)));
      if (names.size === 1) candidates.add(names.values().next().value);
      if (names.size) break;
    }
  }
  return candidates.size === 1 ? candidates.values().next().value : "";
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.type !== "lesson-titles") return;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => reply(readLessonTitles()), { once: true });
    return true;
  }
  reply(readLessonTitles());
});

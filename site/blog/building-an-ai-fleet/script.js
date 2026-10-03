const progress = document.querySelector("#progress");
let pending = false;
function updateProgress() {
  const d = document.documentElement;
  progress.style.width = `${(100 * d.scrollTop) / Math.max(1, d.scrollHeight - d.clientHeight)}%`;
  pending = false;
}
addEventListener(
  "scroll",
  () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(updateProgress);
    }
  },
  { passive: true },
);
updateProgress();
addEventListener("resize", updateProgress);
addEventListener("load", updateProgress);
document
  .querySelectorAll("details")
  .forEach((d) => d.addEventListener("toggle", updateProgress));
const links = [...document.querySelectorAll(".contents a")];
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        links.forEach((a) => {
          const active = a.hash === "#" + entry.target.id;
          a.classList.toggle("active", active);
          if (active) a.setAttribute("aria-current", "location");
          else a.removeAttribute("aria-current");
        });
      }
    }
  },
  { rootMargin: "-10% 0px -65% 0px", threshold: 0 },
);
document.querySelectorAll(".chapter").forEach((s) => observer.observe(s));
const captureTabs = [...document.querySelectorAll(".capture-tab")],
  capturePanels = [...document.querySelectorAll(".capture-panel")];
let captureIndex = 0;
function showCapture(index, focus = false) {
  captureIndex = (index + captureTabs.length) % captureTabs.length;
  captureTabs.forEach((tab, i) => {
    tab.setAttribute("aria-selected", String(i === captureIndex));
    tab.tabIndex = i === captureIndex ? 0 : -1;
    capturePanels[i].hidden = i !== captureIndex;
  });
  document.querySelector("#capture-count").textContent =
    `${captureIndex + 1} / ${captureTabs.length}`;
  const selected = captureTabs[captureIndex];
  const nav = selected.parentElement;
  nav.scrollLeft = Math.max(
    0,
    selected.getBoundingClientRect().left -
      nav.getBoundingClientRect().left +
      nav.scrollLeft -
      (nav.clientWidth - selected.clientWidth) / 2,
  );
  if (focus) selected.focus({ preventScroll: true });
}
captureTabs.forEach((tab, i) => {
  tab.addEventListener("click", () => showCapture(i));
  tab.addEventListener("keydown", (e) => {
    let n;
    if (["ArrowRight", "ArrowDown"].includes(e.key)) n = i + 1;
    else if (["ArrowLeft", "ArrowUp"].includes(e.key)) n = i - 1;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = captureTabs.length - 1;
    else return;
    e.preventDefault();
    showCapture(n, true);
  });
});
document
  .querySelector("#capture-prev")
  .addEventListener("click", () => showCapture(captureIndex - 1));
document
  .querySelector("#capture-next")
  .addEventListener("click", () => showCapture(captureIndex + 1));
document.querySelector("#capture-expand").addEventListener("click", (event) => {
  event.currentTarget.focus({ preventScroll: true });
  capturePanels[captureIndex].querySelector("[data-image]").click();
});
const captureMobile = matchMedia("(max-width:650px)");
function orientCaptures() {
  document
    .querySelector(".capture-nav")
    .setAttribute(
      "aria-orientation",
      captureMobile.matches ? "horizontal" : "vertical",
    );
}
orientCaptures();
captureMobile.addEventListener("change", orientCaptures);

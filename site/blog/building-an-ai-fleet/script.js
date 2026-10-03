const stages = [
  [
    "PLANNER + DESIGNER",
    "Turn intent into a reviewable plan.",
    "The planner investigates the repository and proposes the approach. Approval stays with the designer unless both global and per-item settings delegate an eligible plan. Epic breakdowns and other protected decisions stay with the user.",
    "An approved plan",
  ],
  [
    "ISOLATED WORKER",
    "Implement inside a dedicated worktree.",
    "The worker changes files on its own branch, runs the full check suite, commits, and reports completion. A blocked worker reports the problem rather than improvising around the process.",
    "A checked commit and completion report",
  ],
  [
    "PLANESTRO ENGINE",
    "Let application code own integration.",
    "Planestro pushes, opens the PR, waits for CI, rebases when the target moves, and merges after the required gates. Epic children target the feature branch before the epic reaches develop.",
    "A verified merge",
  ],
  [
    "DESIGNER",
    "Play the result. Change the requirements.",
    "I test the build on my phone and decide what feels wrong. Reproducible findings become backlog items, checks, or standing rules for the next pass through the pipeline.",
    "New evidence and better requirements",
  ],
];
const tabs = [...document.querySelectorAll("[data-stage]")],
  panel = document.querySelector("#stage-panel");
function selectStage(i) {
  tabs.forEach((t, n) => {
    t.setAttribute("aria-selected", n === i);
    t.tabIndex = n === i ? 0 : -1;
  });
  const s = stages[i];
  panel.setAttribute("aria-labelledby", `tab-${i}`);
  panel.innerHTML = `<span class="owner">${s[0]}</span><h3>${s[1]}</h3><p>${s[2]}</p><div class="handoff">OUTPUT <strong>${s[3]}</strong></div>`;
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => selectStage(i));
  t.addEventListener("keydown", (e) => {
    let n;
    if (e.key === "ArrowRight") n = (i + 1) % 4;
    else if (e.key === "ArrowLeft") n = (i + 3) % 4;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = 3;
    else return;
    e.preventDefault();
    selectStage(n);
    tabs[n].focus();
  });
});
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
    selected.offsetLeft -
      nav.offsetLeft -
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

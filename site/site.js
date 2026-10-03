// Page content and navigation work without JavaScript. Enhance only present controls.
const copyStatus = document.querySelector("#copy-status");
if (navigator.clipboard?.writeText) {
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.hidden = false;
    button.addEventListener("click", async () => {
      const code = document.getElementById(button.dataset.copy);
      try {
        await navigator.clipboard.writeText(code.textContent);
        button.textContent = "Copied";
        if (copyStatus)
          copyStatus.textContent = "Commands copied to clipboard.";
      } catch {
        button.textContent = "Select to copy";
        if (copyStatus)
          copyStatus.textContent =
            "Clipboard unavailable. Select the commands and copy them manually.";
      }
      setTimeout(() => {
        button.textContent = "Copy";
      }, 2500);
    });
  });
}

const imageDialog = document.querySelector("#image-dialog");
if (imageDialog) {
  const dialogImage = document.querySelector("#dialog-image");
  const dialogCaption = document.querySelector("#dialog-caption");
  let returnFocus;
  document.querySelectorAll("[data-image]").forEach((button) => {
    button.addEventListener("click", () => {
      // The carousel's expand button forwards a click; return to that actual control.
      returnFocus =
        document.activeElement?.id === "capture-expand"
          ? document.activeElement
          : button;
      dialogImage.src = button.dataset.image;
      dialogImage.alt = button.querySelector("img").alt;
      dialogCaption.textContent = button.dataset.caption;
      imageDialog.showModal();
      imageDialog.scrollTop = 0;
    });
  });
  imageDialog
    .querySelector(".dialog-close")
    .addEventListener("click", () => imageDialog.close());
  imageDialog.addEventListener("click", (event) => {
    if (event.target !== imageDialog) return;
    const rect = imageDialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      imageDialog.close();
  });
  imageDialog.addEventListener("close", () =>
    returnFocus?.focus({ preventScroll: true }),
  );
}

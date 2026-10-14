// Mobile menu toggle shared by every page.
const toggle = document.querySelector(".menu-toggle");
const nav = document.querySelector(".top nav");
toggle.addEventListener("click", () => {
  const open = nav.classList.toggle("open");
  toggle.setAttribute("aria-expanded", String(open));
  toggle.textContent = open ? "✕" : "☰";
});

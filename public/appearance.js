try {
  const theme = localStorage.getItem("rarrcord:theme");
  if (theme) document.documentElement.dataset.theme = theme;
} catch {
  // The default theme also works when browser storage is unavailable.
}

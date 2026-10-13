// Settings for the TV menu. After changing anything in this folder, also raise
// the number in version.txt by one. The TVs then update themselves within 5 minutes.
window.MENU_CONFIG = {
  // The Google Sheet that holds the menu (the long ID from the sheet's web address).
  sheetId: "187Yh0EX7Rsu8uiDljWJDtXry169OW6uFOo6Y2TiL3ns",

  // How often each TV checks the sheet for changes, in seconds.
  refreshSeconds: 60,

  // Starting text size, as a number of pages. 1 shows everything at once.
  // 2 or more makes the text bigger and rotates through the pages.
  // Each TV remembers its own choice once you change it with the on-screen buttons.
  pages: 1,

  // How long each page stays up when there is more than one, in seconds.
  pageSeconds: 12,

  storeName: "Halal 4 All",
  website: "halal4allshop.com",
  phone: "(571) 758-3534",
  note: "Prices are per lb unless marked. MP = market price."
};

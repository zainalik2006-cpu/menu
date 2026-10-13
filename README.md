# Halal 4 All TV menu

Two TV pages that read their items and prices from a Google Sheet.

- `/1/` is Screen 1: beef, veal, lamb, goat, steaks
- `/2/` is Screen 2: chicken, marinated, deli
- `/` is a page with two big buttons, one per screen

## One-time setup

1. **Share the sheet.** Open the "Halal 4 All TV Menu" sheet, click Share, and under
   General access pick "Anyone with the link" as Viewer. The TVs can only read it;
   only people you add as editors can change prices.
2. **Put this folder on GitHub Pages.** Create a public repository (for example `menu`),
   upload everything in this folder, then go to Settings > Pages and deploy from the
   `main` branch, root folder.
3. **Open it on each Firestick.** In the Silk browser go to
   `YOUR-USERNAME.github.io/menu/1` on one TV and `/2` on the other, then bookmark it.
   Press the remote's select button once on the page to go full screen.

## Changing the menu

Edit the sheet. Each TV checks it once a minute.

| Column  | What to type |
|---------|--------------|
| Screen  | 1 or 2 |
| Column  | 1 to 4, left to right |
| Section | The red heading the item sits under |
| Item    | The name shown on the TV |
| Price   | Numbers only, like 6.49. Leave empty for market price |
| Tag     | MP for market price, EA or BOX for "each" or "per box", otherwise empty |
| Show    | No hides the item. Yes or empty shows it |

Rows appear on the TV in the same order as the sheet. To add an item, insert a row.
Keep the columns in this order and keep the menu on the first tab.

Text shrinks on its own if a column gets longer, so nothing runs off the screen.

## The dot next to the clock

Green: prices are live from the sheet. Amber: the TV has not reached the sheet for
five minutes and is showing the last prices it saw.

## Other settings

`config.js` holds the sheet ID, phone number, website, the note in the top bar, and
how often the TVs refresh.

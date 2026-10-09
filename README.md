# mfk.github.io

Personal site. `index.html` is just structure — all content lives in `data/` as JSON, and `js/main.js` renders it. To update the site, edit the JSON, you shouldn't need to touch the HTML.

- `data/profile.json` — name, photo, bio paragraphs, quote, social links, hero background images, footer "updated" date
- `data/education.json` — one object per school
- `data/publications.json` — one object per paper (title, venue, authors, image, paper/code/website links)
- `data/news.json` — one object per news item (date + HTML snippet)

To add a publication or news item, copy an existing object in the array and edit it.

`js/car.js` is the little car that follows the cursor and path-plans around text and images (desktop only). Its tunables (speeds, clearance, colours) are constants at the top of the file.

## Local preview

Browsers block `fetch()` on `file://` URLs, so opening `index.html` directly will show a load error. Serve it instead:

```
python3 -m http.server 8000
```

then open `http://localhost:8000`.

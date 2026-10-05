// Renders the page from the JSON files in /data. Edit those files to add
// publications, news, or education entries — this script never needs to change.

async function loadJSON(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    return res.json();
}

function el(tag, opts = {}) {
    const node = document.createElement(tag);
    if (opts.className) node.className = opts.className;
    if (opts.html !== undefined) node.innerHTML = opts.html;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
    return node;
}

function renderHero(profile) {
    const imgs = profile.heroImages || [];
    if (!imgs.length) return;

    const a = document.getElementById('hero-a');
    const b = document.getElementById('hero-b');
    const FADE = 3000;

    let idx = Math.floor(Math.random() * imgs.length);
    a.src = imgs[idx];

    setInterval(() => {
        let next;
        do { next = Math.floor(Math.random() * imgs.length); } while (next === idx && imgs.length > 1);
        idx = next;
        b.src = imgs[idx];
        b.style.opacity = '1';
        setTimeout(() => {
            a.src = imgs[idx];
            b.style.opacity = '0';
        }, FADE);
    }, 6000);

    const hero = a.closest('.bg-image');
    window.addEventListener('scroll', () => {
        const y = window.scrollY * 0.5;
        const blur = Math.min(12, window.scrollY / hero.offsetHeight * 4);
        a.style.transform = `translateY(${y}px)`;
        b.style.transform = `translateY(${y}px)`;
        a.style.filter = `blur(${blur}px)`;
        b.style.filter = `blur(${blur}px)`;
    }, { passive: true });
}

function renderQuote(profile) {
    if (!profile.quote) return;
    document.getElementById('quote-text').textContent = `"${profile.quote.text}"`;
    document.getElementById('quote-author').textContent = `— ${profile.quote.author}`;
}

function renderAbout(profile) {
    const pic = document.getElementById('profile-pic');
    pic.src = profile.photo;
    pic.alt = profile.name;

    const links = document.getElementById('social-links');
    for (const s of profile.socials || []) {
        const a = el('a', { className: 'icon-link', attrs: { href: s.url, 'aria-label': s.label } });
        if (s.url.startsWith('http')) {
            a.target = '_blank';
            a.rel = 'noreferrer';
        }
        a.appendChild(el('i', { className: s.icon }));
        links.appendChild(a);
    }

    const bio = document.getElementById('bio-text');
    for (const paragraph of profile.bio || []) {
        bio.appendChild(el('p', { html: paragraph }));
    }
}

function renderEducation(education) {
    const list = document.getElementById('education-list');
    for (const item of education) {
        const li = el('li', { className: 'edu-item' });

        const main = el('div');
        main.appendChild(document.createTextNode(item.institution));
        main.appendChild(el('div', { className: 'edu-degree', text: item.degree }));
        li.appendChild(main);

        li.appendChild(el('div', { className: 'edu-years', text: item.years }));
        list.appendChild(li);
    }
}

function authorHTML(author) {
    const name = author.me ? `<b>${author.name}</b>` : author.name;
    return author.star ? `${name}<sup>&#x2605</sup>` : name;
}

function renderPublications(publications) {
    const container = document.getElementById('publications-list');
    for (const pub of publications) {
        const row = el('div', { className: 'row pub-row' });

        const imgCol = el('div', { className: 'col-md-3 text-center' });
        imgCol.appendChild(el('img', {
            className: 'img-fluid rounded',
            attrs: { src: pub.image, alt: pub.title, width: pub.imageWidth || '80%' }
        }));
        row.appendChild(imgCol);

        const textCol = el('div', { className: 'col-md-9' });
        textCol.appendChild(el('span', { className: 'badge badge-dark rounded-pill', text: pub.date }));
        textCol.appendChild(document.createTextNode(' '));
        textCol.appendChild(el('u', { text: pub.title }));
        textCol.appendChild(document.createTextNode(' '));
        textCol.appendChild(el('b', { text: `(${pub.venue})` }));

        const authors = pub.authors.map(authorHTML).join(', ');
        textCol.appendChild(el('div', { className: 'mt-1', html: `<i>${authors}</i>` }));

        const linkRow = el('div', { className: 'pub-links' });
        const entries = Object.entries(pub.links || {});
        entries.forEach(([label, url], i) => {
            if (i > 0) linkRow.appendChild(el('span', { className: 'pub-link-sep', text: '·' }));
            linkRow.appendChild(el('a', {
                className: 'pub-link',
                text: label.charAt(0).toUpperCase() + label.slice(1),
                attrs: { href: url, target: '_blank', rel: 'noreferrer' }
            }));
        });
        textCol.appendChild(linkRow);

        row.appendChild(textCol);
        container.appendChild(row);
    }
}

function renderNews(news) {
    const list = document.getElementById('news-list');
    for (const item of news) {
        const li = el('li');
        li.appendChild(el('span', { className: 'badge badge-success rounded-pill', text: item.date }));
        li.appendChild(document.createTextNode(' '));
        li.appendChild(el('span', { html: item.html }));
        list.appendChild(li);
    }
}

function renderFooter(profile) {
    document.getElementById('last-updated').textContent = `Updated ${profile.lastUpdated}`;
}

async function init() {
    const [profile, education, publications, news] = await Promise.all([
        loadJSON('data/profile.json'),
        loadJSON('data/education.json'),
        loadJSON('data/publications.json'),
        loadJSON('data/news.json'),
    ]);

    renderHero(profile);
    renderQuote(profile);
    renderAbout(profile);
    renderEducation(education);
    renderPublications(publications);
    renderNews(news);
    renderFooter(profile);

    document.querySelector('.site-content').classList.add('loaded');
}

init().catch(err => {
    console.error('Failed to render page:', err);
    const content = document.querySelector('.site-content');
    content.innerHTML = `<p style="font-family: sans-serif; color: #a33;">
        Could not load page content from /data. If you're viewing this file locally,
        serve it over HTTP instead of opening it directly
        (e.g. <code>python3 -m http.server</code>), since browsers block
        fetch() on file:// URLs.
    </p>`;
    content.classList.add('loaded');
});

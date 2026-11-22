# New design

Mockups of the redesigned blog, rendered with the posts in `fixture-posts.json`. Fonts are in `fonts/`.

The layout changes at five breakpoints. Each range has its own mockup:

| Range | Mockup |
|---|---|
| under 400px | `*.360px.png` |
| 400–767px | `*.600px.png` |
| 768–992px | `*.834px.png` |
| 993–1199px | `*.1100px.png` |
| 1200–1399px | `*.1300px.png` |
| 1400px and up | `*.1600px.png` |

Between breakpoints, the three widest ranges keep the column widths shown in their mockup and centre the page. In the three narrowest ranges, the post's text column fills the space between the side gutters, up to 640px.

- `home.*` and `post.*`: full pages, light and dark.
- `state.post-scrolled.*`: the post page scrolled to "The hand-off format".
- `state.contents-open.*`: the post's contents box opened.
- `state.search-open.*`: search opened with ⌘K, after typing "agent".
- `state.menu-open.*`: the menu open.

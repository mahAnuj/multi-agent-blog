# Importing the old posts

My notes for moving every post I published elsewhere into this blog: the
decisions only. How each export is laid out is in the files themselves.

## What is here

- `mdx/`: posts already in this blog's format, with images under `public/blog/<slug>/`.
- `wordpress/`: a WXR export of the old WordPress site, plus its `uploads/`.
- `ghost/`: a Ghost JSON export, plus its `content/images/`.
- `medium/`: Medium's posts export (`posts/`, `images/`), plus `tags.csv` and
  `updated.csv`, which I added because Medium's export has neither.

## The post model

Every imported post has:

| Field | Meaning |
| --- | --- |
| `slug` | lowercase letters, digits and hyphens |
| `title` | plain text |
| `description` | the excerpt (on Medium, the subtitle) |
| `publishedAt` | `YYYY-MM-DD` |
| `updatedAt` | `YYYY-MM-DD`, only when later than `publishedAt` |
| `tags` | lowercase strings |
| `series` | optional `{ id, part }`, where `part` is an integer or `"overview"` |
| `body` | GitHub-flavoured Markdown plus the components below |

The slug is the platform's own slug. On Medium it is the canonical URL's last
segment without the trailing `-<id>`. MDX files are named by slug.

## Body

Plain Markdown: paragraphs, `##`/`###` headings, lists, links, bold, italic,
inline code, `---` rules. The title is never repeated in the body. Quotes and
pull quotes are `>` blockquotes. Tables are GFM pipe tables with a header
row. Raw HTML is never kept.

**Code** is a fenced block with its language, plus a title when the source
gives the block a title or caption:

````
```ts title="src/lib/openai.ts (before)"
…
```
````

A block with no language gets a bare fence.

**Footnotes**: `[^1]` at the reference, definitions at the end of the body,
numbered in order of first reference.

Components are written exactly as the MDX posts write them, each on its own
lines with a blank line around it:

```mdx
<Callout type="warning" title="Optional title">
Markdown content.
</Callout>
```

`type` is `insight`, `warning` or `note`; leave `title` out when there is none.

```mdx
<Figure caption="Caption text.">
  <a href="/blog/<slug>/<file>">
  <img
    src="/blog/<slug>/<file>"
    alt="Alt text."
    width="1600"
    height="900"
    loading="lazy"
  />
  </a>
</Figure>
```

`width`/`height` only when the source states the size of the file actually
used; `loading="lazy"` always.

```mdx
<MetricRow>
  <Metric label="Declared interval" value="30" unit="min" />
  <Metric label="Fastest actual gap" value="126" unit="min" featured />
</MetricRow>
```

`unit` and `featured` are optional.

```mdx
<ArchDiagram
  title="Title"
  stages={[
    { name: "Stage", detail: "What happens", meta: "Note", emphasis: true },
  ]}
  caption="Caption."
/>
```

Stages have `name`, `detail`, `meta` and optional `emphasis: true`, one per line.

## Conventions I used on the old platforms

What my own markup meant:

- WordPress callout groups: `callout-tip` means insight, `callout-warn` means
  warning, `callout-note` means note. A heading at the top of a callout is its
  title.
- Ghost callouts: 💡 means insight, ⚠️ means warning, 📝 means note. A bold
  first line is the title.
- Medium: a quote opening with bold `Insight:`/`Warning:`/`Note:` is that callout (label dropped).
- WordPress custom blocks and Ghost HTML cards for diagrams/metrics hold the props as JSON.
- Medium tables are pasted Markdown in a code block marked as a table: real tables.
- Medium code languages are in a comment before each block; none means `text`.
- Hand-written numbered notes at the end of Ghost and Medium posts are footnotes.
- WordPress series membership is in post meta: `series_id` and `series_part`.

## Images

Every image a post uses is copied into the blog and served locally at
`/blog/<slug>/<file>`. Nothing may load from WordPress, Ghost or Medium
after the import. When WordPress points at a resized copy of an image, use
the original file instead. Medium images keep their image id as the file name.

## Links and look

- Links to my own posts, in any old style (`/blog/<slug>`, WordPress
  permalinks, Ghost URLs, Medium URLs), become `/post/<slug>`. Any `#fragment`
  is kept.
- Links to pages of this site written as `https://anujmahajan.com/<path>`
  become `/<path>`.
- All other links stay as they are.
- Old platform styling (inline styles, theme classes, colours, highlights,
  alignment, image styles) never comes across: imported posts look like every
  other post.

## Dates

Dates are the site's local calendar date. The timezone, Asia/Kolkata, is in
the WordPress export. Convert UTC timestamps to it before taking the date.
WordPress's own local date is the one shown, even when its GMT date falls on a
different day. `updatedAt` comes from the platform's last-modified time; for
Medium it comes from `updated.csv`.

## Tags and series

- Tags are lowercase, spaces become hyphens, duplicates go, order is kept.
  WordPress categories are not tags.
- On Ghost, tags starting with `#` are internal and are not tags.
  `#series-<id>` gives the series id and `#part-<n>` gives the part
  (`#part-overview` is the overview).
- Medium tags come from `tags.csv`, which uses the same `#series-` and
  `#part-` markers.
- MDX posts give tags and series in frontmatter.

## What is imported, and duplicates

Only published posts. Drafts, scheduled posts, pages and attachments are
skipped and listed in the report.

Two items are the same post when their slugs match after lowercasing and
turning every run of other characters into one hyphen. Only one copy is
imported: the one edited most recently. Medium records no edit time, so a
Medium copy counts as edited when it was published. On an exact tie, prefer
MDX, then WordPress, then Ghost, then Medium.

## Redirects

Every old public URL of an imported post, including the losing copy of a
duplicate, answers 301 to `/post/<slug>`, with or without a trailing slash:
WordPress permalinks (`/YYYY/MM/DD/<slug>/`), Ghost `/<slug>/`, Medium
`/@anujmahajan/<slug>-<id>` and the old `/blog/<slug>` (but not image paths
under `/blog/<slug>/`).

## Errors and re-runs

A bad item or unreadable file is reported by name and everything else still
imports. A missing image or a link to an unimported post is a warning. Re-runs
update changed posts in place, keyed by slug, and never duplicate anything.

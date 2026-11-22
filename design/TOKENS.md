# design/tokens.json

Measure the mockups into `design/tokens.json` with exactly this structure. Use CSS pixels, colours as hex, and `null` where that element isn't shown at that width.

```
{
  "breakpoints": [400, 768, 993, 1200, 1400],
  "colors": {
    "light": { "bg", "surface", "ink", "muted", "rule", "accent", "ai", "backend", "frontend", "hosting" },
    "dark":  { same keys }
  },
  "text": {
    "r360" | "r600" | "r834" | "r1100" | "r1300" | "r1600": {
      "<role>": { "family", "size", "weight", "style", "lineHeight" } | null
      (leave out "lineHeight" for brand, nav and label)
    }
  },
  "layout": {
    "r360" ... "r1600": { "postColumns": [widths left to right], "postGap", "pageGutter" }
  }
}
```

Ranges are named after their mockup width (r360 = under 400px, r600 = 400–767px, and so on).

Colour keys: page background, card/code surface, main text, secondary text, divider lines, accent, and the four category colours.

Text roles:
- `brand`: the site name in the header
- `nav`: a category link in the header (not the current one)
- `label`: the small uppercase line above the home page divider ("Notes on building with AI")
- `leadTitle`, `leadExcerpt`: the lead story's headline and summary on the home page
- `railItem`: a post title in the Recent list
- `postTitle`, `dek`: the post page's headline and the summary under it
- `body`: an ordinary paragraph of post text
- `h2`: a section heading inside a post
- `quote`: the pull quote's text
- `code`: text in a code block
- `caption`: a figure's caption
- `tableCell`: an ordinary cell in a post table (at widths where the table is shown as cards, the value text on a card)
- `note`: a footnote's text, wherever the note appears at that width

Layout: `postColumns` are the widths of the post page's content columns at that range's mockup width (contents list, text, notes; only the ones shown). `postGap` is the space between them (0 when there is one column). `pageGutter` is the distance from the left edge of the window to the start of the header content (the site name) at that mockup width.

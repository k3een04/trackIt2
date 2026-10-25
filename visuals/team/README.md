# Development team photos

Drop one square headshot per member in this folder, named exactly as below.
The landing page (`index.html` / `landingpage.html`, About the Project section)
picks them up automatically.

| File | Member | Role |
| --- | --- | --- |
| `zoe.jpg` | Zoe Nicole D. Mandal | Project Manager |
| `kevin.jpg` | Kevin Nicolas N. Marciano | Lead Programmer |
| `emmanuel.jpg` | Emmanuel Kay John H. Estorco | System Analyst |
| `john.jpg` | John Michael M. Celis | UI/UX Designer |

## Guidelines

- Square crop, at least 240 x 240 px (they render as a 40 px circle, so the
  face should be centred and fill most of the frame).
- Keep each file under ~150 KB so the About section stays light.
- The markup asks for `.jpg`. A PNG renamed to `.jpg` also loads, but exporting
  a real JPEG is cleaner.

## Fallback

Each avatar keeps the member's initials behind the photo. If a file is missing
the browser drops the `<img>` and the initials stay visible, so the section
never shows a broken image. Once all four files exist, every avatar shows the
photo and no further code changes are needed.
